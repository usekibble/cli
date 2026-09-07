import { codexUsage, object } from "./codex.js";
import { ciSessionKey } from "../ci-identity.js";

export type CiAgent = "codex" | "claude-code";
export interface CiTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | null;
}
export interface CiModelUsage extends CiTokens {
  model: string;
  costMicros: number | null;
}
export type CiIssue = "invalid_json" | "oversized_record" | "invalid_usage" |
  "missing_final_usage" | "main_agent_usage_only" | "unsupported_model_name" |
  "counter_limit" | "stream_error";
export interface CiSnapshot {
  sessionKey?: string;
  usageStatus: "complete" | "partial" | "unavailable";
  tokens: CiTokens | null;
  models: CiModelUsage[];
  costMicros: number | null;
  costBasis: "agent_estimate" | "unavailable";
  agentResult: "succeeded" | "failed" | null;
  activity: { toolCalls: number; toolErrors: number };
  issues: CiIssue[];
}

type RecordValue = Record<string, unknown>;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const modelName = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const micros = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const result = Math.round(value * 1_000_000);
  return integer(result) ? result : null;
};
const buckets = ["input", "output", "cacheRead", "cacheWrite"] as const;

function claudeTokens(record: RecordValue, camelCase: boolean): CiTokens | null {
  const fields = camelCase
    ? ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]
    : ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  const values = fields.map((key) => record[key]);
  if (!values.every(integer)) return null;
  return { input: values[0]!, output: values[1]!, cacheRead: values[2]!, cacheWrite: values[3]!, reasoning: null };
}

/** Live, counts-only adapter. Raw JSON is discarded after each visit. */
export class CiStreamCollector {
  private sessionKey: string | undefined;
  private tokens: CiTokens | null = null;
  private models: CiModelUsage[] = [];
  private cost: number | null = null;
  private finalUsage = false;
  private result: CiSnapshot["agentResult"] = null;
  private readonly issues = new Set<CiIssue>();
  private readonly tools = new Set<string>();
  private readonly errors = new Set<string>();

  constructor(readonly agent: CiAgent) {}

  issue(value: CiIssue): void { this.issues.add(value); }

  private tool(id: unknown, failed = false): void {
    if (typeof id !== "string" || !id.length || id.length > 256) return;
    const set = failed ? this.errors : this.tools;
    if (set.size >= 100_000) { this.issue("counter_limit"); return; }
    set.add(id);
  }

  read(value: unknown): void {
    const record = object(value);
    const session = this.agent === "codex" && record.type === "thread.started" ? record.thread_id
      : this.agent === "claude-code" && (record.type === "result" || (record.type === "system" && record.subtype === "init")) ? record.session_id : undefined;
    if (typeof session === "string" && session.length > 0 && session.length <= 256) {
      const key = ciSessionKey(this.agent, session);
      if (this.sessionKey && key !== this.sessionKey) this.issue("stream_error");
      else this.sessionKey = key;
    }
    if (this.agent === "codex") this.codex(record);
    else this.claude(record);
  }

  private replace(tokens: CiTokens, models: CiModelUsage[], cost: number | null): void {
    // Error receipts can contain zeroed accounting fields after a crash.
    if (this.result === "failed" && buckets.every((key) => tokens[key] === 0)) {
      this.issue("invalid_usage"); this.finalUsage = false; return;
    }
    // Both CLIs can emit cumulative totals. A replay replaces; it never adds.
    if ((this.tokens && buckets.some((key) => tokens[key] < this.tokens![key])) ||
      (this.cost !== null && (cost === null || cost < this.cost))) {
      this.issue("invalid_usage");
      this.finalUsage = false;
      return;
    }
    this.tokens = tokens;
    this.models = models;
    this.cost = cost;
    this.finalUsage = true;
  }

