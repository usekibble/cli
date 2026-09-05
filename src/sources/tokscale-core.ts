import {
  parseLocalSources,
  version as nativeVersion,
} from "@tokscale/core";
import { PricingContext } from "./pricing.js";
import { CodexSource } from "./codex-source.js";
import {
  normalizeAgent,
  type CollectOptions,
  type CollectResult,
  type NormalizedDailyUsage,
  type SessionRef,
  type SourceContext,
  type UsageSource,
} from "./types.js";

/**
 * Lane A via the tokscale Rust core, in-process through its napi bindings.
 *
 * Preferred over spawning the CLI: no subprocess, no stdout JSON to parse, and
 * the reason that matters most, every message carries its `sessionId`. The CLI's
 * graph export aggregates sessions away, which cost us the Lane A/B dedup ledger
 * and session-size percentiles. This source gets both back.
 *
 * Codex bypasses the pinned native parser: it repeats cumulative snapshots.
 * CodexSource uses the same token decoder as repository and model activity.
 *
 * The trade-off is client coverage: the library handles 9 local clients where
 * the CLI handles 50+. `TokscaleCliSource` remains available for teams whose
 * agents fall outside that set.
 */

export class TokscaleCoreSource implements UsageSource {
  readonly name = "tokscale-core+codex";
  readonly coverage =
    "8 native clients plus Codex through Kibble's shared token decoder, with session ids";

  private readonly pricing: PricingContext;
  private readonly codex: CodexSource;

  constructor(private readonly context: SourceContext = {}) {
    this.pricing = context.pricing ?? new PricingContext();
    this.codex = new CodexSource({ ...context, pricing: this.pricing });
  }

  async version(): Promise<string> {
    return `@tokscale/core native ${nativeVersion()}; ${await this.codex.version()}`;
  }

  async collect({ since, until }: CollectOptions): Promise<CollectResult> {
    const parsed = parseLocalSources({ since, until, homeDir: this.context.home,
      sources: ["claude", "opencode", "gemini", "amp", "droid", "openclaw", "pi", "kimi"],
    });
    const codex = await this.codex.collect({ since, until });

    await this.pricing.prefetch(
      parsed.messages
        .filter((message) => message.date >= since && message.date <= until)
        .map((message) => ({ model: message.modelId, provider: message.providerId })),
    );

    const days = new Map<string, NormalizedDailyUsage>();
    const sessions = new Map<string, SessionRef>();

    for (const m of parsed.messages) {
      // The parser is inclusive at the edges, but guard anyway: a boundary
      // message must not land in a day the server did not ask for.
      if (m.date < since || m.date > until) continue;
      if (m.source === "codex") continue;
      // Synthetic/error records with no usage are not billable responses.
      if (m.input + m.output + m.cacheRead + m.cacheWrite === 0) continue;

      // Reasoning tokens are already within output and are not billed again.
      const costMicros = this.pricing.costMicros(
        { model: m.modelId, provider: m.providerId },
        { input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite },
      );
      const agent = normalizeAgent(m.source);

      const dayKey = `${m.date} ${agent} ${m.modelId}`;
      const day = days.get(dayKey);
      if (day) {
        day.tokensIn += m.input;
        day.tokensOut += m.output;
        day.tokensCacheRead += m.cacheRead;
        day.tokensCacheWrite += m.cacheWrite;
        day.tokensReasoning += m.reasoning;
        day.messageCount += 1;
        day.costMicros += costMicros;
      } else {
        days.set(dayKey, {
          date: m.date,
          agent,
          model: m.modelId,
          provider: m.providerId || null,
          tokensIn: m.input,
          tokensOut: m.output,
          tokensCacheRead: m.cacheRead,
          tokensCacheWrite: m.cacheWrite,
          tokensReasoning: m.reasoning,
          messageCount: 1,
          costMicros,
        });
      }

      if (m.sessionId) {
        const session = sessions.get(m.sessionId);
        if (session) {
          session.messageCount += 1;
          session.costMicros += costMicros;
          // A session can straddle midnight; attribute it to the day it began.
          if (m.date < session.date) session.date = m.date;
        } else {
          sessions.set(m.sessionId, {
            sessionId: m.sessionId,
            agent,
            date: m.date,
            messageCount: 1,
            costMicros,
          });
        }
      }
    }

    return {
      daily: [...days.values(), ...codex.daily].sort(
        (a, b) => a.date.localeCompare(b.date) || b.costMicros - a.costMicros,
      ),
      sessions: [...sessions.values(), ...codex.sessions],
    };
  }
}
