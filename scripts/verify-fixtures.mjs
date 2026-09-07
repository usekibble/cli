// Shared synthetic regression suite. CI runs this without personal transcripts;
// verify-accuracy.mjs runs the same suite before its local accuracy comparison.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DefaultSource, TokscaleHybridSource, TOKSCALE_CORE_AGENTS } from "../dist/sources/index.js";
import { verifyCopilot } from "./verify-copilot.mjs";
import { verifyVsCode } from "./verify-vscode.mjs";
// Run fixture modules sequentially: some temporarily replace process globals.
await verifyCopilot();
await verifyVsCode();
await import("./verify-repos.mjs");
await import("./verify-transcripts.mjs");
await import("./verify-config.mjs");
await import("./verify-plans.mjs");
await import("./verify-lock.mjs");
await import("./verify-schedule.mjs");
await import("./verify-updates.mjs");
await import("./verify-ci-run.mjs");
// Adapter fixtures replace module loading, so each needs a fresh module cache.
for (const fixture of ["verify-login.mjs", "verify-push.mjs", "verify-pricing.mjs"]) {
  const checked = spawnSync(process.execPath, [fileURLToPath(new URL(fixture, import.meta.url))], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout || checked.error?.message);
  console.log(checked.stdout.trim());
}

const sampleRow = (agent, costMicros) => ({
  date: "2026-08-21",
  agent,
  model: `model-${agent}`,
  provider: null,
  tokensIn: costMicros,
  tokensOut: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  tokensReasoning: 0,
  messageCount: 1,
  costMicros,
});

const fakeSource = (name, daily, sessions) => ({
  name,
  coverage: name,
  async version() { return "fixture"; },
  async collect() { return { daily, sessions }; },
});

async function verifyHybridBoundary() {
  const supported = [...TOKSCALE_CORE_AGENTS];
  const core = fakeSource(
    "core-fixture",
    supported.map((agent, i) => sampleRow(agent, 100 + i)),
    [{
      sessionId: "core-session",
      agent: "claude-code",
      date: "2026-08-21",
      messageCount: 1,
      costMicros: 100,
    }],
  );
  const fallback = fakeSource(
    "fallback-fixture",
    [
      ...supported.map((agent, i) => sampleRow(agent, 900 + i)),
      sampleRow("cursor", 500),
    ],
    [
      {
        sessionId: "overlap-session",
        agent: "claude-code",
        date: "2026-08-21",
        messageCount: 1,
        costMicros: 900,
      },
      {
        sessionId: "fallback-session",
        agent: "cursor",
        date: "2026-08-21",
        messageCount: 1,
        costMicros: 500,
      },
    ],
  );
  const result = await new TokscaleHybridSource(core, fallback).collect({
    since: "2026-08-21",
    until: "2026-08-21",
  });

  for (const [i, agent] of supported.entries()) {
    const rows = result.daily.filter((row) => row.agent === agent);
    assert.equal(rows.length, 1, `${agent} must occur once in the hybrid`);
    assert.equal(
      rows[0].costMicros,
      100 + i,
      `${agent} must come from the selected core source`,
    );
  }
  assert.equal(
    result.daily.find((row) => row.agent === "cursor")?.costMicros,
    500,
    "a fallback-only agent must remain in the hybrid",
  );
  assert.deepEqual(
    result.sessions.map((session) => session.sessionId),
    ["core-session", "fallback-session"],
    "sessions must follow the same no-overlap boundary",
  );
  console.log("OK  hybrid uses core-supported agents once and retains fallback-only agents");
}

await verifyHybridBoundary();

async function verifyDefaultBoundary() {
  const range = { since: "2026-08-21", until: "2026-08-21" };
  const session = (sessionId, agent, costMicros) => ({
    sessionId, agent, date: range.since, messageCount: 1, costMicros,
  });
  const base = fakeSource("hybrid", [sampleRow("claude-code", 100), sampleRow("cursor", 500), sampleRow("copilot", 900)], [
    session("claude-session", "claude-code", 100),
    session("cursor-session", "cursor", 500),
    session("upstream-copilot", "copilot", 900),
  ]);
  const cli = fakeSource("copilot-cli", [sampleRow("copilot", 20)], [session("cli-session", "copilot", 20)]);
  const vscode = fakeSource("vscode", [sampleRow("copilot", 30)], [session("vscode-session", "copilot", 30)]);
  const source = new DefaultSource(base, {}, cli, vscode);
  const result = await source.collect(range);
  assert.deepEqual(result.daily.map((row) => [row.agent, row.costMicros]), [
    ["cursor", 500], ["claude-code", 100], ["copilot", 50],
  ], "default collection must preserve other agents and merge dedicated Copilot counters without upstream overlap");
  assert.equal(result.daily.find((row) => row.agent === "copilot")?.tokensIn, 50);
  assert.equal(result.daily.find((row) => row.agent === "copilot")?.messageCount, 2);
  assert.deepEqual(result.sessions.map((row) => row.sessionId), [
    "claude-session", "cursor-session", "cli-session", "vscode-session",
  ], "overlapping upstream Copilot sessions must not enter the dedup ledger");
  assert.deepEqual(await source.collect(range), result, "repeated default collection must preserve totals");
  console.log("OK  default collection merges Copilot CLI and VS Code without losing other agents or double counting upstream totals");
}

await verifyDefaultBoundary();
