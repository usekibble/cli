import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      agent: "zed",
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
  assert.equal(result.daily.find((row) => row.agent === "zed").costMicros, 77);
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
  // Fractional live durations must not lose calls, and model reconciliation
  // must never move explicitly attributed tools onto a different model.
  const { CursorSource, normalizeCursorStop, cursorUsagePath } = await import(`${dist}sources/cursor.js`);
  const { normalizeCursorTool, cursorToolsPath, readCursorTools } = await import(`${dist}sources/cursor-tools.js`);
  const observed = new Date("2026-09-05T12:00:00Z");
  const metadata = { conversation_id: "00000000-0000-4000-8000-000000000001", generation_id: "00000000-0000-4000-8000-000000000002" };
  const stop = normalizeCursorStop({ ...metadata, hook_event_name: "stop", model: "fixture-model", input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0 }, observed);
  const toolPayload = { ...metadata, hook_event_name: "postToolUse", tool_name: "Shell", tool_use_id: "call_1", duration: 2625.198 };
  const tool = normalizeCursorTool(toolPayload, observed);
  assert.equal(tool.durationMs, 2625, "live fractional duration retains the completed call with rounded milliseconds");
  assert.equal(normalizeCursorTool({ ...toolPayload, duration: 0.5 }, observed).durationMs, 1);
  for (const duration of [-0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizeCursorTool({ ...toolPayload, duration }, observed), /Invalid Cursor tool metadata/);
  }
  mkdirSync(join(home, ".config/kibble"), { recursive: true });
  writeFileSync(cursorUsagePath(home), JSON.stringify(stop) + "\n");
  writeFileSync(cursorToolsPath(home), [tool, tool,
    { ...tool, toolId: "call_2", model: "explicit-subagent-model" },
    { ...tool, toolId: "call_3", generationId: "00000000-0000-4000-8000-000000000003" },
    { ...tool, toolId: "call_4", conversationId: "00000000-0000-4000-8000-000000000004" },
  ].map(row => JSON.stringify(row) + "\n").join(""));
  const cursor = new CursorSource({ home, pricing });
  const options = { since: "2026-09-05", until: "2026-09-05" };
  const cursorUsage = await cursor.collect(options);
  const toolRows = cursor.toolSnapshot(options);
  assert.equal(toolRows.length, 4, "repeated fractional tool events count only once");
  assert.equal(toolRows[0].model, "fixture-model", "only the matching completed generation supplies a missing model");
  assert.equal(toolRows[1].model, "explicit-subagent-model", "an explicit differing tool model is never overwritten or aliased");
  assert.equal(toolRows[2].model, null, "another generation does not inherit the stop model");
  assert.equal(toolRows[3].model, null, "another conversation does not inherit the stop model");
  assert.equal(readCursorTools(cursorToolsPath(home))[0].model, null, "reconciliation leaves stored evidence unchanged");
  assert.equal(cursorUsage.daily[0].costMicros, 150, "tool attribution does not add or reprice token usage");

  // Lost calls and ID collisions: preserve the entire compound identity without
  // writing its components or confusing it with a legacy single-component ID.
  const ids = ['call_a\nnamespace_b', 'call_a\nnamespace_c', 'call_a_namespace_b', 'ab\nc', 'a\nbc', 'Call_a\nnamespace_b'];
  const compoundTools = ids.map(tool_use_id => normalizeCursorTool({ ...toolPayload, tool_use_id }, observed));
  assert.equal(new Set(compoundTools.map(r => r.toolId)).size, ids.length);
  assert.equal(compoundTools[2].toolId, ids[2], 'legacy IDs are not migrated');
  for (const tool_use_id of ['', 'a\n', '\na', 'a\n\nb', 'a\r\nb', 'a\tb', 'a b', 'a\n' + 'b'.repeat(129), Array(9).fill('a').join('\n'), compoundTools[0].toolId]) {
    assert.throws(() => normalizeCursorTool({ ...toolPayload, tool_use_id }, observed), /Invalid Cursor tool metadata/);
  }
  const serializedTools = [...compoundTools, compoundTools[0]].map(r => JSON.stringify(r) + '\n').join('');
  assert(!JSON.stringify(compoundTools[0]).includes('namespace_b'), 'raw compound components are not retained');
  writeFileSync(cursorToolsPath(home), serializedTools);
  const recovered = new CursorSource({ home, pricing });
  assert.equal(recovered.toolSnapshot(options).length, ids.length, 'repeated compound callbacks count once');
  assert.equal((await recovered.collect(options)).daily[0].costMicros, 150, 'recovering tools cannot inflate spend');
  writeFileSync(cursorToolsPath(home), JSON.stringify({ ...compoundTools[0], toolId: ids[0] }) + '\n');
  assert.throws(() => readCursorTools(cursorToolsPath(home)), /complete Cursor tool/);
} finally {
  delete globalThis.__kibblePricingFixture;
  rmSync(home, { recursive: true, force: true });
}

console.log("OK  pricing context preserves provider rates across core, hybrid and sidecars");
