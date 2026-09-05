import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CodexTokenReader, object, text, type CodexTokenSample } from "./codex.js";
import { codexHome } from "./codex-inventory.js";
import { PricingContext } from "./pricing.js";
import { listJsonl, partitionByFloor, readTranscripts, transcriptFloor } from "./transcripts.js";
import type { CollectOptions, CollectResult, NormalizedDailyUsage, SessionRef, SourceContext, UsageSource } from "./types.js";

/** The pinned native parser repeats Codex snapshots and drops reasoning. */
export class CodexSource implements UsageSource {
  readonly name = "codex-local";
  readonly coverage = "Codex local and archived sessions, counts only";
  private readonly pricing: PricingContext;
  constructor(private readonly context: SourceContext = {}) {
    this.pricing = context.pricing ?? new PricingContext();
  }
  async version(): Promise<string> { return "Kibble Codex parser 1"; }

  async collect({ since, until }: CollectOptions): Promise<CollectResult> {
    const base = codexHome(this.context.home ?? homedir());
    const files = partitionByFloor([
      ...listJsonl(join(base, "sessions")),
      ...listJsonl(join(base, "archived_sessions")),
    ], transcriptFloor(since)).recent;
    const reader = new CodexTokenReader();
    const samples: CodexTokenSample[] = [];
    const sessionKeys = new Map<string, string>();
    let fallbackSession = "";
    let nativeSessionName: string | null = null;
    readTranscripts(files, [{
      startFile(file) {
        reader.startFile(file);
        // Preserve the native adapter's session ledger key for existing logs.
        // Anonymous nonstandard filenames become opaque digests, never paths.
        const name = basename(file!.path, ".jsonl");
        nativeSessionName = /^rollout-[\dT-]+-[\da-f-]{36}$/i.test(name) ? name : null;
        fallbackSession = nativeSessionName ?? createHash("sha256").update(file!.path).digest("hex");
      },
      record(record) {
        if (record.type === "session_meta") {
          const id = text(object(record.payload).id);
          if (id && nativeSessionName?.endsWith(id)) sessionKeys.set(id, nativeSessionName);
        }
        const sample = reader.read(record);
        if (sample && sample.date >= since && sample.date <= until) {
          samples.push({ ...sample, session: sample.session ?? fallbackSession });
        }
      },
    }]);
    await this.pricing.prefetch(samples.map(({ model, provider }) => ({ model, provider })));
    const days = new Map<string, NormalizedDailyUsage>();
    const sessions = new Map<string, SessionRef>();
    for (const sample of samples) {
      const { date, model, provider, usage } = sample;
      const costMicros = model === "unknown" ? 0 : this.pricing.costMicros({ model, provider }, {
        input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0,
      });
      const key = JSON.stringify([date, model]);
      let row = days.get(key);
      if (!row) {
        row = { date, agent: "codex", model, provider, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensReasoning: 0, messageCount: 0, costMicros: 0 };
        days.set(key, row);
      }
      row.tokensIn += usage.input_tokens ?? 0;
      row.tokensOut += usage.output_tokens ?? 0;
      row.tokensCacheRead += usage.cache_read_input_tokens ?? 0;
      row.tokensCacheWrite += usage.cache_creation_input_tokens ?? 0;
      row.tokensReasoning += sample.reasoning;
      row.messageCount += 1;
      row.costMicros += costMicros;
      const sessionId = sessionKeys.get(sample.session!) ?? sample.session!;
      let session = sessions.get(sessionId);
      if (!session) {
        session = { sessionId, agent: "codex", date, messageCount: 0, costMicros: 0 };
        sessions.set(sessionId, session);
      }
      session.date = session.date < date ? session.date : date;
      session.messageCount += 1;
      session.costMicros += costMicros;
    }
    return { daily: [...days.values()], sessions: [...sessions.values()] };
  }
}
