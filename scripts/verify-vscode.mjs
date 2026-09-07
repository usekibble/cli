/** Lost/duplicated spend, wrong provider, and private-content regressions.
 * Expected counts are independent fixture constants, not another collector.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VsCodeCopilotSource, scanVsCode, replayVsCode, vsCodeDataDirs } from "../dist/sources/vscode.js";
import { mergeCollections } from "../dist/sources/index.js";
import { scanLocal } from "../dist/sources/local.js";

export async function verifyVsCode() {
  const home = mkdtempSync(join(tmpdir(), "kibble-vscode-check-"));
  const root = join(home, "Code");
  const dir = join(root, "User/workspaceStorage/workspace/chatSessions");
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const date = "2026-09-07";
  const range = { since: date, until: date };
  const options = { home, userDataDirs: [root], ...range };
  const make = (requestId, timestamp, promptTokens, completionTokens) => ({
    requestId, timestamp: Date.parse(timestamp), modelId: "copilot/auto",
    agent: { extensionId: { value: "GitHub.copilot-chat" } },
    promptTokens, completionTokens, modelState: { value: 1 }, elapsedMs: 20,
    result: { metadata: { resolvedModel: "gpt-5", toolCallRounds: [{ modelId: "gpt-5", response: "PRIVATE_REPLY" }], renderedUserMessage: "PRIVATE_PROMPT" } },
    message: { text: "PRIVATE_PROMPT" },
    response: [{ kind: "toolInvocationSerialized", toolCallId: "tool-1", toolId: "mcp_read", source: { type: "mcp", serverLabel: "docs", instructions: "PRIVATE_INSTRUCTIONS" }, resultDetails: { output: "PRIVATE_OUTPUT" } }],
  });
  const first = make("request-1", `${date}T00:00:01Z`, 100, 20);
  const second = make("request-2", `${date}T23:59:59Z`, 200, 30);
  const before = make("request-before", "2026-09-06T23:59:59Z", 900, 900);
  const initial = { sessionId, requests: [before, first] };
  const write = (path, value) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, value); };
  const log = (entries) => entries.map(JSON.stringify).join("\n") + "\n";
  const file = join(dir, `${sessionId}.jsonl`);
  const priceOf = (_model, u) => (u.input_tokens ?? 0) * 2 + (u.output_tokens ?? 0) * 3 + (u.cache_read_input_tokens ?? 0);
  try {
    // A folder URI is consumed locally, never sent. The directory need not be
    // a Git checkout to demonstrate the name-only boundary.
    const repo = join(home, "sample-repo"); mkdirSync(repo);
    write(join(dir, "../workspace.json"), JSON.stringify({ folder: pathToFileURL(repo).href }));
    const operations = [
      { kind: 0, v: initial },
      { kind: 2, k: ["requests"], v: [second] },
      { kind: 1, k: ["requests", 1, "promptTokens"], v: 110 },
      { kind: 1, k: ["requests", 1, "message", "text"], v: "PRIVATE_UPDATE" },
      { kind: 2, k: ["requests", 1, "response"], v: [first.response[0]] },
    ];
    write(file, log(operations) + '{"kind":');
    // A legacy JSON copy next to the JSONL is not an extra session.
    write(join(dir, `${sessionId}.json`), JSON.stringify(initial));
    const source = new VsCodeCopilotSource({ ...options, priceOf });
    const got = await source.collect(range);
    assert.equal(got.daily.length, 1);
    assert.equal(got.daily[0].tokensIn, 310);
    assert.equal(got.daily[0].tokensOut, 50);
    assert.equal(got.daily[0].costMicros, 770);
    assert.equal(got.daily[0].messageCount, 2);
    assert.equal(got.sessions.length, 1);
    assert.deepEqual(await source.collect(range), got, "repeated collection changes spend");
    const local = scanLocal({ home, copilotHome: join(home, ".copilot"), vscodeUserDataDirs: [root], ...range, priceOf });
    assert.equal(local.repos[0]?.costMicros, 770);
    assert.equal(local.repos[0]?.humanTurns, 2);
    assert.equal(local.repos[0]?.toolCalls, 2, "a tool snapshot was counted twice");
    assert.equal(local.capabilities.find((c) => c.name === "docs")?.invocations, 2);
    assert(!JSON.stringify({ got, local }).includes("PRIVATE_"));
    assert(!JSON.stringify({ got, local }).includes(home));

    // Copilot CLI and editor rows share one ingest grain: neither can replace
    // the other. This calls the production merge used by the default source.
    const merged = mergeCollections(got, { daily: [{ ...got.daily[0], tokensIn: 5, tokensOut: 0, messageCount: 1, costMicros: 10 }], sessions: [] });
    assert.equal(merged.daily.length, 1);
    assert.equal(merged.daily[0].tokensIn, 315);
    assert.equal(merged.daily[0].costMicros, 780);

    // Native whole-turn totals take priority over the last-call widget, and
    // cached tokens are removed from the inclusive input before pricing.
    const multi = { ...second, modelTotals: [
      { model: "gpt-5", inputTokens: 1000, cachedTokens: 400, outputTokens: 100 },
      { model: "claude-sonnet-4", inputTokens: 500, cachedTokens: 0, outputTokens: 50 },
    ] };
    write(file, log([{ kind: 0, v: { sessionId, requests: [multi] } }]));
    const totals = await source.collect(range);
    assert.equal(totals.daily.reduce((n, r) => n + r.tokensIn, 0), 1100);
    assert.equal(totals.daily.reduce((n, r) => n + r.tokensCacheRead, 0), 400);
    assert.equal(totals.daily.reduce((n, r) => n + r.tokensOut, 0), 150);

    // Splice/truncate, delete, and migration copies must not resurrect turns.
    const old = join(root, "User/globalStorage/emptyWindowChatSessions", `${sessionId}.jsonl`);
    write(old, log([{ kind: 0, v: { sessionId, requests: [first, second] } }]));
    utimesSync(old, new Date("2026-09-06T00:00:00Z"), new Date("2026-09-06T00:00:00Z"));
    write(file, log([
      { kind: 0, v: { sessionId, requests: [first, second] } },
      { kind: 2, k: ["requests"], i: 1, v: [] },
      { kind: 3, k: ["requests", 0, "completionTokens"] },
      { kind: 1, k: ["requests", 0, "completionTokens"], v: 25 },
    ]));
    assert.equal((await source.collect(range)).daily[0].tokensOut, 25);

    const foreign = { ...second, requestId: "foreign", modelId: "anthropic/claude-sonnet-4" };
    const delegated = { ...second, requestId: "delegated", result: { metadata: { claudeSessionId: "separate-source" } } };
    write(file, log([{ kind: 0, v: { sessionId, requests: [foreign, delegated] } }]));
    assert.equal((await source.collect(range)).daily.length, 0, "non-Copilot/delegated provider was counted twice");

    const legacy = { ...first, result: { metadata: { resolvedModel: "gpt-5", toolCallRounds: [{}, {}, {}] } } };
    write(file, log([{ kind: 0, v: { sessionId, requests: [legacy] } }]));
    assert.equal(scanVsCode(options).requests[0].lastCallOnly, true);
    assert.equal(scanVsCode(options).requests[0].usages[0].tokensIn, 100, "last-call input must not be multiplied by loop length");

    const guarded = { sessionId, requests: [{ ...first }] };
    Object.defineProperty(guarded.requests[0], "message", { get() { throw new Error("read private prompt"); } });
    const privateMutation = { kind: 1, k: ["requests", 0, "message", "text"] };
    Object.defineProperty(privateMutation, "v", { get() { throw new Error("read private mutation"); } });
    const state = replayVsCode([{ kind: 0, v: guarded }, privateMutation, { kind: 1, k: ["__proto__", "polluted"], v: true }]);
    assert(!JSON.stringify(state).includes("PRIVATE_"));
    assert.equal({}.polluted, undefined);
    write(file, log([{ kind: 0, v: initial }]) + 'broken\n' + log([{ kind: 2, k: ["requests"], v: [second] }]));
    await assert.rejects(() => source.collect(range), /Invalid VS Code/);
    assert.deepEqual(vsCodeDataDirs({ home, platform: "linux", env: {} }), [join(home, ".config/Code"), join(home, ".config/Code - Insiders")]);
    assert.deepEqual(vsCodeDataDirs({ home, platform: "win32", env: { APPDATA: "/fixture-roaming" } }), [join("/fixture-roaming", "Code"), join("/fixture-roaming", "Code - Insiders")]);
    assert.deepEqual(vsCodeDataDirs({ env: { VSCODE_PORTABLE: "/fixture-portable" } }), [join("/fixture-portable", "user-data")]);
    console.log("OK  VS Code fixtures: mutation replay, provider scope, dedup, shared grain, tokens and privacy");
  } finally { rmSync(home, { recursive: true, force: true }); }
}
