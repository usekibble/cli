import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityCollector, codexInventory, inventory } from "../dist/sources/capabilities.js";
import { RepoCollector } from "../dist/sources/repos.js";
import { ModelActivityCollector } from "../dist/sources/model-activity.js";

// Money and collector accuracy: known transcript counts, model switches,
// repeated rate-limit snapshots, and a session resumed across the window.
const prices = [];
const collector = new RepoCollector({
  since: "2026-09-05", until: "2026-09-05",
  priceOf(model, usage) {
    prices.push({ model, usage });
    return usage.input_tokens * 2 + usage.output_tokens * 10 + usage.cache_read_input_tokens;
  },
});
const visitor = collector.codex();
const record = (type, payload, date = "2026-09-05") =>
  visitor.record({ type, payload, timestamp: `${date}T12:00:00Z` });
const usage = (input, cached, output, reasoning) => ({
  input_tokens: input, cached_input_tokens: cached, output_tokens: output,
  reasoning_output_tokens: reasoning, total_tokens: input + output,
});
const tokens = (last, total, date) => record("event_msg", {
  type: "token_count", info: { last_token_usage: last, total_token_usage: total },
}, date);
visitor.startFile();
record("session_meta", { id: "fixture", git: { repository_url: "https://github.com/example/fixture.git" } });
record("turn_context", { model: "model-a" }, "2026-09-04");
const first = usage(100, 60, 20, 10);
tokens(first, first, "2026-09-04");
tokens(first, first); // Same response, only the rate limit changed.
tokens(first, usage(200, 120, 40, 20));
tokens(first, usage(200, 120, 40, 20));
record("turn_context", { model: "model-b" });
tokens(usage(50, 50, 0, 0), usage(250, 170, 40, 20));
const [row] = collector.finish();
assert.equal(row.tokensIn, 40);
assert.equal(row.tokensCacheRead, 110);
assert.equal(row.tokensOut, 20);
assert.equal(row.tokensReasoning, 10);
assert.equal(row.messageCount, 2);
assert.equal(row.sessions, 1);
assert.equal(row.costMicros, 390);
assert.deepEqual(prices.map((p) => p.model), ["model-a", "model-b"]);
assert.equal(row.tokensIn + row.tokensOut + row.tokensCacheRead + row.tokensCacheWrite, 170);

visitor.startFile();
record("session_meta", { id: "unpriced", git: { repository_url: "https://github.com/example/unpriced.git" } });
tokens(first, first);
const unpriced = collector.finish().find((r) => r.repo === "unpriced");
assert.equal(unpriced.costMicros, 0, "a new file must not inherit the previous model");
assert.equal(unpriced.tokensIn, 40, "a new file must not inherit snapshot deduplication");
console.log("OK  Codex repo tokens, pricing and repeated snapshots");

// A session changes models: each model must keep its own spend and tools.
// Replayed records must not turn one call or response into two.
{
  const collector = new ModelActivityCollector({
    since: "2026-09-05", until: "2026-09-05",
    priceOf: (model, u) => model === "unpriced" ? 0 : (u.input_tokens ?? 0) * 2 + (u.output_tokens ?? 0) * 10 + (u.cache_read_input_tokens ?? 0),
  });
  const claude = collector.claude();
  const call = (id) => ({ type: "tool_use", id, get input() { throw new Error("read tool arguments"); } });
  const response = (model, id, content, input = 100) => ({
    type: "assistant", timestamp: "2026-09-05T12:00:00Z", sessionId: "one-session", requestId: id,
    message: { model, id, content, usage: { input_tokens: input, output_tokens: 20 } },
  });
  const a = response("model-a", "response-a", [call("tool-a")]);
  claude.record(a);
  claude.record(a);
  claude.record(response("model-b", "response-b", [call("tool-b1"), call("tool-b2")], 200));
  claude.record(response("model-b", "response-b", [call("tool-b2")]));
  claude.record(response("unpriced", "response-c", [], 10));
  claude.record({ ...a, timestamp: "2026-09-04T12:00:00Z" });
  const models = collector.finish();
  const ma = models.find((r) => r.model === "model-a");
  const mb = models.find((r) => r.model === "model-b");
  assert.equal(ma.costMicros, 400);
  assert.equal(ma.tokens, 120);
  assert.equal(ma.sessions, 1);
  assert.equal(ma.toolCalls, 1);
  assert.equal(mb.costMicros, 600);
  assert.equal(mb.sessions, 1);
  assert.equal(mb.toolCalls, 2);
  assert.equal(models.find((r) => r.model === "unpriced").unpricedMessages, 1);

  const codex = collector.codex();
  const send = (type, payload, date = "2026-09-05") => codex.record({ type, payload, timestamp: `${date}T12:00:00Z` });
  codex.startFile();
  send("session_meta", { id: "codex-session" });
  send("turn_context", { model: "model-a" }, "2026-09-04");
  const last = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, total_tokens: 120 };
  const snapshot = { type: "token_count", info: { last_token_usage: last, total_token_usage: last } };
  send("event_msg", snapshot, "2026-09-04");
  send("event_msg", snapshot);
  send("event_msg", { ...snapshot, info: { last_token_usage: last, total_token_usage: { ...last, total_tokens: 240 } } });
  send("event_msg", { type: "item_completed", item: { type: "CommandExecution", id: "c1" } });
  send("event_msg", { type: "item_completed", item: { type: "CommandExecution", id: "c1" } });
  send("turn_context", { model: "model-b" });
  send("event_msg", { type: "item_completed", item: { type: "McpToolCall", id: "c2" } });
  send("event_msg", { ...snapshot, info: { last_token_usage: last, total_token_usage: { ...last, total_tokens: 360 } } });
  const ca = collector.finish().find((r) => r.agent === "codex" && r.model === "model-a");
  const cb = collector.finish().find((r) => r.agent === "codex" && r.model === "model-b");
  assert.equal(ca.costMicros, 340);
  assert.equal(ca.tokens, 120);
  assert.equal(ca.toolCalls, 1);
  assert.equal(ca.sessions, 1);
  assert.equal(cb.costMicros, 340);
  assert.equal(cb.toolCalls, 1);
  assert.equal(cb.sessions, 1);
  console.log("OK  model attribution, model switches, missing prices and replay deduplication");
}

