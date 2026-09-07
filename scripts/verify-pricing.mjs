import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

const dist = new URL("../dist/", import.meta.url).href;
const nativeUrl = "fixture:tokscale-core-pricing";
const cliUrl = `${dist}sources/tokscale-cli.js`;
const loader = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@tokscale/core") return { url: ${JSON.stringify(nativeUrl)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
  export async function load(url, context, nextLoad) {
    if (url === ${JSON.stringify(nativeUrl)}) return {
      format: "module",
      source: "export const parseLocalSources = (...args) => globalThis.__kibblePricingFixture.parseLocalSources(...args); export const lookupPricing = (...args) => globalThis.__kibblePricingFixture.lookupPricing(...args); export const version = () => 'fixture';",
      shortCircuit: true,
    };
    if (url === ${JSON.stringify(cliUrl)}) return {
      format: "module",
      source: "export class TokscaleCliSource { name = 'fixture-cli'; coverage = 'fixture'; async version() { return 'fixture'; } async collect() { return globalThis.__kibblePricingFixture.fallback; } }",
      shortCircuit: true,
    };
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 };
const rates = (multiple) => ({
  inputCostPerToken: multiple * 1e-6,
  outputCostPerToken: multiple * 2e-6,
  cacheReadInputTokenCost: multiple * 3e-6,
  cacheCreationInputTokenCost: multiple * 4e-6,
});
globalThis.__kibblePricingFixture = {
  parseLocalSources: () => ({
    messages: ["provider-a", "provider-b", "provider-a"].map((providerId, index) => ({
      date: "2026-09-05",
      source: "claude",
      modelId: "fixture-model",
      providerId,
      sessionId: `fixture-${index}`,
      ...usage,
      reasoning: 5,
    })).concat([{ date: "2026-09-05", source: "claude", modelId: "fixture-model", providerId: "provider-a", sessionId: "empty", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }]),
  }),
  async lookupPricing(model, provider) {
    if (model === "unpriced") throw new Error("no fixture price");
    const special = {
      placeholder: { inputCostPerToken: 0, outputCostPerToken: 0 },
      missingInput: { inputCostPerToken: 0, outputCostPerToken: 1e-6 },
      missingCache: { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 },
      invalid: { ...rates(1), inputCostPerToken: NaN },
      negative: { ...rates(1), cacheReadInputTokenCost: -1 },
      infinite: { ...rates(1), outputCostPerToken: Infinity },
      huge: { ...rates(1), inputCostPerToken: Number.MAX_VALUE },
    };
    if (Object.hasOwn(special, model)) return { pricing: special[model] };
    const multiple = provider === "provider-a" ? 1 : provider === "provider-b" ? 2 : 3;
    return { pricing: rates(multiple) };
  },
  fallback: {
    daily: [{
      date: "2026-09-05",
      agent: "cursor",
      model: "fallback-model",
      provider: null,
      tokensIn: 1,
      tokensOut: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      tokensReasoning: 0,
      messageCount: 1,
      costMicros: 77,
    }],
    sessions: [],
  },
};

const home = mkdtempSync(join(tmpdir(), "kibble-pricing-"));
try {
  const { createSource } = await import(`${dist}sources/index.js`);
  const { priceRecord, pricedCostMicros, PricingContext } = await import(`${dist}sources/pricing.js`);
  const pricing = new PricingContext();
  const result = await createSource({ pricing, home }).collect({
    since: "2026-09-05",
    until: "2026-09-05",
  });

  const core = result.daily.find((row) => row.agent === "claude-code");
  assert.equal(core.messageCount, 3, "zero-token native records do not inflate response counts");
  assert.equal(core.costMicros, 1_200, "provider-a and provider-b retain distinct rates");
  assert.equal(result.daily.find((row) => row.agent === "cursor").costMicros, 77);
  assert.equal(result.sessions.reduce((sum, session) => sum + session.costMicros, 0), 1_200);
  assert.equal(pricedCostMicros(usage, rates(1)), 300);

  const sidecar = await priceRecord(["fixture-model", "unpriced"], pricing);
  assert.equal(
    sidecar("fixture-model", {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    }),
    900,
    "providerless sidecar pricing stays distinct from provider-specific core pricing",
  );
  assert.equal(sidecar("unpriced", { input_tokens: 10 }), 0);

  // Unknown or invalid pricing must not turn CI spend into a reported zero.
  await pricing.prefetch(["placeholder", "missingInput", "missingCache", "invalid", "negative", "infinite", "huge"]);
  const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const model of ["not-prefetched", "unpriced", "placeholder", "missingInput", "invalid", "negative", "infinite"]) {
    assert.equal(pricing.knownCostMicros(model, usage), null, `${model} has no safe CI estimate`);
    assert.equal(pricing.knownCostMicros(model, empty), null, `${model} cannot establish even a zero estimate`);
  }
  assert.equal(pricing.knownCostMicros("huge", usage), null, "overflow must not be reported as zero");
  assert.equal(pricing.knownCostMicros("missingCache", usage), null, "used cache buckets need explicit rates");
  assert.equal(pricing.knownCostMicros("missingCache", { ...empty, input: 10, output: 20 }), 50);
  assert.equal(pricing.knownCostMicros("fixture-model", empty), 0, "known rates establish zero-token cost");
  assert.equal(pricing.knownCostMicros("fixture-model", usage), 900);
  assert.equal(pricing.knownCostMicros({ model: "fixture-model", provider: "provider-a" }, usage), 300);
  assert.equal(pricing.knownCostMicros("fixture-model", { ...usage, input: -1 }), null);
  assert.equal(pricing.costMicros("missingCache", usage), 90, "legacy cache fallbacks remain unchanged");
  assert.equal(pricing.costMicros("placeholder", usage), 0, "legacy unknown-price behavior remains unchanged");
} finally {
  delete globalThis.__kibblePricingFixture;
  rmSync(home, { recursive: true, force: true });
}

console.log("OK  pricing context preserves provider rates across core, hybrid and sidecars");
