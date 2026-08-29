import { lookupPricing } from "@tokscale/core";
import type { UsageCounts } from "./capabilities.js";

interface Rates {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadInputTokenCost?: number;
  cacheCreationInputTokenCost?: number;
}

const ZERO: Rates = { inputCostPerToken: 0, outputCostPerToken: 0 };

/**
 * A pricing function for capability attribution, using the same rates Lane A
 * uses so a skill's cost and the day's total are denominated identically.
 *
 * Rates for every model are resolved up front rather than lazily: a lazy cache
 * would price the first record of each model at zero and quietly under-report,
 * which is worse than being slow.
 */
export async function priceRecord(
  models: Iterable<string>,
): Promise<(model: string, usage: UsageCounts) => number> {
  const cache = new Map<string, Rates>();

  await Promise.all(
    [...new Set(models)].filter(Boolean).map(async (model) => {
      try {
        const r = await lookupPricing(model, "anthropic");
        cache.set(model, r.pricing as Rates);
      } catch {
        // Placeholder or unpriced models cost nothing rather than failing a push.
        cache.set(model, ZERO);
      }
    }),
  );

  return (model, u) => {
    const p = cache.get(model);
    if (!p) return 0;
    const cost =
      (u.input_tokens ?? 0) * p.inputCostPerToken +
      (u.output_tokens ?? 0) * p.outputCostPerToken +
      (u.cache_read_input_tokens ?? 0) * (p.cacheReadInputTokenCost ?? 0) +
      (u.cache_creation_input_tokens ?? 0) * (p.cacheCreationInputTokenCost ?? 0);
    return Math.round(cost * 1_000_000);
  };
}
