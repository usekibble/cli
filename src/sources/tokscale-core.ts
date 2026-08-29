import {
  lookupPricing,
  parseLocalSources,
  version as nativeVersion,
  type ParsedMessage,
} from "@tokscale/core";
import {
  normalizeAgent,
  toMicros,
  type CollectOptions,
  type CollectResult,
  type NormalizedDailyUsage,
  type SessionRef,
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
 * The trade-off is client coverage: the library handles 9 local clients where
 * the CLI handles 50+. `TokscaleCliSource` remains available for teams whose
 * agents fall outside that set.
 */

interface Pricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadInputTokenCost?: number;
  cacheCreationInputTokenCost?: number;
}

const ZERO: Pricing = { inputCostPerToken: 0, outputCostPerToken: 0 };

/**
 * Price one message.
 *
 * Reasoning tokens are deliberately not billed separately: both Anthropic and
 * OpenAI already count them inside output tokens, so adding them again would
 * inflate every reasoning-heavy model.
 */
function costOf(m: ParsedMessage, p: Pricing): number {
  return (
    m.input * p.inputCostPerToken +
    m.output * p.outputCostPerToken +
    m.cacheRead * (p.cacheReadInputTokenCost ?? 0) +
    m.cacheWrite * (p.cacheCreationInputTokenCost ?? 0)
  );
}

export class TokscaleCoreSource implements UsageSource {
  readonly name = "tokscale-core";
  readonly coverage =
    "9 local clients (claude, codex, opencode, gemini, amp, droid, openclaw, pi, kimi), with session ids";

  /** Pricing lookups hit the network once per model, so memoize per run. */
  private readonly pricing = new Map<string, Promise<Pricing>>();

  async version(): Promise<string> {
    return `@tokscale/core native ${nativeVersion()}`;
  }

  private priceFor(modelId: string, providerId: string): Promise<Pricing> {
    const key = `${providerId}/${modelId}`;
    let cached = this.pricing.get(key);
    if (!cached) {
      cached = lookupPricing(modelId, providerId)
        .then((r) => r.pricing as Pricing)
        // Placeholder models such as the synthetic entry have no price. Their
        // tokens still count; treating the lookup failure as free is correct,
        // and throwing here would fail a whole push over a rounding-error row.
        .catch(() => ZERO);
      this.pricing.set(key, cached);
    }
    return cached;
  }

  async collect({ since, until }: CollectOptions): Promise<CollectResult> {
    const parsed = parseLocalSources({ since, until });

    const days = new Map<string, NormalizedDailyUsage>();
    const sessions = new Map<string, SessionRef>();

    for (const m of parsed.messages) {
      // The parser is inclusive at the edges, but guard anyway: a boundary
      // message must not land in a day the server did not ask for.
      if (m.date < since || m.date > until) continue;

      const pricing = await this.priceFor(m.modelId, m.providerId);
      const costMicros = toMicros(costOf(m, pricing));
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
      daily: [...days.values()].sort(
        (a, b) => a.date.localeCompare(b.date) || b.costMicros - a.costMicros,
      ),
      sessions: [...sessions.values()],
    };
  }
}