// Claude Code writes human messages in both string and content-block forms.
// Classify their shape without opening message text or tool output.
{
  const cwd = mkdtempSync(join(tmpdir(), "kibble-turns-"));
  try {
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const cases = [
      ["string", "synthetic", false],
      ["array", [{ type: "text", get text() { throw new Error("read message text"); } }], false],
      ["empty string", "", false],
      ["empty array", [], false],
      ["metadata", "synthetic", true],
      ["tool result", [{ type: "tool_result", get content() { throw new Error("read tool output"); } }], false],
    ];
    const turns = [];
    for (const [shape, content, isMeta] of cases) {
      const collector = new RepoCollector({ since: "2026-09-05", until: "2026-09-05" });
      const visitor = collector.claude();
      const common = { timestamp: "2026-09-05T12:00:00Z", cwd, sessionId: "turn-fixture" };
      visitor.record({ ...common, type: "user", isMeta, message: { role: "user", content } });
      visitor.record({
        ...common,
        type: "assistant",
        requestId: "turn-response",
        message: {
          role: "assistant",
          model: "fixture-model",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      turns.push([shape, collector.finish()[0].humanTurns]);
    }
    assert.deepEqual(turns, [
      ["string", 1],
      ["array", 1],
      ["empty string", 0],
      ["empty array", 0],
      ["metadata", 0],
      ["tool result", 0],
    ]);
    console.log("OK  Claude string and content-block human turns");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// A resumed or forked session can copy the same records into another file.
// Opaque record, response, tool and item ids collapse that replay, while two
// different blocks belonging to one response remain two blocks.
{
  const home = mkdtempSync(join(tmpdir(), "kibble-replay-"));
  try {
    const cwd = join(home, "fixture");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const options = {
      home,
      since: "2026-09-05",
      until: "2026-09-05",
      priceOf: () => 100,
    };
    const repos = new RepoCollector(options);
    const capabilities = new CapabilityCollector(options);
    const models = new ModelActivityCollector(options);
    const claudeVisitors = [repos.claude(), capabilities.visitor(), models.claude()];
    const tool = (id) => ({
      type: "tool_use",
      id,
      name: "mcp__fixture__read",
      get input() { throw new Error("read tool arguments"); },
    });
    const response = (uuid, content) => ({
      uuid,
      type: "assistant",
      timestamp: "2026-09-05T12:00:00Z",
      cwd,
      sessionId: "claude-replay",
      requestId: "claude-response",
      message: {
        role: "assistant",
        id: "claude-response",
        model: "fixture-model",
        content,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    });
    const claudeRecords = [
      response("claude-text", [{ type: "text", get text() { throw new Error("read message text"); } }]),
      response("claude-tool-1", [tool("tool-1")]),
      response("claude-tool-2", [tool("tool-2")]),
    ];
    for (let copy = 0; copy < 2; copy += 1) {
      for (const visitor of claudeVisitors) visitor.startFile?.();
      for (const rec of claudeRecords) for (const visitor of claudeVisitors) visitor.record(rec);
    }

    const codexVisitors = [repos.codex(), capabilities.codexVisitor(), models.codex()];
    const codexUsage = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 0, total_tokens: 100 };
    const codexRecords = [
      { type: "session_meta", payload: { id: "codex-replay", git: { repository_url: "https://github.com/example/fixture.git" } } },
      { type: "turn_context", payload: { turn_id: "turn-1", model: "fixture-model" } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: codexUsage, total_token_usage: codexUsage } } },
      { type: "event_msg", payload: { type: "item_completed", item: { id: "item-user", type: "UserMessage" } } },
      { type: "event_msg", payload: { type: "item_completed", item: { id: "item-mcp", type: "McpToolCall", server: "fixture" } } },
    ].map((rec) => ({ ...rec, timestamp: "2026-09-05T12:00:00Z" }));
    for (let copy = 0; copy < 2; copy += 1) {
      for (const visitor of codexVisitors) visitor.startFile?.();
      for (const rec of codexRecords) for (const visitor of codexVisitors) visitor.record(rec);
    }

    const repoRows = repos.finish();
    const claudeRepo = repoRows.find((row) => row.agent === "claude-code");
    const codexRepo = repoRows.find((row) => row.agent === "codex");
    assert.equal(claudeRepo.messageCount, 1);
    assert.equal(claudeRepo.costMicros, 100);
    assert.equal(claudeRepo.textBlocks, 1);
    assert.equal(claudeRepo.toolCalls, 2, "different blocks in one Claude response remain distinct");
    assert.equal(codexRepo.messageCount, 1);
    assert.equal(codexRepo.costMicros, 100);
    assert.equal(codexRepo.turns, 1);
    assert.equal(codexRepo.humanTurns, 1);
    assert.equal(codexRepo.toolCalls, 1);

    const capabilityRows = capabilities.finish().filter((row) => row.kind === "mcp" && row.name === "fixture");
    assert.equal(capabilityRows.find((row) => row.agent === "claude-code").invocations, 2);
    assert.equal(capabilityRows.find((row) => row.agent === "codex").invocations, 1);

    const modelRows = models.finish();
    const claudeModel = modelRows.find((row) => row.agent === "claude-code");
    const codexModel = modelRows.find((row) => row.agent === "codex");
    assert.deepEqual(
      { messages: claudeModel.messageCount, tools: claudeModel.toolCalls, cost: claudeModel.costMicros },
      { messages: 1, tools: 2, cost: 100 },
    );
    assert.deepEqual(
      { messages: codexModel.messageCount, tools: codexModel.toolCalls, cost: codexModel.costMicros },
      { messages: 1, tools: 1, cost: 100 },
    );
    console.log("OK  cross-file replay deduplication preserves distinct response blocks");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Both inventories keep every loadable alias for invocation lookup, while one
// resolved artifact produces one idle row and one copy of its description cost.
{
  const home = mkdtempSync(join(tmpdir(), "kibble-alias-"));
  try {
    const skillTarget = join(home, "skill-artifact");
    const commandTarget = join(home, "command-artifact.md");
    mkdirSync(skillTarget);
    writeFileSync(join(skillTarget, "SKILL.md"), "---\nname: fixture\ndescription: A fixture description with enough words to count.\n---\n");
    writeFileSync(commandTarget, "# Fixture\n");
    for (const [agentRoot, commandDir] of [[".claude", "commands"], [".codex", "prompts"]]) {
      const skills = join(home, agentRoot, "skills");
      const commands = join(home, agentRoot, commandDir);
      mkdirSync(skills, { recursive: true });
      mkdirSync(commands, { recursive: true });
      for (const alias of ["first", "second"]) {
        symlinkSync(skillTarget, join(skills, alias));
        symlinkSync(commandTarget, join(commands, `${alias}.md`));
      }
    }

    for (const inv of [inventory(home), codexInventory(home)]) {
      assert.equal(inv.skills.size, 2, "skill aliases remain loadable by name");
      assert.equal(inv.commands.size, 2, "command aliases remain loadable by name");
      assert.equal(new Set([...inv.skills.values()].map((entry) => entry.realPath)).size, 1);
      assert.equal(new Set([...inv.commands.values()].map((entry) => entry.realPath)).size, 1);
      assert.equal([...inv.skills.values()].filter((entry) => entry.alias).length, 1);
      assert.equal([...inv.commands.values()].filter((entry) => entry.alias).length, 1);
      assert.equal(new Set([...inv.skills.values()].map((entry) => entry.descriptionTokens)).size, 1);
    }

    const collector = new CapabilityCollector({ home, since: "2026-09-05", until: "2026-09-05" });
    collector.visitor().record({
      uuid: "claude-active",
      type: "user",
      timestamp: "2026-09-05T12:00:00Z",
      message: { role: "user", content: "synthetic" },
    });
    collector.codexVisitor().record({
      type: "turn_context",
      timestamp: "2026-09-05T12:00:00Z",
      payload: {},
    });
    const rows = collector.finish().filter((row) => row.kind === "skill" || row.kind === "command");
    for (const agent of ["claude-code", "codex"]) {
      const skills = rows.filter((row) => row.agent === agent && row.kind === "skill");
      const commands = rows.filter((row) => row.agent === agent && row.kind === "command");
      assert.equal(skills.length, 1, `${agent} emits one idle skill row per artifact`);
      assert.equal(commands.length, 1, `${agent} emits one idle command row per artifact`);
      assert.ok(skills[0].descriptionTokens > 0);
    }
    console.log("OK  Claude and Codex aliases emit one artifact and one description cost");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// A Codex file without a session id gets a file-local dedup scope. Identical
// counters and item ids inside one file collapse, while a second anonymous file
// represents a separate session and remains countable.
{
  const options = { since: "2026-09-05", until: "2026-09-05", priceOf: () => 100 };
  const repos = new RepoCollector(options);
  const capabilities = new CapabilityCollector(options);
  const models = new ModelActivityCollector(options);
  const visitors = [repos.codex(), capabilities.codexVisitor(), models.codex()];
  const usage = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 0, total_tokens: 100 };
  const records = [
    { type: "session_meta", payload: { git: { repository_url: "https://github.com/example/anonymous.git" } } },
    { type: "turn_context", payload: { turn_id: "same-turn", model: "fixture-model" } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } },
    { type: "event_msg", payload: { type: "item_completed", item: { id: "same-item", type: "McpToolCall", server: "fixture" } } },
    { type: "event_msg", payload: { type: "item_completed", item: { id: "same-item", type: "McpToolCall", server: "fixture" } } },
  ].map((record) => ({ ...record, timestamp: "2026-09-05T12:00:00Z" }));
  for (let file = 0; file < 2; file += 1) {
    for (const visitor of visitors) visitor.startFile?.();
    for (const record of records) for (const visitor of visitors) visitor.record(record);
  }
  const repo = repos.finish()[0];
  assert.deepEqual(
    { messages: repo.messageCount, tools: repo.toolCalls, turns: repo.turns, cost: repo.costMicros },
    { messages: 2, tools: 2, turns: 2, cost: 200 },
  );
  const capability = capabilities.finish().find((row) => row.agent === "codex" && row.kind === "mcp");
  assert.equal(capability.invocations, 2);
  const model = models.finish()[0];
  assert.deepEqual(
    { messages: model.messageCount, tools: model.toolCalls, cost: model.costMicros },
    { messages: 2, tools: 2, cost: 200 },
  );
  console.log("OK  anonymous Codex sessions deduplicate within each file only");
}

// Compactions must not double-count Codex's parallel history record, copied
// completed items, or Claude boundary records. Never inspect summary content.
{
  const options = { since: "2026-09-05", until: "2026-09-05", priceOf: () => 100 };
  const models = new ModelActivityCollector(options);
  const visit = models.codex();
  const stamp = (type, payload, date = "2026-09-05") => ({ type, payload, timestamp: `${date}T12:00:00Z` });
  const compacted = stamp("compacted", {});
  Object.defineProperty(compacted.payload, "message", { get() { throw new Error("compaction summary was read"); } });
  Object.defineProperty(compacted.payload, "replacement_history", { get() { throw new Error("history content was read"); } });
  const records = [
    stamp("session_meta", { id: "compacting-session" }),
    stamp("turn_context", { model: "before-window" }, "2026-09-04"),
    stamp("event_msg", { type: "item_completed", item: { type: "ContextCompaction", id: "old" } }, "2026-09-04"),
    stamp("turn_context", { model: "model-a" }),
    compacted,
    stamp("event_msg", { type: "item_completed", item: { type: "ContextCompaction", id: "compact-a" } }),
    stamp("turn_context", { model: "model-b" }),
    stamp("event_msg", { type: "item_completed", item: { type: "ContextCompaction", id: "compact-b" } }),
  ];
  for (let copy = 0; copy < 2; copy++) { visit.startFile(); for (const r of records) visit.record(r); }
  assert.deepEqual(models.finish().map(r => [r.model, r.compactions, r.toolCalls, r.sessions]), [["model-a", 1, 0, 1], ["model-b", 1, 0, 1]]);
  visit.startFile();
  visit.record(stamp("session_meta", { id: "unknown-model" }));
  visit.record(stamp("event_msg", { type: "item_completed", item: { type: "ContextCompaction", id: "no-model" } }));
  assert.equal(models.finish().reduce((n, r) => n + r.compactions, 0), 2, "a model must not leak from the preceding file");

  const claude = models.claude();
  const repoCollector = new RepoCollector(options);
  const repo = repoCollector.claude();
  const boundary = { type: "system", subtype: "compact_boundary", uuid: "boundary", sessionId: "claude-session", cwd: process.cwd(), timestamp: "2026-09-05T12:00:00Z" };
  Object.defineProperty(boundary, "content", { get() { throw new Error("Claude summary was read"); } });
  const context = { type: "assistant", sessionId: "claude-session", timestamp: "2026-09-04T12:00:00Z", message: { model: "claude-fixture" } };
  claude.startFile(); claude.record(context);
  for (let copy = 0; copy < 2; copy++) { claude.record(boundary); repo.record(boundary); }
  assert.equal(models.finish().find(r => r.model === "claude-fixture").compactions, 1);
  assert.equal(repoCollector.finish()[0].compactions, 1);
  console.log("OK  compactions stay model-scoped, count once and never read summaries");
}

// Missing Codex completion fields used to distort spend/tool averages and hide
// failures. Replay both event representations through the production collectors;
// content getters make accidental argument/output inspection a failing check.
{
  const home = mkdtempSync(join(tmpdir(), "kibble-codex-metrics-"));
  try {
    const options = { home, since: "2026-09-05", until: "2026-09-05", priceOf: (_model, u) => (u.input_tokens ?? 0) * 2 + (u.output_tokens ?? 0) * 10 + (u.cache_read_input_tokens ?? 0) };
    const repo = new RepoCollector(options), model = new ModelActivityCollector(options), capabilities = new CapabilityCollector(options);
    const visitors = [repo.codex(), model.codex(), capabilities.codexVisitor()];
    const guarded = (value) => {
      for (const field of ["arguments", "command", "input", "stdout", "stderr", "content", "source_path", "entries", "status_message"]) {
        Object.defineProperty(value, field, { get() { throw new Error(`read private ${field}`); } });
      }
      return value;
    };
    const event = (type, extra = {}) => ({ type: "event_msg", payload: { type, ...extra } });
    const item = (type, id, extra = {}) => event("item_completed", { item: guarded({ type, id, ...extra }) });
    const usage = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 120 };
    const records = [
      { type: "session_meta", payload: { id: "parity", cwd: join(home, "fixture"), git: { repository_url: "https://github.com/example/fixture.git" } } },
      event("thread_settings_applied", { thread_settings: { model: "model-a", reasoning_effort: "high", service_tier: "default" } }),
      event("task_started", { turn_id: "turn-a" }),
      { type: "turn_context", payload: { model: "model-a", turn_id: "turn-a" } },
      event("token_count", { info: { last_token_usage: usage, total_token_usage: usage } }),
      item("CommandExecution", "exec", { status: "failed", exit_code: 1, duration: { secs: 1, nanos: 500_000_000 } }),
      event("exec_command_end", guarded({ call_id: "exec", status: "failed", exit_code: 1, duration: { secs: 1, nanos: 500_000_000 } })),
      item("McpToolCall", "mcp", { server: "fixture", status: "failed", duration: { secs: 0, nanos: 500_000_000 } }),
      event("mcp_tool_call_end", { call_id: "mcp", invocation: guarded({ server: "fixture" }), result: { Err: "not read" }, duration: { secs: 0, nanos: 500_000_000 } }),
      item("FileChange", "edit", { status: "completed", changes: { "never-sent": { unified_diff: "@@ -1 +1,2 @@\n-old\n+new\n+newer" } } }),
      item("FileChange", "failed-edit", { status: "failed", changes: { "never-sent": { unified_diff: "@@ -1 +1 @@\n-old\n+new" } } }),
      item("Extension", "search", { kind: "web.search", durationMs: 250 }),
      item("DynamicToolCall", "dynamic", { tool: "lookup", status: "completed" }),
      item("ImageView", "image"),
      event("hook_completed", { run: guarded({ id: "hook", status: "failed" }) }),
      event("task_complete", guarded({ turn_id: "turn-a", duration_ms: 2500 })),
      // New settings are sufficient for model attribution without turn_context.
      event("thread_settings_applied", { thread_settings: { model: "model-b", reasoning_effort: "low" }, fixtureTime: "13:00:00" }),
      event("token_count", { info: { last_token_usage: usage, total_token_usage: { ...usage, total_tokens: 240 } } }),
      item("McpToolCall", "mcp-b", { server: "fixture", status: "completed" }),
    ];
    for (let replay = 0; replay < 2; replay++) {
      for (const v of visitors) v.startFile?.();
      for (const record of records) {
        const time = record.payload.fixtureTime ?? "12:00:00";
        for (const v of visitors) v.record({ ...record, timestamp: `2026-09-05T${time}Z` });
      }
    }
    const [row] = repo.finish();
    assert.equal(row.costMicros, 680);
    assert.equal(row.messageCount, 2);
    assert.equal(row.toolCalls, 8);
    assert.equal(row.toolErrors, 3);
    assert.equal(row.toolTimed, 3);
    assert.equal(row.toolDurationMs, 2250);
    assert.equal(row.turns, 1);
    assert.equal(row.turnDurationMs, 2500);
    assert.equal(row.turnDurationMsMax, 2500);
    assert.equal(row.edits, 1);
    assert.equal(row.linesAdded, 2);
    assert.equal(row.linesRemoved, 1);
    assert.equal(row.hookRuns, 1);
    assert.equal(row.hookErrors, 1);
    assert.equal(row.webSearchRequests, 1);
    const models = model.finish();
    assert.equal(models.find((r) => r.model === "model-a").toolCalls, 7);
    assert.equal(models.find((r) => r.model === "model-b").toolCalls, 1);
    assert.equal(models.find((r) => r.model === "model-b").costMicros, 340);
    assert.equal(capabilities.finish().find((r) => r.kind === "mcp").invocations, 2);
    console.log("OK  Codex settings, tool parity, timings, failures and legacy replay preserve counts without reading content");
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// Broken discovery silently marks installed Codex capabilities as absent. Only
// enabled plugins' active version and enabled real artifacts may be reported.
{
  const home = mkdtempSync(join(tmpdir(), "kibble-codex-inventory-"));
  try {
    const skill = (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: fixture\ndescription: Safe fixture description\n---\n");
    };
    const project = join(home, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    skill(join(project, ".agents/skills/project-skill"));
    skill(join(home, ".agents/skills/personal"));
    mkdirSync(join(home, ".agents/skills/empty-directory"), { recursive: true });
    skill(join(home, ".codex/skills/.system/bundled"));
    skill(join(home, ".codex/skills/disabled"));
    const plugin = (name, version, entry) => {
      const dir = join(home, ".codex/plugins/cache/fixture", name, version);
      skill(join(dir, "custom-skills", entry));
      mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
      writeFileSync(join(dir, ".codex-plugin/plugin.json"), JSON.stringify({ name, skills: "./custom-skills" }));
      return dir;
    };
    plugin("enabled", "1.9.0", "stale");
    plugin("enabled", "1.10.0", "active");
    plugin("disabled", "1.0.0", "hidden");
    plugin("local", "9.0.0", "stale");
    plugin("local", "local", "active");
    writeFileSync(join(home, ".codex/config.toml"), `
[plugins."enabled@fixture"]
enabled = true
[plugins."disabled@fixture"]
enabled = false
[plugins."local@fixture"]
enabled = true
[[skills.config]]
path = ${JSON.stringify(join(home, ".codex/skills/disabled/SKILL.md"))}
enabled = false
`);
    const inv = codexInventory(home, [join(project, "src")]);
    for (const name of ["project-skill", "personal", "bundled", "enabled:active", "local:active"]) assert(inv.skills.has(name), `missing ${name}`);
    for (const name of ["empty-directory", "disabled", "enabled:stale", "disabled:hidden", "local:stale"]) assert(!inv.skills.has(name), `unexpected ${name}`);
    const collector = new CapabilityCollector({ home, since: "2026-09-05", until: "2026-09-05" });
    const v = collector.codexVisitor();
    v.startFile();
    v.record({ type: "session_meta", payload: { id: "fixture", cwd: project } });
    v.record({ type: "turn_context", timestamp: "2026-09-05T12:00:00Z", payload: { model: "fixture" } });
    const rows = collector.finish();
    assert(rows.some((r) => r.agent === "codex" && r.name === "project-skill" && r.installed));
    assert(rows.every((r) => r.invocations === 0), "discovery cannot claim an invocation");
    console.log("OK  Codex project, personal, system and active plugin discovery excludes disabled and stale artifacts");
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// The native Codex parser counted repeated rate-limit snapshots as new spend.
// Exercise the production daily adapter and sidecars with identical raw files.
{
  const { TokscaleCoreSource } = await import('../dist/sources/tokscale-core.js');
  const { scanLocal } = await import('../dist/sources/local.js');
  const home = mkdtempSync(join(tmpdir(), 'kibble-codex-daily-'));
  try {
    const cwd = join(home, 'fixture');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const id = '11111111-1111-4111-8111-111111111111';
    const stem = `rollout-2026-09-05T12-00-00-${id}`;
    const event = (type, payload, date = '2026-09-05') => ({ type, payload, timestamp: `${date}T12:00:00Z` });
    const snapshot = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 5, total_tokens: 110 };
    const records = [
      event('session_meta', { id, cwd }),
      event('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'fixture-model' } }),
      event('event_msg', { type: 'token_count', info: { last_token_usage: snapshot, total_token_usage: snapshot } }),
      event('event_msg', { type: 'token_count', info: { last_token_usage: snapshot, total_token_usage: snapshot } }),
      event('event_msg', { type: 'item_completed', item: { id: 'call', type: 'CommandExecution', status: 'completed' } }),
    ];
    for (const dir of ['sessions', 'archived_sessions']) {
      mkdirSync(join(home, '.codex', dir), { recursive: true });
      writeFileSync(join(home, '.codex', dir, `${stem}.jsonl`), records.map(r => JSON.stringify(r)).join('\n'));
    }
    const price = u => u.input * 2 + u.output * 10 + u.cacheRead + u.cacheWrite * 3;
    const pricing = { async prefetch() {}, costMicros(_ref, u) { return price(u); } };
    const options = { home, since: '2026-09-05', until: '2026-09-05' };
    const daily = await new TokscaleCoreSource({ home, pricing }).collect(options);
    assert.equal(daily.daily.length, 1);
    assert.deepEqual(daily.daily[0], {
      date: '2026-09-05', agent: 'codex', model: 'fixture-model', provider: 'openai',
      tokensIn: 40, tokensOut: 10, tokensCacheRead: 40, tokensCacheWrite: 20,
      tokensReasoning: 5, messageCount: 1, costMicros: 280,
    });
    assert.deepEqual(daily.sessions, [{ sessionId: stem, agent: 'codex', date: '2026-09-05', messageCount: 1, costMicros: 280 }]);
    const local = scanLocal({ ...options, capabilities: false, priceOf(model, u, provider) {
      assert.equal(model, 'fixture-model'); assert.equal(provider, 'openai');
      return price({ input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens });
    } });
    assert.equal(local.repos[0].costMicros, 280);
    assert.equal(local.repos[0].tokensCacheWrite, 20);
    assert.equal(local.repos[0].messageCount, 1);
    assert.equal(local.modelActivity[0].tokens, 110);
    assert.equal(local.modelActivity[0].costMicros, 280);
    assert.equal(local.modelActivity[0].toolCalls, 1);
    console.log('OK  daily Codex adapter and shared sidecars agree on spend, cache writes and reasoning without replay or archive duplicates');
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// Claude's split response blocks, command markers and capability attribution
// must agree with repo/model spend, without inspecting arguments or tool output.
{
  const home = mkdtempSync(join(tmpdir(), 'kibble-claude-metrics-'));
  try {
    const cwd = join(home, 'fixture');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    const priceOf = (_model, u) => (u.input_tokens ?? 0) * 2 + (u.output_tokens ?? 0) * 10 + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 3;
    const options = { home, since: '2026-09-05', until: '2026-09-05', priceOf };
    const repo = new RepoCollector(options), model = new ModelActivityCollector(options), caps = new CapabilityCollector(options);
    const visitors = [repo.claude(), model.claude(), caps.visitor()];
    const forbidden = () => { throw new Error('read private Claude content'); };
    const tools = [
      { type: 'tool_use', id: 'skill', name: 'Skill', input: { skill: 'review', get args() { return forbidden(); } } },
      { type: 'tool_use', id: 'mcp', name: 'mcp__fixture__lookup', get input() { return forbidden(); } },
      { type: 'tool_use', id: 'edit', name: 'Edit', get input() { return forbidden(); } },
    ];
    const usage = { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30,
      output_tokens_details: { thinking_tokens: 5 }, cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 20 },
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 }, iterations: [{}, {}] };
    const assistant = (uuid, content, u = usage) => ({ uuid, type: 'assistant', requestId: 'response', attributionSkill: 'review',
      message: { id: 'response', role: 'assistant', model: 'fixture-model', content, usage: u } });
    const records = [
      { uuid: 'typed', type: 'user', message: { role: 'user', content: '<command-name>/review</command-name>' } },
      assistant('stream-start', [], { input_tokens: 0, output_tokens: 0 }),
      assistant('response-tools', tools),
      assistant('split-response', tools),
      { uuid: 'body', type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /fixture\nSynthetic fixture body' }] } },
      { uuid: 'mcp-result', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'mcp', is_error: true, get content() { return forbidden(); } }] },
        toolUseResult: { durationMs: 500, get stdout() { return forbidden(); } } },
      { uuid: 'edit-result', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit', get content() { return forbidden(); } }] },
        toolUseResult: { durationMs: 250, structuredPatch: [{ lines: ['-old', '+new', '+newer'] }], get filePath() { return forbidden(); } } },
      { uuid: 'turn', type: 'system', subtype: 'turn_duration', durationMs: 1000, messageCount: 3 },
      { uuid: 'hook', type: 'attachment', attachment: { type: 'hook_non_blocking_error', hookName: 'fixture', exitCode: 1, get content() { return forbidden(); } } },
    ];
    for (let replay = 0; replay < 2; replay++) {
      for (const v of visitors) v.startFile?.();
      for (const r of records) for (const v of visitors) v.record({ ...r, cwd, sessionId: 'claude-fixture', timestamp: '2026-09-05T12:00:00Z' });
    }
    const [row] = repo.finish(), [m] = model.finish();
    assert.equal(row.messageCount, 1); assert.equal(m.messageCount, 1);
    assert.equal(row.costMicros, 290); assert.equal(m.costMicros, 290);
    assert.equal(m.tokens, 100);
    assert.equal(row.toolCalls, 3); assert.equal(m.toolCalls, 3);
    assert.equal(row.toolErrors, 1); assert.equal(row.toolTimed, 2); assert.equal(row.toolDurationMs, 750);
    assert.equal(row.humanTurns, 1); assert.equal(row.turns, 1); assert.equal(row.turnDurationMs, 1000);
    assert.equal(row.turnMessages, 3); assert.equal(row.iterations, 2);
    assert.equal(row.edits, 1); assert.equal(row.hunks, 1); assert.equal(row.linesAdded, 2); assert.equal(row.linesRemoved, 1);
    assert.equal(row.hookRuns, 1); assert.equal(row.hookErrors, 1);
    assert.equal(row.tokensReasoning, 5); assert.equal(row.tokensCacheWrite1h, 10); assert.equal(row.tokensCacheWrite5m, 20);
    assert.equal(row.webSearchRequests, 1); assert.equal(row.webFetchRequests, 2);
    const capabilities = caps.finish(), skill = capabilities.find(r => r.kind === 'skill' && r.name === 'review');
    assert.equal(skill.invocations, 1); assert.equal(skill.triggerTyped, 1); assert.equal(skill.triggerModel, 0);
    assert(skill.contextTokens > 0);
    assert.equal(skill.attributedTurns, 1); assert.equal(skill.attributedTokens, 100); assert.equal(skill.attributedCostMicros, 290);
    assert.equal(capabilities.find(r => r.kind === 'command').invocations, 1);
    assert.equal(capabilities.find(r => r.kind === 'mcp').invocations, 1);
    console.log('OK  Claude spend, split blocks, capability attribution, timings, edits and replay preserve counts without reading arguments or output');
  } finally { rmSync(home, { recursive: true, force: true }); }
}

// A tool-only day must survive even when the last model response was yesterday.
{
  const options = { since: '2026-09-05', until: '2026-09-05' };
  const repos = new RepoCollector(options), models = new ModelActivityCollector(options);
  const vs = [repos.codex(), models.codex()];
  const records = [
    { type: 'session_meta', timestamp: '2026-09-04T23:59:00Z', payload: { id: 'midnight', git: { repository_url: 'https://github.com/example/midnight.git' } } },
    { type: 'turn_context', timestamp: '2026-09-04T23:59:00Z', payload: { model: 'fixture' } },
    { type: 'event_msg', timestamp: '2026-09-05T00:00:01Z', payload: { type: 'item_completed', item: { id: 'late-tool', type: 'CommandExecution', status: 'completed' } } },
  ];
  for (const v of vs) { v.startFile(); for (const r of records) v.record(r); }
  assert.equal(repos.finish()[0].messageCount, 0);
  assert.equal(repos.finish()[0].toolCalls, 1);
  assert.equal(models.finish()[0].toolCalls, 1);
  console.log('OK  tool-only activity survives the UTC day boundary');
}

// Codex explicit selections are structured names, not skill mentions or shell
// reads. Copied rollout items must not inflate adoption; paths/text stay private.
{
  const home = mkdtempSync(join(tmpdir(), 'kibble-codex-invocations-'));
  try {
    const project = join(home, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(project, '.agents/skills/audit'), { recursive: true });
    writeFileSync(join(project, '.agents/skills/audit/SKILL.md'), '---\nname: audit\ndescription: Fixture\n---\n');
    mkdirSync(join(home, '.codex/prompts'), { recursive: true });
    writeFileSync(join(home, '.codex/prompts/ship.md'), 'Fixture');
    const options = { home, since: '2026-09-05', until: '2026-09-05' };
    const collector = new CapabilityCollector(options);
    const visit = collector.codexVisitor();
    const secret = 'PRIVATE-ARGUMENT-AND-CONTENT';
    const forbidden = () => { throw new Error('read private Codex selection field'); };
    const select = () => ({ type: 'skill', name: 'audit', get path() { return forbidden(); } });
    const message = (id, content) => ({ type: 'event_msg', timestamp: '2026-09-05T12:00:00Z', payload: { type: 'item_completed', item: { type: 'UserMessage', id, content } } });
    const records = [
      { type: 'session_meta', payload: { id: 'invocation-session', cwd: project } },
      message('user-a', [select(), select(), { type: 'text', get text() { return forbidden(); } }, { type: 'mention', get name() { return forbidden(); }, get path() { return forbidden(); } }]),
      message('user-b', [select()]),
      message('invalid-name', [{ type: 'skill', name: '/private/path' }]),
      { type: 'event_msg', timestamp: '2026-09-05T12:00:00Z', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'shell', get command() { return forbidden(); } } } },
    ];
    for (let copy = 0; copy < 2; copy++) { visit.startFile(); for (const r of records) visit.record(r); }
    const history = collector.codexHistoryVisitor();
    const ts = Date.parse('2026-09-05T12:00:00Z') / 1000;
    const entries = [
      `/prompts:ship ${secret}`, `/prompts:ship ${secret}`, // two submissions in one second
      `/ship ${secret}`, '/status', `/prompts:retired ${secret}`,
      `explain /ship ${secret}`, `/Users/private/${secret}`, `/ship/${secret}`,
      `/unregistered ${secret}`, ` /status`, `/prompts:${'x'.repeat(129)}`, 42,
    ].map(text => ({ session_id: 'invocation-session', ts, text }));
    for (const entry of entries) history.record(entry);
    history.record({ ts: ts - 86400, get text() { return forbidden(); } });
    history.record({ ts: Number.MAX_VALUE, get text() { return forbidden(); } });
    const rows = collector.finish();
    const skill = rows.find(r => r.kind === 'skill' && r.name === 'audit');
    assert.equal(skill.invocations, 2); assert.equal(skill.triggerTyped, 2); assert.equal(skill.triggerModel, 0);
    assert.equal(skill.installed, true); assert.equal(skill.attributedTokens, 0); assert.equal(skill.attributedCostMicros, 0);
    const commands = rows.filter(r => r.kind === 'command');
    assert.deepEqual(commands.map(r => [r.name, r.invocations, r.triggerTyped]).sort(), [['retired', 1, 1], ['ship', 3, 3], ['status', 1, 1]]);
    assert.equal(commands.find(r => r.name === 'ship').installed, true);
    assert.equal(commands.find(r => r.name === 'retired').installed, false);
    assert(!JSON.stringify(rows).includes(secret));
    assert(!JSON.stringify(rows).includes(project));
    assert(!rows.some(r => r.name.includes('/')));

    // Exercise the real shared walk, including history once and archive replay.
    for (const dir of ['sessions', 'archived_sessions']) {
      mkdirSync(join(home, '.codex', dir), { recursive: true });
      writeFileSync(join(home, '.codex', dir, 'fixture.jsonl'), [records[0], message('user-a', [{ type: 'skill', name: 'audit', path: '/private' }]), message('user-b', [{ type: 'skill', name: 'audit', path: '/private' }])].map(r => JSON.stringify(r)).join('\n'));
    }
    writeFileSync(join(home, '.codex/history.jsonl'), entries.map(r => JSON.stringify(r)).join('\n'));
    const { scanLocal } = await import('../dist/sources/local.js');
    const scan = () => scanLocal({ ...options, repos: false }).capabilities;
    const scanned = scan();
    assert.deepEqual(scanned, rows);
    assert.deepEqual(scan(), scanned, 'a repeated scan must produce the same daily counts');
    assert.deepEqual(scanLocal({ ...options, repos: false, capabilities: false }).capabilities, [], 'disabled capability collection must omit both sources');
    console.log('OK  Codex skill selections and named history commands count once per observed invocation without sending paths, text or arguments');
  } finally { rmSync(home, { recursive: true, force: true }); }
}
