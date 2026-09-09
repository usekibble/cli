import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  [`${dist}commands/cursor.js`]: "export const ensureCursorHooks = () => globalThis.__kibblePushFixture.ensureCursorHooks();",
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
  hookCalls: 0,
  hookFail: false,
  ensureCursorHooks() {
    this.hookCalls++;
    if (this.hookFail) throw new Error("fixture hook setup failure");
  },
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

  // A concurrent foreground caller must know no upload was performed.
  const { acquire } = await import(`${dist}lock.js`);
  saveConfig(linked());
  const held = acquire();
  assert.ok("release" in held);
  try {
    assert.equal(await push({ quiet: true }), "busy");
    assert.equal(requests.length, 0);
  } finally { held.release(); }

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

  // A new machine imports 30 inclusive UTC days, and a stale cursor cannot
  // widen that window. A subsequent sync still overlaps yesterday and today.
  for (const cursor of [undefined, "2025-01-01"]) {
    saveConfig(linked({ lastPushedThrough: cursor }));
    await push({ quiet: true });
    assert.deepEqual(fixture.ranges.at(-1), { since: "2026-08-07", until: "2026-09-05" });
    assert.equal(loadConfig().lastPushedThrough, "2026-09-05");
    await push({ quiet: true });
    assert.deepEqual(fixture.ranges.at(-1), { since: "2026-09-04", until: "2026-09-05" });
  }

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

  // Hook repair enables future collection even when no prior usage exists.
  fixture.emptyDaily = true;
  saveConfig(linked({ autoCollect: true }));
  const beforeHooks = fixture.hookCalls;
  assert.equal(await push({ quiet: true }), "empty");
  assert.equal(fixture.hookCalls, beforeHooks + 1, "empty automatic pushes still repair Cursor hooks");
  await push({ dryRun: true, quiet: true });
  assert.equal(fixture.hookCalls, beforeHooks + 1, "dry runs cannot install or repair hooks");
  saveConfig(linked({ autoCollect: false }));
  await push({ quiet: true });
  assert.equal(fixture.hookCalls, beforeHooks + 1, "manual-policy pushes do not modify hooks");
  saveConfig(linked({ autoCollect: true }));
  fixture.hookFail = true;
  const beforeHookFailure = fixture.collects;
  const requestsBeforeHookFailure = requests.length;
  await assert.rejects(push({ quiet: true }), /fixture hook setup failure/);
  assert.equal(fixture.collects, beforeHookFailure, "hook failures stop collection before an incomplete upload");
  assert.equal(requests.length, requestsBeforeHookFailure);
  assert.equal(loadConfig().lastPushedThrough, "2026-09-01", "hook failure cannot advance synchronization");
  fixture.hookFail = false;
  assert.equal(await push({ quiet: true }), "empty", "a failed hook repair releases the push lock for retry");
  fixture.emptyDaily = false;

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

  // Account totals must remain separate from device rows, require opt-in, and
  // survive an empty device collection. Unexpected local fields cannot leak.
  const { validateCursorAccount, cursorExportDates } = await import(`${dist}sources/cursor-account.js`);
  const account = {
    accountId: "a".repeat(64), since: "2026-09-02", until: "2026-09-03",
    fetchedAt: "2026-09-04T00:00:00Z", coveredDates: ["2026-09-02", "2026-09-03"],
    sessionToken: "secret-must-stay-local",
    rows: ["2026-09-02", "2026-09-03"].map(date => ({
      date, agent: "cursor", model: "auto", provider: null,
      tokensIn: 11, tokensOut: 2, tokensCacheRead: 3, tokensCacheWrite: 4,
      tokensReasoning: 0, messageCount: 1, costMicros: 123,
      rawAccountId: "private-account",
    })),
  };
  writeFileSync(join(root, "kibble", "cursor-account.json"), JSON.stringify(account));
  fixture.emptyDaily = true;
  saveConfig(linked({ lastPushedThrough: "2026-09-05" }));
  const beforeAccount = requests.length;
  assert.equal(await push({ quiet: true }), "empty");
  assert.equal(requests.length, beforeAccount, "account snapshot cannot activate without explicit opt-in");
  saveConfig(linked({ lastPushedThrough: "2026-09-05", cursorAccountUsage: true }));
  await push({ quiet: true });
  const accountBody = JSON.parse(requests.at(-1).init.body);
  assert.deepEqual(accountBody.rows, []);
  assert.deepEqual(accountBody.cursorAccount.coveredDates, ["2026-09-02", "2026-09-03"], "account history is independent of local push cursor");
  assert.equal(accountBody.cursorAccount.rows[0].costMicros, 123);
  assert.ok(!requests.at(-1).init.body.includes("secret-must-stay-local"));
  assert.ok(!requests.at(-1).init.body.includes("private-account"));
  const beforeDry = requests.length;
  await push({ dryRun: true, quiet: true });
  assert.equal(requests.length, beforeDry, "account dry run does not upload");
  assert.throws(() => validateCursorAccount({ ...account, fetchedAt: "2026-09-03T12:00:00Z" }), /Invalid Cursor/);
  assert.throws(() => validateCursorAccount({ ...account, rows: [account.rows[0], { ...account.rows[0], provider: "other" }] }), /Invalid Cursor/);
  assert.throws(() => validateCursorAccount({ ...account, rows: [{ ...account.rows[0], tokensIn: Number.MAX_SAFE_INTEGER + 1 }] }), /Invalid Cursor/);
  assert.deepEqual(cursorExportDates('Date,Model\n"2026-09-01T23:59:59Z",a\n"2026-09-03T01:00:00Z",a\n'), ["2026-09-03"], "exclude oldest billing-boundary day and never infer absent zero days");
  assert.deepEqual(cursorExportDates('Date,Model\n"2026-09-01T01:00:00Z",a\n'), []);
  assert.throws(() => cursorExportDates('Date,Model\nnot-a-date,a\n'), /export date/);
  writeFileSync(join(root, "kibble", "cursor-account.json"), "{secret-malformed");
  saveConfig(linked({ cursorAccountUsage: true }));
  await assert.rejects(push({ quiet: true }), /Could not read Cursor account snapshot/);
  assert.equal(requests.length, beforeDry, "unreadable account snapshot fails without advancing or uploading");
  fixture.emptyDaily = false;
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
