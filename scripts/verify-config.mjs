import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { configPath, loadConfig, saveConfig } from "../dist/config.js";

const root = fs.mkdtempSync(join(tmpdir(), "kibble-config-check-"));
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
const realFsync = fs.fsyncSync;
const realRename = fs.renameSync;
process.env.XDG_CONFIG_HOME = root;

const original = {
  server: "https://fixture.example",
  linkToken: "synthetic-original-credential",
  capabilities: true,
};
const replacement = {
  server: "https://replacement.example",
  linkToken: "synthetic-replacement-credential",
  autoCollect: true,
};

function restoreFs() {
  fs.readFileSync = realRead;
  fs.writeFileSync = realWrite;
  fs.fsyncSync = realFsync;
  fs.renameSync = realRename;
  syncBuiltinESMExports();
}

function onlyLiveConfigRemains() {
  assert.deepEqual(fs.readdirSync(dirname(configPath())), ["config.json"]);
}

function thrown(fn, pattern) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof Error, "expected operation to throw");
  assert.match(caught.message, pattern);
  return caught;
}

try {
  assert.deepEqual(loadConfig(), { server: "https://app.usekibble.com" });
  saveConfig(original);
  assert.deepEqual(loadConfig(), original);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
  }

  let duringWrite;
  fs.writeFileSync = (path, data, options) => {
    realWrite(path, data, options);
    duringWrite = loadConfig();
  };
  syncBuiltinESMExports();
  saveConfig(replacement);
  restoreFs();
  assert.deepEqual(duringWrite, original, "readers must see the old complete config during a write");
  assert.deepEqual(loadConfig(), replacement);
  onlyLiveConfigRemains();

  saveConfig(original);
  fs.writeFileSync = (path, data, options) => {
    realWrite(path, data, options);
    throw new Error("synthetic write interruption");
  };
  syncBuiltinESMExports();
  assert.throws(() => saveConfig(replacement), /synthetic write interruption/);
  restoreFs();
  assert.deepEqual(loadConfig(), original, "a write failure must preserve the previous config");
  onlyLiveConfigRemains();

  fs.fsyncSync = () => {
    throw new Error("synthetic flush interruption");
  };
  syncBuiltinESMExports();
  assert.throws(() => saveConfig(replacement), /synthetic flush interruption/);
  restoreFs();
  assert.deepEqual(loadConfig(), original, "a flush failure must preserve the previous config");
  onlyLiveConfigRemains();

  fs.renameSync = () => {
    throw new Error("synthetic rename interruption");
  };
  syncBuiltinESMExports();
  assert.throws(() => saveConfig(replacement), /synthetic rename interruption/);
  restoreFs();
  assert.deepEqual(loadConfig(), original, "a rename failure must preserve the previous config");
  onlyLiveConfigRemains();

  assert.throws(
    () => saveConfig({ server: 42 }),
    /field "server" must be a string/,
  );
  assert.deepEqual(loadConfig(), original, "invalid save input must preserve the previous config");
  onlyLiveConfigRemains();

  realWrite(configPath(), '{"linkToken":"synthetic-secret-value"');
  const malformed = thrown(() => loadConfig(), /not valid JSON/);
  assert.equal(malformed.message.includes("synthetic-secret-value"), false);

  realWrite(configPath(), JSON.stringify({ server: "https://fixture.example", capabilities: "yes" }));
  assert.throws(() => loadConfig(), /field "capabilities" must be a boolean/);

  fs.readFileSync = (path, options) => {
    if (path !== configPath()) return realRead(path, options);
    const error = new Error("synthetic-secret-value");
    error.code = "EACCES";
    throw error;
  };
  syncBuiltinESMExports();
  const unreadable = thrown(() => loadConfig(), /Could not read Kibble config.*EACCES/);
  assert.equal(unreadable.message.includes("synthetic-secret-value"), false);
} finally {
  restoreFs();
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("OK  config writes atomically and reports existing invalid files");

// A recorder install must preserve other hooks, and only normalized metadata
// may survive receiving a hook containing private content and credentials.
{
  const home = fs.mkdtempSync(join(tmpdir(), "kibble-cursor-hook-check-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousEntry = process.argv[1];
  const originalLog = console.log;
  process.env.XDG_CONFIG_HOME = join(home, "config space");
  process.argv[1] = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  console.log = () => {};
  try {
    const { cursorInstall, cursorUninstall } = await import("../dist/commands/cursor.js");
    const path = join(home, ".cursor/hooks.json");
    fs.mkdirSync(dirname(path), { recursive: true });
    const other = { command: "existing-hook", timeout: 5 };
    fs.writeFileSync(path, JSON.stringify({ version: 1, hooks: { stop: [other], sessionStart: [other] } }));
    cursorInstall(home);
    cursorInstall(home);
    const hooksMtime = fs.statSync(path).mtimeMs;
    cursorInstall(home);
    assert.equal(fs.statSync(path).mtimeMs, hooksMtime, "repair of a current installation must not rewrite Cursor hooks");
    const installed = JSON.parse(fs.readFileSync(path, "utf8"));
    assert.equal(installed.hooks.stop.length, 2);
    assert.equal(installed.hooks.postToolUse.length, 1);
    assert.equal(installed.hooks.postToolUseFailure.length, 1);
    assert.equal(installed.hooks.beforeSubmitPrompt.length, 1);
    assert.equal(installed.hooks.subagentStop.length, 1);
    assert.deepEqual(installed.hooks.stop[0], other);
    assert.deepEqual(installed.hooks.sessionStart, [other]);
    const sample = {
      hook_event_name: "stop", conversation_id: "00000000-0000-0000-0000-000000000001",
      generation_id: "00000000-0000-0000-0000-000000000002", model: "gpt-5",
      input_tokens: 100, cache_read_tokens: 60, cache_write_tokens: 10, output_tokens: 5,
      text: "PRIVATE_CONTENT_SENTINEL", user_email: "PRIVATE_EMAIL_SENTINEL",
      transcript_path: "/private/PRIVATE_PATH_SENTINEL", tool_input: { token: "PRIVATE_TOKEN_SENTINEL" },
    };
    // Execute the installed shell command itself, including the pinned config
    // path with spaces. No Cursor session or external request is needed.
    const run = input => spawnSync(installed.hooks.stop[1].command, {
      shell: true, input, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, CI: "1", KIBBLE_NO_UPDATE: "1" },
    });
    const recorded = run(JSON.stringify(sample));
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(recorded.stdout.trim(), "{}");
    const usagePath = join(process.env.XDG_CONFIG_HOME, "kibble/cursor-usage.jsonl");
    const raw = fs.readFileSync(usagePath, "utf8");
    assert(!raw.includes("PRIVATE_"));
    assert.equal(JSON.parse(raw).tokensIn, 30);
    const activityPath = join(process.env.XDG_CONFIG_HOME, "kibble/cursor-activity.jsonl");
    assert(!fs.readFileSync(activityPath, "utf8").includes("PRIVATE_"));
    const prompt = run(JSON.stringify({ ...sample, hook_event_name: "beforeSubmitPrompt", prompt: "PRIVATE_PROMPT_SENTINEL" }));
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.equal(prompt.stdout.trim(), "{}");
    assert(!fs.readFileSync(activityPath, "utf8").includes("PRIVATE_"));
    assert.equal(fs.readFileSync(usagePath, "utf8"), raw, "prompt callbacks cannot become token usage");
    const invalidActivity = run(JSON.stringify({ ...sample, cursor_version: "PRIVATE_INVALID_VERSION" }));
    assert.equal(invalidActivity.status, 0);
    assert(!invalidActivity.stderr.includes("PRIVATE_"));
    assert.equal(fs.readFileSync(usagePath, "utf8"), raw + raw, "unsupported optional activity cannot discard valid usage");
    fs.writeFileSync(usagePath, raw);
    const invalidTokens = run(JSON.stringify({ ...sample, input_tokens: -1, generation_id: "00000000-0000-0000-0000-000000000004" }));
    assert.equal(invalidTokens.status, 0);
    assert.equal(fs.readFileSync(usagePath, "utf8"), raw);
    assert(fs.readFileSync(activityPath, "utf8").includes("00000000-0000-0000-0000-000000000004"), "unsupported usage cannot discard valid activity");
    const child = run(JSON.stringify({ ...sample, hook_event_name: "subagentStop", subagent_id: "call_child-1\nnamespace_child", message_count: 12, duration_ms: 4200.25, tool_call_count: 8, summary: "PRIVATE_SUBAGENT_SENTINEL", modified_files: ["/PRIVATE_FILE_SENTINEL"] }));
    assert.equal(child.status, 0, child.stderr);
    assert(!fs.readFileSync(activityPath, "utf8").includes("PRIVATE_"));
    assert.equal(fs.readFileSync(usagePath, "utf8"), raw, "child activity cannot add overlapping token counters");
    if (process.platform !== "win32") assert.equal(fs.statSync(usagePath).mode & 0o777, 0o600);
    const malformed = run('{"text":"PRIVATE_MALFORMED_SENTINEL"');
    assert.equal(malformed.status, 0);
    assert.equal(malformed.stdout.trim(), "{}");
    assert(!malformed.stderr.includes("PRIVATE_"));
    assert.equal(fs.readFileSync(usagePath, "utf8"), raw);
    const toolRecord = run(JSON.stringify({ ...sample, hook_event_name: "postToolUse", tool_use_id: "tool-1", tool_name: "MCP:PRIVATE_SERVER_SENTINEL", duration: 42 }));
    assert.equal(toolRecord.status, 0, toolRecord.stderr);
    assert.equal(toolRecord.stdout.trim(), "{}");
    const toolsPath = join(process.env.XDG_CONFIG_HOME, "kibble/cursor-tools.jsonl");
    const toolRaw = fs.readFileSync(toolsPath, "utf8");
    assert(!toolRaw.includes("PRIVATE_"));
    assert.equal(JSON.parse(toolRaw).toolName, "MCP");
    assert.equal(JSON.parse(toolRaw).durationMs, 42);
    assert.equal(fs.readFileSync(usagePath, "utf8"), raw, "tool callbacks cannot become token usage");
    fs.writeFileSync(configPath(), JSON.stringify({ server: "https://fixture.example", capabilities: false }));
    const disabled = run(JSON.stringify({ ...sample, generation_id: "00000000-0000-0000-0000-000000000003", cwd: home }));
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(fs.existsSync(join(process.env.XDG_CONFIG_HOME, "kibble/cursor-inventory")), false, "policy-off recording cannot inspect or persist project capabilities");
    const retainedUsage = fs.readFileSync(usagePath, "utf8");
    cursorUninstall(home);
    assert.deepEqual(JSON.parse(fs.readFileSync(path, "utf8")), { version: 1, hooks: { stop: [other], sessionStart: [other] } });
    assert.equal(fs.readFileSync(usagePath, "utf8"), retainedUsage, "uninstall must retain counts");
    assert.equal(fs.readFileSync(toolsPath, "utf8"), toolRaw, "uninstall must retain tool counts");
    fs.writeFileSync(path, '{"secret":"PRIVATE_CONFIG_SENTINEL"');
    assert.throws(() => cursorInstall(home), /Invalid Cursor hook configuration/);
    assert.equal(fs.readFileSync(path, "utf8"), '{"secret":"PRIVATE_CONFIG_SENTINEL"');
  } finally {
    console.log = originalLog;
    process.argv[1] = previousEntry;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log("OK  Cursor recorder preserves other hooks, retains only counts and never logs hook content");
}

// Lost or duplicated activity must not distort observed turn timing or survive
// corruption. Exercise the production decoder, frozen source and repo sidecar.
{
  const home = fs.mkdtempSync(join(tmpdir(), "kibble-cursor-activity-check-"));
  try {
    const { normalizeCursorActivity, readCursorActivity } = await import("../dist/sources/cursor-activity.js");
    const { CursorSource } = await import("../dist/sources/cursor.js");
    const { scanLocal } = await import("../dist/sources/local.js");
    fs.mkdirSync(join(home, ".git"));
    const input = { hook_event_name: "beforeSubmitPrompt", conversation_id: "00000000-0000-0000-0000-000000000001", generation_id: "00000000-0000-0000-0000-000000000002", model: "gpt-5", cwd: home, cursor_version: "3.19.13", prompt: "PRIVATE_ACTIVITY_SENTINEL" };
    const start = normalizeCursorActivity(input, new Date("2026-09-07T12:00:00Z"));
    const stop = normalizeCursorActivity({ ...input, hook_event_name: "stop", status: "aborted" }, new Date("2026-09-07T12:00:02.625Z"));
    const path = join(home, "cursor-activity.jsonl");
    const write = rows => fs.writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    write([start, stop, { ...start, observedMs: start.observedMs + 1000 }, { ...stop, observedMs: stop.observedMs + 1000 }]);
    const events = readCursorActivity(path);
    assert.equal(events.length, 2, "replayed event receipts count once");
    assert.equal(events[1].durationMs, 2625);
    const loop = normalizeCursorActivity({ ...input, hook_event_name: "stop", generation_id: "00000000-0000-0000-0000-000000000003", status: "completed", loop_count: 1 }, new Date("2026-09-07T12:00:04Z"));
    assert.equal(loop.event, "stop", "automatic followup generations still establish completed activity");
    write([start, stop, loop, { ...loop, observedMs: loop.observedMs + 1000 }]);
    const loops = readCursorActivity(path);
    assert.equal(loops.length, 3, "a repeated followup generation counts once");
    assert.equal(loops[2].durationMs, null, "followup stop cannot pair with another generation's submission");
    write([start, stop]);
    const source = new CursorSource({ home, path: join(home, "cursor-usage.jsonl") });
    const range = { since: "2026-09-07", until: "2026-09-07" };
    const frozen = source.activitySnapshot(range);
    const local = scanLocal({ ...range, home, cursorActivity: frozen, capabilities: false });
    const row = local.repos.find(row => row.agent === "cursor");
    assert.equal(row.turns, 1);
    assert.equal(row.turnDurationMs, 2625);
    assert.equal(row.interrupted, 1);
    assert.equal(row.messageCount, 0, "completed generations do not establish model response counts");
    assert.equal((await source.collect(range)).sessions.length, 1, "activity-only generations still establish sessions");
    assert(!fs.readFileSync(path, "utf8").includes("PRIVATE_"));
    write([start, { ...stop, observedMs: start.observedMs - 1 }]);
    assert.equal(readCursorActivity(path)[1].durationMs, null, "backwards clocks cannot establish duration");
    assert.equal(source.activitySnapshot(range)[1].durationMs, 2625, "same-run snapshot cannot change with later writes");
    const child = normalizeCursorActivity({ ...input, hook_event_name: "subagentStop", subagent_id: "call_child-1", message_count: 12, duration_ms: 4200.25, tool_call_count: 8, status: "completed", summary: "PRIVATE_CHILD_SENTINEL" }, new Date("2026-09-07T12:00:03Z"));
    write([start, stop, child, { ...child, observedMs: child.observedMs + 1000 }]);
    const withChild = readCursorActivity(path);
    assert.equal(withChild.length, 3);
    assert.equal(withChild[2].subagentDurationMs, 4200);
    assert.equal(withChild[2].durationMs, null, "child duration cannot be confused with a parent turn");
    const childRow = scanLocal({ ...range, home, cursorActivity: withChild, capabilities: false }).repos.find(row => row.agent === "cursor");
    assert.equal(childRow.sidechainMessages, 12);
    assert.equal(childRow.turns, 1);
    assert.equal(childRow.turnDurationMs, 2625);
    assert.equal(childRow.messageCount, 0);
    assert.equal(childRow.toolCalls, 0, "child aggregate tool counts cannot duplicate individual tool callbacks");
    assert.equal(childRow.tokensIn, 0);
    assert(!fs.readFileSync(path, "utf8").includes("PRIVATE_"));
    const compoundPayload = { ...input, hook_event_name: 'subagentStop', subagent_id: 'call_child-1\nnamespace_child', message_count: 0, duration_ms: 72211, status: 'completed' };
    const compoundChild = normalizeCursorActivity(compoundPayload, new Date('2026-09-07T12:02:00Z'));
    const anotherChild = normalizeCursorActivity({ ...compoundPayload, subagent_id: 'call_child-1\nnamespace_other' }, new Date('2026-09-07T12:02:00Z'));
    assert.notEqual(compoundChild.subagentId, anotherChild.subagentId);
    write([compoundChild, compoundChild, anotherChild]);
    assert.equal(readCursorActivity(path).length, 2, 'compound child completions survive replay without merging namespaces');
    assert(!fs.readFileSync(path, 'utf8').includes('namespace_child'));
    for (const subagent_id of ['a\n', 'a\r\nb', compoundChild.subagentId]) {
      assert.throws(() => normalizeCursorActivity({ ...compoundPayload, subagent_id }), /Invalid Cursor activity/);
    }
    write([{ ...compoundChild, subagentId: compoundPayload.subagent_id }]);
    assert.throws(() => readCursorActivity(path), /complete Cursor activity/);
    write([child, { ...child, repo: "different-repo" }]);
    assert.throws(() => readCursorActivity(path), /Conflicting Cursor activity/);
    write([{ ...child, summary: "PRIVATE_UNEXPECTED_FIELD" }]);
    assert.throws(() => readCursorActivity(path), /complete Cursor activity/);
    write([start, { ...start, model: "different" }]);
    assert.throws(() => readCursorActivity(path), /Conflicting Cursor activity/);
    fs.writeFileSync(path, JSON.stringify(start));
    assert.throws(() => readCursorActivity(path), /complete Cursor activity/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  console.log("OK  Cursor activity pairs observed turns, deduplicates retries and rejects corrupt metadata");
}

await import("./verify-cursor-store.mjs");
