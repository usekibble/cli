import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Load the production command with deterministic source and sidecar adapters.
// `module.register` is available on every supported Node version, unlike the
// synchronous registerHooks API added after Node 20.
const dist = new URL("../dist/", import.meta.url).href;
const stubs = {
  [`${dist}sources/index.js`]: `
    export const createSource = () => ({
      name: "fixture",
      collect: range => globalThis.__kibblePushFixture.collect(range),
    });
  `,
  [`${dist}sources/pricing.js`]: "export class PricingContext {} export const priceRecord = async () => () => 0;",
  [`${dist}sources/local.js`]: "export const scanLocal = (options) => ({ repos: [], capabilities: options.capabilities ? globalThis.__kibblePushFixture.capabilities : [], modelActivity: [] });",
  [`${dist}sources/plans.js`]: "export const readPlans = () => []; export const describePlans = () => [];",
  [`${dist}commands/schedule.js`]: "export const enforcePolicy = (...args) => globalThis.__kibblePushFixture.policies.push(args);",
};
const loader = `
  const stubs = new Map(Object.entries(${JSON.stringify(stubs)}));
  export async function load(url, context, nextLoad) {
    if (stubs.has(url)) return { format: "module", source: stubs.get(url), shortCircuit: true };
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const root = mkdtempSync(join(tmpdir(), "kibble-push-check-"));
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalDate = Date;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
process.env.XDG_CONFIG_HOME = root;
globalThis.Date = class extends originalDate {
  constructor(...args) {
    super(...(args.length ? args : ["2026-09-05T12:00:00Z"]));
  }
  static now() { return originalDate.parse("2026-09-05T12:00:00Z"); }
};
console.log = () => {};

const fixture = globalThis.__kibblePushFixture = {
  ranges: [],
  policies: [],
  collects: 0,
  emptyDaily: false,
  capabilities: [],
  collect(range) {
    this.collects += 1;
    this.ranges.push(range);
    return {
      daily: this.emptyDaily ? [] : [{
        date: range.until,
        agent: "codex",
        model: "fixture",
        provider: null,
        tokensIn: 10,
        tokensOut: 20,
        tokensCacheRead: 30,
        tokensCacheWrite: 40,
        tokensReasoning: 5,
        messageCount: 1,
        costMicros: 1,
      }],
      sessions: [],
    };
  },
};

try {
  const { push } = await import(`${dist}commands/push.js`);
  const { loadConfig, saveConfig } = await import(`${dist}config.js`);
  const linked = (overrides = {}) => ({
    server: "https://fixture.example/base",
    linkToken: "fixture-token",
    capabilities: false,
    autoCollect: false,
    lastPushedThrough: "2026-09-01",
    ...overrides,
  });
  const requests = [];
  let duringFetch = null;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: new URL(input), init });
    duringFetch?.();
    return Response.json({ applied: 1, autoCollect: true, collectCapabilities: false });
  };

  // A one-day manual repair after a gap must not skip the missing days.
  saveConfig(linked());
  await push({ since: "2026-09-05", until: "2026-09-05", quiet: true });
  assert.equal(loadConfig().lastPushedThrough, "2026-09-01");
  assert.equal(requests[0].url.origin, "https://fixture.example");
  assert.equal(requests[0].init.redirect, "error");

  // Covering the outstanding resume interval advances through the accepted end.
  saveConfig(linked());
  await push({ until: "2026-09-05", quiet: true });
  assert.deepEqual(fixture.ranges.at(-1), { since: "2026-09-01", until: "2026-09-05" });
  assert.equal(loadConfig().lastPushedThrough, "2026-09-05");

  // A future saved cursor is not trusted, and an old targeted range does not
  // replace the implicit outstanding interval with an even older cursor.
  saveConfig(linked({ lastPushedThrough: "2099-01-01" }));
  await push({ since: "2026-08-01", until: "2026-08-02", quiet: true });
  assert.equal(loadConfig().lastPushedThrough, undefined);

  // A login racing an in-flight request owns the config once it lands. The old
  // response cannot write its cursor, digest or organization policy over it.
  saveConfig(linked());
  fixture.policies.length = 0;
  duringFetch = () => saveConfig(linked({
    server: "https://new.example",
    linkToken: "new-token",
    capabilities: true,
    autoCollect: false,
    lastPushedThrough: "2026-08-30",
    capabilityDigest: "new-digest",
  }));
  await push({ until: "2026-09-05", quiet: true });
  duringFetch = null;
  assert.deepEqual(loadConfig(), linked({
    server: "https://new.example",
    linkToken: "new-token",
    capabilities: true,
    autoCollect: false,
    lastPushedThrough: "2026-08-30",
    capabilityDigest: "new-digest",
  }));
  assert.equal(fixture.policies.length, 0, "an old response must not enforce policy on a new link");

  // A recorded command still uploads on a day with no token usage. Repeating
  // the push sends the same daily count; organization policy still disables it.
  fixture.emptyDaily = true;
  fixture.capabilities = [{ agent: "codex", date: "2026-09-05", kind: "command", name: "status", invocations: 1, installed: false, triggerTyped: 1, triggerModel: 0, contextTokens: 0, descriptionTokens: 0, attributedTurns: 0, attributedTokens: 0, attributedCostMicros: 0 }];
  const beforeCommands = requests.length;
  for (let retry = 0; retry < 2; retry++) {
    saveConfig(linked({ capabilities: true }));
    await push({ since: "2026-09-05", until: "2026-09-05", quiet: true });
    const body = JSON.parse(requests.at(-1).init.body);
    assert.deepEqual(body.rows, []);
    assert.deepEqual(body.capabilities, fixture.capabilities);
  }
  assert.equal(requests.length, beforeCommands + 2);
  saveConfig(linked({ capabilities: false }));
  await push({ since: "2026-09-05", until: "2026-09-05", quiet: true });
  assert.equal(requests.length, beforeCommands + 2, "disabled capability policy sends no command-only payload");
  fixture.emptyDaily = false;
  fixture.capabilities = [];

  // Credentials never leave their configured origin, and invalid ranges never
  // reach the collector or the network.
  saveConfig(linked());
  const requestsBeforeRefusals = requests.length;
  const collectsBeforeRefusals = fixture.collects;
  await assert.rejects(
    push({ server: "https://other.example", since: "2026-09-01", until: "2026-09-05" }),
    /another server/,
  );
  await assert.rejects(push({ since: "2026-09-06", until: "2026-09-06" }), /future/);
  await assert.rejects(push({ since: "2026-09-05", until: "2026-09-01" }), /on or before/);
  await assert.rejects(push({ since: "2026-02-31", until: "2026-09-01" }), /valid UTC dates/);
  assert.equal(requests.length, requestsBeforeRefusals);
  assert.equal(fixture.collects, collectsBeforeRefusals);
} finally {
  globalThis.fetch = originalFetch;
  globalThis.Date = originalDate;
  console.log = originalLog;
  delete globalThis.__kibblePushFixture;
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  rmSync(root, { recursive: true, force: true });
}

console.log("OK  push advances only covered gaps and preserves a concurrently changed link");
