import type { UsageCounts } from "./capabilities.js";
import { TranscriptDeduper } from "./transcript-dedup.js";
import type { TranscriptVisitor } from "./transcripts.js";
import { codexItem, codexSettings, codexTool, CodexTokenReader, count, object, text } from "./codex.js";

/** Counts only, at (day, agent, model). Session and tool ids stay on the machine. */
export interface ModelActivity {
  date: string;
  agent: "claude-code" | "codex";
  model: string;
  costMicros: number;
  tokens: number;
  sessions: number;
  toolCalls: number;
  compactions: number;
  messageCount: number;
  unpricedMessages: number;
}

type Acc = ModelActivity & { sessionIds: Set<string> };

/** A visitor over the shared walk, never a separate read of the transcripts. */
export class ModelActivityCollector {
  private rows = new Map<string, Acc>();
  private seen = new TranscriptDeduper();
  constructor(private options: {
    since: string;
    until: string;
    priceOf?: (model: string, usage: UsageCounts, provider?: string) => number;
  }) {}

  private at(date: string, agent: ModelActivity["agent"], model: string | null): Acc | null {
    if (date.length !== 10 || date < this.options.since || date > this.options.until || !model || model.length > 128 || model === "<synthetic>") return null;
    const key = JSON.stringify([date, agent, model]);
    let row = this.rows.get(key);
    if (!row) {
      row = { date, agent, model, costMicros: 0, tokens: 0, sessions: 0, toolCalls: 0, compactions: 0, messageCount: 0, unpricedMessages: 0, sessionIds: new Set() };
      this.rows.set(key, row);
    }
    return row;
  }

  private usage(row: Acc, usage: UsageCounts, session: string | null, provider?: string) {
    const tokens = count(usage.input_tokens) + count(usage.output_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
    if (tokens === 0) return;
    const cost = row.model === "unknown" ? 0 : this.options.priceOf?.(row.model, usage, provider) ?? 0;
    row.tokens += tokens;
    row.costMicros += cost;
    row.messageCount += 1;
    if (cost === 0) row.unpricedMessages += 1;
    if (session) row.sessionIds.add(session);
  }

  private tool(row: Acc, id: string | null, session: string | null, dedupScope = session) {
    if (!this.seen.first(`${row.agent}:tool`, dedupScope, id)) return;
    row.toolCalls += 1;
    if (session) row.sessionIds.add(session);
  }

  claude(): TranscriptVisitor {
    // Session ids separate interleaved subagent records; file reset prevents
    // assigning a marker to a model from a different transcript.
    const models = new Map<string, string>();
    return { startFile: () => models.clear(), record: (record) => {
      const session = text(record.sessionId);
      if (record.type === "system" && record.subtype === "compact_boundary") {
        const row = this.at(String(record.timestamp ?? "").slice(0, 10), "claude-code", models.get(session ?? "") ?? null);
        if (row && this.seen.first("claude-code:compaction", session, text(record.uuid))) {
          row.compactions += 1;
          if (session) row.sessionIds.add(session);
        }
        return;
      }
      if (record.type !== "assistant") return;
      const message = object(record.message);
      const model = text(message.model);
      if (model && model !== "<synthetic>") models.set(session ?? "", model);
      const row = this.at(String(record.timestamp ?? "").slice(0, 10), "claude-code", text(message.model));
      if (!row) return;
      // Blocks can repeat in resumed/forked transcripts. Read their types and
      // opaque ids only; never their text, arguments or outputs.
      const blocks = Array.isArray(message.content) ? message.content : [];
      blocks.forEach((block, index) => {
        const b = object(block);
        if (b.type === "tool_use") this.tool(row, text(b.id) ?? (text(record.uuid) ? `${record.uuid}:${index}` : null), session);
      });
      const usage = message.usage as UsageCounts | undefined;
      if (!usage) return;
      if (count(usage.input_tokens) + count(usage.output_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens) === 0) return;
      const response = text(record.requestId) ?? text(message.id);
      if (!this.seen.first("claude-code:response", session, response)) return;
      this.usage(row, usage, session);
    } };
  }

  codex(): TranscriptVisitor {
    let model: string | null = null;
    let session: string | null = null;
    let fileNumber = 0;
    const tokens = new CodexTokenReader();
    return {
      startFile: (file) => { fileNumber += 1; tokens.startFile(file); model = null; session = null; },
      record: (record) => {
        const sample = tokens.read(record);
        const payload = object(record.payload);
        if (record.type === "session_meta") { session = text(payload.id); return; }
        const settings = codexSettings(record);
        if (settings) { model = text(settings.model) ?? model; return; }
        const dedupScope = session ?? `anonymous-file:${fileNumber}`;
        if (sample) {
          model = sample.model;
          const row = this.at(sample.date, "codex", model);
          if (row) this.usage(row, sample.usage, session, sample.provider);
        } else {
          const item = codexItem(record);
          if (!item || (!codexTool(item) && item.type !== "ContextCompaction")) return;
          const row = this.at(String(record.timestamp ?? "").slice(0, 10), "codex", model);
          if (row && item.type === "ContextCompaction") {
            // Count the completed item only. Codex also writes a `compacted`
            // history record for the same event; it must not add a second count.
            if (this.seen.first("codex:compaction", dedupScope, text(item.id))) {
              row.compactions += 1;
              if (session) row.sessionIds.add(session);
            }
          } else if (row) this.tool(row, text(item.id), session, dedupScope);
        }
      },
    };
  }

  finish(): ModelActivity[] {
    return [...this.rows.values()].filter((r) => r.tokens > 0 || r.toolCalls > 0 || r.compactions > 0).map(({ sessionIds, ...row }) => ({ ...row, sessions: sessionIds.size }));
  }
}
