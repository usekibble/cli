import { lookupPricing } from "@tokscale/core";
import type { UsageCounts } from "./capabilities.js";

interface Rates {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadInputTokenCost?: number;
  cacheCreationInputTokenCost?: number;
}

const ZERO: Rates = { inputCostPerToken: 0, outputCostPerToken: 0 };

export interface PricingRef {
  model: string;
  provider?: string | null;
}

export interface PricedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function ref(value: string | PricingRef): Required<PricingRef> {
  return typeof value === "string"
    ? { model: value, provider: "" }
    : { model: value.model, provider: value.provider ?? "" };
}

function keyOf(value: string | PricingRef): string {
  const { model, provider } = ref(value);
  return JSON.stringify([provider, model]);
}

/** Apply native per-token rates and round once at the integer-money boundary. */
export function pricedCostMicros(usage: PricedUsage, rates: Rates): number {
  const dollars =
    usage.input * rates.inputCostPerToken +
    usage.output * rates.outputCostPerToken +
    usage.cacheRead * (rates.cacheReadInputTokenCost ?? 0) +
    usage.cacheWrite * (rates.cacheCreationInputTokenCost ?? rates.inputCostPerToken);
  return Number.isFinite(dollars) ? Math.round(dollars * 1_000_000) : 0;
}

/**
 * Pricing resolved for one collection run.
 *
 * Provider is part of the key. An omitted, null or empty provider is the one
 * providerless semantic key and calls the native lookup without a provider.
 * Failed or placeholder lookups retain the existing zero-price behavior.
 */
export class PricingContext {
  private readonly rates = new Map<string, Rates>();
  private readonly pending = new Map<string, Promise<void>>();

  async prefetch(values: Iterable<string | PricingRef>): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const value of values) {
      const normalized = ref(value);
      if (!normalized.model) continue;
      const key = keyOf(normalized);
      if (this.rates.has(key)) continue;
      let pending = this.pending.get(key);
      if (!pending) {
        pending = (normalized.provider
          ? lookupPricing(normalized.model, normalized.provider)
          : lookupPricing(normalized.model)
        )
          .then((result) => {
            this.rates.set(key, result.pricing as Rates);
          })
          .catch(() => {
            this.rates.set(key, ZERO);
          })
          .finally(() => {
            this.pending.delete(key);
          });
        this.pending.set(key, pending);
      }
      waits.push(pending);
    }
    await Promise.all(waits);
  }

  costMicros(value: string | PricingRef, usage: PricedUsage): number {
    return pricedCostMicros(usage, this.rates.get(keyOf(value)) ?? ZERO);
  }
}

/** A snake-case adapter for transcript sidecars, backed by the run's context. */
export async function priceRecord(
  models: Iterable<string>,
  context = new PricingContext(),
): Promise<(model: string, usage: UsageCounts, provider?: string) => number> {
  await context.prefetch(models);
  return (model, usage, provider) => context.costMicros({ model, provider }, {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  });
}
