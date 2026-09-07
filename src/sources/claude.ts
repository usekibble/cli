import type { UsageCounts } from "./capabilities.js";
import { count, object, text } from "./codex.js";
import { TranscriptDeduper } from "./transcript-dedup.js";
import type { Rec } from "./transcripts.js";

export interface ClaudeTokenSample {
  date: string;
  model: string | null;
  session: string | null;
  usage: UsageCounts & Rec;
}

const tokenFields = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
type Snapshot = { model: string | null; usage: Required<UsageCounts> };

/** Shared Claude response accounting. Never inspect content, arguments or paths. */
export class ClaudeTokenReader {
  private readonly seen = new TranscriptDeduper();
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(private readonly options: { dedupScope?: "session" | "global"; updates?: "monotonic" } = {}) {}

  read(record: Rec, identity?: { session: string | null; response: string | null }): ClaudeTokenSample | null {
    if (record.type !== "assistant") return null;
    const message = object(record.message);
    const usage = object(message.usage) as UsageCounts & Rec;
    if (count(usage.input_tokens) + count(usage.output_tokens) + count(usage.cache_read_input_tokens)
      + count(usage.cache_creation_input_tokens) === 0) return null;
    const session = identity ? identity.session : text(record.sessionId);
    const response = identity ? identity.response : text(record.requestId) ?? text(message.id);
    const model = text(message.model);
    // An API response may be split across several content-block records. Zero
    // usage must not claim its id before the later populated record arrives.
    const scope = this.options.dedupScope === "global" ? null : session;
    if (this.options.updates === "monotonic" && response) {
      const key = JSON.stringify([scope, response]);
      const current: Snapshot = { model, usage: {
        input_tokens: count(usage.input_tokens), output_tokens: count(usage.output_tokens),
        cache_read_input_tokens: count(usage.cache_read_input_tokens),
        cache_creation_input_tokens: count(usage.cache_creation_input_tokens),
      } };
      const previous = this.snapshots.get(key);
      if (previous) {
        if (model !== previous.model) throw new Error("Conflicting Claude response accounting.");
        // A copied transcript can replay an older prefix after a newer snapshot.
        if (tokenFields.every((field) => current.usage[field] <= previous.usage[field])) return null;
        if (!tokenFields.every((field) => current.usage[field] >= previous.usage[field])) {
          throw new Error("Conflicting Claude response accounting.");
        }
        this.snapshots.set(key, current);
        const delta = Object.fromEntries(tokenFields.map((field) => [field, current.usage[field] - previous.usage[field]]));
        return { date: String(record.timestamp ?? "").slice(0, 10), model, session, usage: delta };
      }
      this.snapshots.set(key, current);
    }
    if (!this.seen.first("response", scope, response)) return null;
    return { date: String(record.timestamp ?? "").slice(0, 10), model, session, usage };
  }
}
