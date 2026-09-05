/**
 * Accuracy check for Lane A, against ground truth rather than against another tool.
 *
 *   node scripts/verify-accuracy.mjs [since] [until]
 *
 * Reads Claude Code's own transcripts directly, deduplicates on
 * requestId/message.id (the same response is written into several files when a
 * session is resumed or forked), and compares the total with what our collector
 * reports.
 *
 * This exists because "matches the other tool" is the wrong test. The tokscale
 * CLI and the tokscale Rust core disagree by roughly a quarter on this data, so
 * agreeing with either one proves nothing on its own -- only the transcripts can
 * settle it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSource,
  TokscaleCliSource,
  TokscaleHybridSource,
  TOKSCALE_CORE_AGENTS,
} from "../dist/sources/index.js";
// Run fixture modules sequentially: some temporarily replace process globals.
await import("./verify-repos.mjs");
await import("./verify-transcripts.mjs");
await import("./verify-login.mjs");
await import("./verify-config.mjs");
await import("./verify-lock.mjs");
await import("./verify-schedule.mjs");
// Adapter fixtures replace module loading, so each needs a fresh module cache.
for (const fixture of ["verify-push.mjs", "verify-pricing.mjs"]) {
  const checked = spawnSync(process.execPath, [fileURLToPath(new URL(fixture, import.meta.url))], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout || checked.error?.message);
  console.log(checked.stdout.trim());
}

const since = process.argv[2] ?? "2026-08-21";
const until = process.argv[3] ?? "2026-08-27";

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

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function groundTruth() {
  const seen = new Set();
  let messages = 0;
  let tokens = 0;
  let duplicates = 0;

  for (const file of walk(join(homedir(), ".claude", "projects"))) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const day = (rec.timestamp ?? "").slice(0, 10);
      if (day < since || day > until) continue;
      const usage = rec.message?.usage;
      if (!usage) continue;
      const tok =
        (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      if (tok === 0) continue;

      const id = rec.requestId ?? rec.message?.id;
      if (id) {
        if (seen.has(id)) {
          duplicates++;
          continue;
        }
        seen.add(id);
      }
      messages++;
      tokens += tok;
    }
  }
  return { messages, tokens, duplicates };
}

const truth = groundTruth();
if (truth.tokens === 0) {
  console.error(`FAILED: no Claude Code token usage in transcripts for ${since}..${until}; choose a populated window.`);
  process.exit(1);
}

const results = [];
for (const candidate of [
  { choice: "default", source: createSource(), required: true },
  { choice: "raw CLI", source: new TokscaleCliSource(), required: false },
]) {
  const { source } = candidate;
  try {
    const { daily } = await source.collect({ since, until });
    const claude = daily.filter((r) => r.agent === "claude-code");
    results.push({
      choice: candidate.choice,
      name: source.name,
      required: candidate.required,
      messages: claude.reduce((s, r) => s + r.messageCount, 0),
      tokens: claude.reduce(
        (s, r) =>
          s + r.tokensIn + r.tokensOut + r.tokensCacheRead + r.tokensCacheWrite,
        0,
      ),
    });
  } catch (err) {
    results.push({
      choice: candidate.choice,
      name: source.name,
      required: candidate.required,
      error: err.message,
    });
  }
}

const m = (n) => `${(n / 1e6).toFixed(1)}M`;
console.log(`window ${since}..${until}  (claude-code only)\n`);
console.log(`  ${"choice/source".padEnd(30)} ${"messages".padStart(9)} ${"tokens".padStart(9)} ${"delta".padStart(9)}`);
console.log(`  ${"transcripts".padEnd(30)} ${String(truth.messages).padStart(9)} ${m(truth.tokens).padStart(9)} ${"-".padStart(9)}`);

let failed = false;
for (const r of results) {
  if (r.error) {
    console.log(`  ${`${r.choice}/${r.name}`.padEnd(30)} ${"ERROR".padStart(9)}  ${r.error}`);
    if (r.required) failed = true;
    continue;
  }
  const delta = truth.tokens ? ((r.tokens - truth.tokens) / truth.tokens) * 100 : 0;
  const flag = Math.abs(delta) <= 2 ? "" : "   <- outside +/-2%";
  console.log(
    `  ${`${r.choice}/${r.name}`.padEnd(30)} ${String(r.messages).padStart(9)} ${m(r.tokens).padStart(9)} ${`${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`.padStart(9)}${flag}`,
  );
  if (r.required && Math.abs(delta) > 2) failed = true;
}

console.log(`\n  ${truth.duplicates} duplicate records skipped (same response in more than one transcript file)`);

if (failed) {
  console.error("\nFAILED: the default collector could not be collected or is more than 2% off the transcripts.");
  process.exit(1);
}
console.log("\nOK  the default collector is within 2% of the transcripts");
