import type { UsageCounts } from "./capabilities.js";
import type { Rec, TranscriptFile } from "./transcripts.js";
import { tokenSnapshotId, TranscriptDeduper } from "./transcript-dedup.js";

/** Shared Codex field decoding. Never inspect arguments, output or message text. */
export const object = (v: unknown): Rec => v && typeof v === "object" && !Array.isArray(v) ? v as Rec : {};
export const text = (v: unknown): string | null => typeof v === "string" && v.length > 0 ? v : null;
export const count = (v: unknown): number => typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

export function codexSettings(record: Rec): Rec | null {
  if (record.type === "turn_context") return object(record.payload);
  const p = object(record.payload);
  if (record.type === "event_msg" && p.type === "thread_settings_applied") return object(p.thread_settings);
  return null;
}

export function codexUsage(last: Rec): UsageCounts {
  const input = count(last.input_tokens ?? last.prompt_tokens ?? last.input);
  const cached = Math.min(input, count(last.cached_input_tokens ?? last.cache_read_input_tokens ?? object(last.input_tokens_details).cached_tokens));
  const written = Math.min(input - cached, count(last.cache_write_input_tokens ?? object(last.input_tokens_details).cache_write_tokens));
  return {
    input_tokens: input - cached - written,
    output_tokens: count(last.output_tokens ?? last.completion_tokens ?? last.output),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
  };
}

export interface CodexTokenSample {
  date: string;
  model: string;
  provider: string;
  session: string | null;
  usage: UsageCounts;
  reasoning: number;
}

/** One token interpretation for daily usage, repository and model cuts. */
export class CodexTokenReader {
  private readonly seen = new TranscriptDeduper();
  private fileNumber = 0;
  private session: string | null = null;
  private model: string | null = null;
  private provider = "openai";
  private previous: Rec | null = null;
  private fileDate = "";

  startFile(file?: TranscriptFile): void {
    this.fileDate = file ? new Date(file.mtimeMs).toISOString().slice(0, 10) : "";
    this.fileNumber += 1;
    this.session = null;
    this.model = null;
    this.provider = "openai";
    this.previous = null;
  }

  read(record: Rec): CodexTokenSample | null {
    const p = object(record.payload);
    if (record.type === "session_meta") {
      this.session = text(p.id);
      this.provider = text(p.model_provider) ?? "openai";
      return null;
    }
    const settings = codexSettings(record);
    if (settings) {
      this.model = text(settings.model) ?? this.model;
      this.provider = text(settings.model_provider_id) ?? this.provider;
      return null;
    }
    const scope = this.session ?? `anonymous-file:${this.fileNumber}`;
    let last: Rec;
    let fallbackDate = "";
    if (record.type === "event_msg" && p.type === "token_count") {
      const info = object(p.info);
      this.model = text(p.model) ?? text(p.model_name) ?? text(info.model) ?? text(info.model_name) ?? this.model;
      const total = object(info.total_token_usage);
      const previous = this.previous;
      if (Object.keys(total).length) this.previous = total;
      if (!this.seen.first("snapshot", scope, tokenSnapshotId(total))) return null;
      last = object(info.last_token_usage);
      // Older logs can omit last_token_usage. Only a monotonic, observed pair
      // establishes a delta; a first cumulative total may predate this log.
      if (!Object.keys(last).length && previous) {
        const fields = ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"];
        if (fields.some((key) => count(total[key]) < count(previous[key]))) return null;
        last = Object.fromEntries(fields.map((key) => [key, count(total[key]) - count(previous[key])]));
      }
    } else if (["turn.completed", "result", "response.completed"].includes(String(record.type))) {
      // Headless JSON output has explicit usage, never recover it from tool
      // output strings. Ordinary rollout token_usage_record mirrors token_count.
      fallbackDate = this.fileDate;
      const data = object(record.data), response = object(record.response), result = object(record.result);
      last = object(record.usage ?? data.usage ?? response.usage ?? result.usage);
      this.model = text(record.model) ?? text(record.model_name) ?? text(data.model) ?? text(data.model_name) ?? text(response.model) ?? this.model;
      if (!this.seen.first("headless", scope, text(record.response_id) ?? text(record.id))) return null;
    } else return null;
    const usage = codexUsage(last);
    if (!(count(usage.input_tokens) + count(usage.output_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens))) return null;
    return {
      date: String(record.timestamp ?? fallbackDate).slice(0, 10),
      model: this.model ?? "unknown",
      provider: this.provider,
      session: this.session,
      usage,
      reasoning: Math.min(count(last.reasoning_output_tokens ?? object(last.output_tokens_details).reasoning_tokens), count(usage.output_tokens)),
    };
  }
}

/** Completed classified items and their legacy event equivalents share ids. */
export function codexItem(record: Rec): Rec | null {
  if (record.type !== "event_msg") return null;
  const p = object(record.payload);
  if (p.type === "item_completed") return object(p.item);
  if (p.type === "exec_command_end") return { type: "CommandExecution", id: p.call_id, status: p.status, exit_code: p.exit_code, duration: p.duration };
  if (p.type === "mcp_tool_call_end") {
    const result = object(p.result);
    return { type: "McpToolCall", id: p.call_id, server: object(p.invocation).server, duration: p.duration,
      status: Object.hasOwn(result, "Err") || object(result.Ok).isError === true ? "failed" : "completed" };
  }
  if (p.type === "patch_apply_end") return { type: "FileChange", id: p.call_id, status: p.status ?? (p.success === false ? "failed" : "completed"), changes: p.changes };
  if (p.type === "dynamic_tool_call_response") return { type: "DynamicToolCall", id: p.call_id, tool: p.tool, namespace: p.namespace, status: p.success === false ? "failed" : "completed", duration: p.duration };
  return null;
}

/** Same tool-call denominator in repo and model cuts, including non-shell tools. */
export function codexTool(item: Rec): string | null {
  switch (item.type) {
    case "McpToolCall": return `mcp__${text(item.server) ?? "unknown"}`;
    case "Extension": return text(item.kind) ? `extension:${item.kind}` : "Extension";
    case "DynamicToolCall": return text(item.tool) ?? "DynamicToolCall";
    case "CommandExecution": case "FileChange": case "ImageView":
    case "ImageGeneration": case "WebSearch": case "CollabAgentToolCall":
      return String(item.type);
    default: return null;
  }
}

export function codexDuration(item: Rec): number | null {
  if (typeof item.durationMs === "number" && Number.isFinite(item.durationMs) && item.durationMs >= 0) return Math.round(item.durationMs);
  const duration = object(item.duration);
  if (typeof duration.secs !== "number" || !Number.isFinite(duration.secs) || duration.secs < 0) return null;
  return Math.round(duration.secs * 1000 + count(duration.nanos) / 1e6);
}
