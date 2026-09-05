// Shared synthetic regression suite. CI runs this without personal transcripts;
// verify-accuracy.mjs runs the same suite before its local accuracy comparison.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSource, TokscaleHybridSource, TOKSCALE_CORE_AGENTS } from "../dist/sources/index.js";
// Run fixture modules sequentially: some temporarily replace process globals.
await import("./verify-repos.mjs");
await import("./verify-transcripts.mjs");
await import("./verify-login.mjs");
await import("./verify-config.mjs");
await import("./verify-plans.mjs");
await import("./verify-lock.mjs");
await import("./verify-schedule.mjs");
await import("./verify-updates.mjs");
// Adapter fixtures replace module loading, so each needs a fresh module cache.
for (const fixture of ["verify-push.mjs", "verify-pricing.mjs"]) {
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
  assert.ok(
    createSource() instanceof TokscaleHybridSource,
    "default collection must include additional agents without overlapping totals",
  );

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