  private codex(record: RecordValue): void {
    if (record.type === "turn.started") { this.finalUsage = false; this.result = null; }
    if (record.type === "turn.failed") { this.finalUsage = false; this.result = "failed"; }
    if (record.type === "item.started" || record.type === "item.completed") {
      const item = object(record.item);
      if (["command_execution", "mcp_tool_call", "file_change", "web_search"].includes(String(item.type))) {
        this.tool(item.id);
        if (record.type === "item.completed" && (item.status === "failed" ||
          (typeof item.exit_code === "number" && item.exit_code !== 0) || object(item.result).is_error === true)) {
          this.tool(item.id, true);
        }
      }
    }
    if (record.type !== "turn.completed") return;
    this.result = "succeeded";
    const usage = object(record.usage);
    if (![usage.input_tokens, usage.output_tokens, usage.cached_input_tokens].every(integer) ||
      (usage.cache_write_input_tokens !== undefined && !integer(usage.cache_write_input_tokens)) ||
      (usage.reasoning_output_tokens !== undefined && !integer(usage.reasoning_output_tokens)) ||
      Number(usage.cached_input_tokens) > Number(usage.input_tokens) ||
      Number(usage.cache_write_input_tokens ?? 0) > Number(usage.input_tokens) - Number(usage.cached_input_tokens) ||
      Number(usage.reasoning_output_tokens ?? 0) > Number(usage.output_tokens)) {
      this.issue("invalid_usage"); this.finalUsage = false; return;
    }
    const decoded = codexUsage(usage);
    this.replace({
      input: decoded.input_tokens!, output: decoded.output_tokens!,
      cacheRead: decoded.cache_read_input_tokens!, cacheWrite: decoded.cache_creation_input_tokens!,
      reasoning: usage.reasoning_output_tokens === undefined ? null : Number(usage.reasoning_output_tokens),
    }, [], null);
  }

  private claude(record: RecordValue): void {
    // Assistant token counters can be repeated and preliminary. Only result
    // modelUsage is the cumulative accounting receipt, including subagents.
    if (record.type === "assistant" || record.type === "user") {
      const content = object(record.message).content;
      if (Array.isArray(content)) for (const entry of content) {
        const block = object(entry);
        if (block.type === "tool_use") this.tool(block.id);
        if (block.type === "tool_result" && block.is_error === true) this.tool(block.tool_use_id, true);
      }
    }
    if (record.type !== "result") return;
    if (record.subtype === "success" && record.is_error === false) this.result = "succeeded";
    else if (record.is_error === true) this.result = "failed";
    else { this.issue("invalid_usage"); this.finalUsage = false; return; }
    const entries = Object.entries(object(record.modelUsage));
    if (entries.length > 128) { this.issue("counter_limit"); this.finalUsage = false; return; }
    if (!entries.length) {
      const tokens = claudeTokens(object(record.usage), false);
      if (tokens) {
        this.replace(tokens, [], micros(record.total_cost_usd));
        this.issue("main_agent_usage_only");
      } else { this.issue("invalid_usage"); this.finalUsage = false; }
      return;
    }
    const models: CiModelUsage[] = [];
    const totals: CiTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null };
    for (const [model, raw] of entries) {
      const usage = object(raw);
      const tokens = claudeTokens(usage, true);
      if (!tokens) { this.issue("invalid_usage"); this.finalUsage = false; return; }
      for (const key of buckets) totals[key] += tokens[key];
      if (modelName(model)) models.push({ model, ...tokens, costMicros: micros(usage.costUSD) });
      else this.issue("unsupported_model_name");
    }
    if (!buckets.every((key) => integer(totals[key]))) {
      this.issue("invalid_usage"); this.finalUsage = false; return;
    }
    this.replace(totals, models.sort((a, b) => a.model.localeCompare(b.model)), micros(record.total_cost_usd));
  }

  snapshot(): CiSnapshot {
    const issues = new Set(this.issues);
    if (!this.finalUsage) issues.add("missing_final_usage");
    return {
      ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}),
      usageStatus: !this.tokens ? "unavailable" : this.finalUsage && !issues.size ? "complete" : "partial",
      tokens: this.tokens ? { ...this.tokens } : null,
      models: this.models.map((value) => ({ ...value })),
      costMicros: this.cost,
      costBasis: this.cost === null ? "unavailable" : "agent_estimate",
      agentResult: this.result,
      activity: { toolCalls: this.tools.size, toolErrors: this.errors.size },
      issues: [...issues].sort(),
    };
  }
}

/** Bounded JSONL framing, including huge tool output and a final line without LF. */
export class CiJsonLines {
  private parts: Buffer[] = [];
  private size = 0;
  private dropping = false;
  constructor(private readonly collector: CiStreamCollector, private readonly limit = 8 * 1024 * 1024) {}

  write(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      const piece = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (!this.dropping) {
        this.size += piece.length;
        if (this.size > this.limit) {
          this.collector.issue("oversized_record"); this.parts = []; this.dropping = true;
        } else this.parts.push(Buffer.from(piece));
      }
      if (end < 0) break;
      this.line();
      start = end + 1;
    }
  }

  private line(): void {
    if (!this.dropping && this.size) {
      const value = Buffer.concat(this.parts).toString("utf8");
      if (value.trim()) {
        try { this.collector.read(JSON.parse(value)); }
        catch { this.collector.issue("invalid_json"); }
      }
    }
    this.parts = []; this.size = 0; this.dropping = false;
  }
  end(): void { this.line(); }
}
