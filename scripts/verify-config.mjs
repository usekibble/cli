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

// Prevent lost/duplicated explicit selections and content disclosure in binary metadata.
{
  const { readCursorAgentMetadata } = await import("../dist/sources/cursor-agent-metadata.js");
  const vi = value => {
    let n = BigInt(value);
    const bytes = [];
    while (n > 127n) { bytes.push(Number(n & 127n) | 128); n >>= 7n; }
    bytes.push(Number(n));
    return Buffer.from(bytes);
  };
  const scalar = (tag, value) => Buffer.concat([vi(tag * 8), vi(value)]);
  const data = (tag, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return Buffer.concat([vi(tag * 8 + 2), vi(bytes.length), bytes]);
  };
  const message = (...parts) => Buffer.concat(parts);
  const conversationId = "00000000-0000-0000-0000-000000000001";
  const turnPointer = Buffer.alloc(32, 1), userPointer = Buffer.alloc(32, 2);
  const key = pointer => `agentKv:blob:${pointer.toString("hex")}`;
  // Invalid UTF-8 in content must remain bytes, never decoded or interpreted.
  const poison = Buffer.from([0xff, 0xfe, 0xc0, 0x80]);
  const command = data(12, message(data(1, "review"), data(2, poison)));
  const skill = data(10, data(1, message(data(1, "/fixture/.cursor/skills/audit/SKILL.md"), data(2, poison), data(3, data(4, Buffer.alloc(0))))));
  const nonSkill = data(10, data(1, message(data(1, "/fixture/.cursor/rules/project.mdc"), data(3, data(4, Buffer.alloc(0))))));
  const automaticSkill = data(10, data(1, message(data(1, "/fixture/.cursor/skills/automatic/SKILL.md"), data(3, data(3, poison)))));
  const user = message(data(1, poison), data(2, "message-1"), data(3, message(command, command, skill, nonSkill, automaticSkill)), scalar(25, 1000), scalar(26, 2000));
  const turn = data(1, message(data(1, userPointer), data(3, "request-1")));
  const state = message(data(1, Buffer.alloc(32, 99)), data(8, turnPointer), data(8, turnPointer), data(35, poison));
  const store = new Map([[key(turnPointer), turn], [key(userPointer), user]]);
  const calls = [];
  const read = k => { calls.push(k); return store.get(k) ?? null; };
  const rows = readCursorAgentMetadata([{ conversationId, state }, { conversationId, state }], read);
  assert.deepEqual(rows, [{ conversationId, messageId: "message-1", requestId: "request-1", startedAtMs: 1000, completedAtMs: 2000, commands: ["review"], skillPaths: ["/fixture/.cursor/skills/audit/SKILL.md"] }]);
  assert.equal(calls.length, 2, "repeated pointers must not reread blobs or duplicate selection counts");
  assert.deepEqual(readCursorAgentMetadata([{ conversationId, state: Buffer.alloc(0) }], read), []);
  const fail = /Could not read complete Cursor selection metadata/;
  assert.throws(() => readCursorAgentMetadata([{ conversationId, state }], () => null), fail);
  assert.throws(() => readCursorAgentMetadata([{ conversationId, state: data(8, Buffer.alloc(31)) }], read), fail);
  assert.throws(() => readCursorAgentMetadata([{ conversationId, state }], k => k === key(userPointer) ? Buffer.from([0x12, 0xff]) : turn), fail);
  assert.throws(() => readCursorAgentMetadata([{ conversationId, state }], () => { throw new Error("PRIVATE_DATABASE_SENTINEL"); }), error => fail.test(error.message) && !error.message.includes("PRIVATE"));
  assert.throws(() => readCursorAgentMetadata([{ conversationId, state }], k => k === key(userPointer) ? message(data(2, poison)) : turn), fail);
  assert.throws(() => readCursorAgentMetadata([{ conversationId, state: Buffer.alloc(8 * 1024 * 1024 + 1) }], read), fail);
  const conflictPointer = Buffer.alloc(32, 3), conflictUserPointer = Buffer.alloc(32, 4);
  store.set(key(conflictPointer), data(1, message(data(1, conflictUserPointer), data(3, "different-request"))));
  store.set(key(conflictUserPointer), user);
  assert.throws(() => readCursorAgentMetadata([{ conversationId, state: message(data(8, turnPointer), data(8, conflictPointer)) }], read), fail);
  store.set(key(userPointer), message(user, scalar(5, 1)));
  assert.deepEqual(readCursorAgentMetadata([{ conversationId, state }], read), [], "simulated followups cannot count as explicit human selections");
  // The production store must see uncheckpointed WAL data, never create a
  // missing database, and feed name-only, replay-safe capability reporting.
  const { default: Database } = await import("libsql");
  const { readCursorSelections } = await import("../dist/sources/cursor-store.js");
  const { CapabilityCollector } = await import("../dist/sources/capabilities.js");
  const { scanLocal } = await import("../dist/sources/local.js");
  const fixtureHome = fs.mkdtempSync(join(tmpdir(), "kibble-cursor-selection # "));
  const appData = process.platform === "darwin" ? join(fixtureHome, "Library", "Application Support")
    : process.platform === "win32" ? join(fixtureHome, "AppData", "Roaming") : join(fixtureHome, ".config");
  const databasePath = join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  let database;
  try {
    const missing = join(fixtureHome, "missing.vscdb");
    assert.deepEqual(readCursorSelections(missing), []);
    assert.equal(fs.existsSync(missing), false);
    const skillPath = join(fixtureHome, ".cursor", "skills", "audit", "SKILL.md");
    fs.mkdirSync(dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, "---\ndescription: Fixture\n---\nPRIVATE_SKILL_BODY");
    const selectedSkill = data(10, data(1, message(data(1, skillPath), data(3, data(4, Buffer.alloc(0))))));
    const selectedUser = message(data(1, poison), data(2, "message-1"), data(3, message(command, command, selectedSkill)), scalar(25, Date.parse("2026-09-07T00:00:00Z")));
    const mcpPointer = Buffer.alloc(32, 5);
    const mcpId = "call-1\nnamespace-1";
    const mcpArgs = message(data(2, poison), data(3, mcpId), data(4, "fixture-mcp"), data(9, "PRIVATE_SERVER_IDENTIFIER"));
    const mcpStep = data(2, message(data(15, message(data(1, mcpArgs), data(2, poison))), data(57, mcpId), scalar(60, Date.parse("2026-09-07T00:00:01Z"))));
    const mcpTurn = data(1, message(data(1, userPointer), data(2, mcpPointer), data(2, mcpPointer), data(3, "request-1")));
    fs.mkdirSync(dirname(databasePath), { recursive: true });
    database = new Database(databasePath);
    assert.deepEqual(readCursorSelections(databasePath), [], "a fresh Cursor database has no graph yet");
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
    const insert = database.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
    insert.run(`composerData:${conversationId}`, JSON.stringify({ conversationState: `~${state.toString("base64")}`, text: "PRIVATE_PROMPT" }));
    insert.run("composerData:draft", JSON.stringify({ conversationState: "~" }));
    insert.run(key(turnPointer), mcpTurn);
    insert.run(key(mcpPointer), mcpStep);
    insert.run(key(userPointer), selectedUser);
    assert.ok(fs.statSync(`${databasePath}-wal`).size > 0);
    const projected = readCursorSelections(databasePath);
    assert.equal(projected.length, 1);
    assert.equal(projected[0].mcpCalls?.length, 1, "replayed completed MCP step counts once");
    const collector = new CapabilityCollector({ home: fixtureHome, since: "2026-09-07", until: "2026-09-07" });
    for (const row of [...projected, ...projected]) collector.addCursorSelection(row);
    collector.addCursorSelection({ ...projected[0], messageId: "old", startedAtMs: 1000 });
    collector.addCursorSelection({ ...projected[0], messageId: "undated", startedAtMs: undefined });
    const capabilities = collector.finish().filter(row => row.agent === "cursor");
    assert.equal(capabilities.find(row => row.kind === "skill" && row.name === "audit")?.invocations, 1);
    assert.equal(capabilities.find(row => row.kind === "command" && row.name === "review")?.triggerTyped, 1);
    assert.equal(capabilities.find(row => row.kind === "mcp" && row.name === "fixture-mcp")?.invocations, 1);
    assert.ok(capabilities.every(row => row.attributedTokens === 0 && row.attributedCostMicros === 0 && row.triggerModel === 0));
    assert.ok(!JSON.stringify(capabilities).includes(fixtureHome) && !JSON.stringify(capabilities).includes("PRIVATE"));
    assert.ok(!JSON.stringify(projected).includes("PRIVATE"), "MCP args, results and scoped server identifiers stay undecoded");
    assert.deepEqual(collector.finish().filter(row => row.agent === "cursor"), capabilities);
    const scanOptions = { home: fixtureHome, since: "2026-09-07", until: "2026-09-07", repos: false };
    assert.deepEqual(scanLocal(scanOptions).capabilities.filter(row => row.agent === "cursor"), capabilities);
    assert.throws(() => collector.addCursorSelection({ ...projected[0], commands: ["different"] }), /Conflicting Cursor selection/);
    assert.throws(() => collector.addCursorSelection({ ...projected[0], mcpCalls: [{ ...projected[0].mcpCalls[0], name: "different-server" }] }), /Conflicting Cursor MCP/);
    const replace = database.prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?");
    replace.run(data(2, message(data(15, data(1, mcpArgs)), data(57, mcpId))), key(mcpPointer));
    assert.equal(readCursorSelections(databasePath)[0].mcpCalls, undefined, "pending MCP calls must not count as completed usage");
    replace.run(data(2, message(data(15, message(data(1, mcpArgs), data(2, poison))), data(57, "conflicting-id"), scalar(60, Date.parse("2026-09-07T00:00:01Z")))), key(mcpPointer));
    assert.throws(() => readCursorSelections(databasePath), /Cursor/, "conflicting call identities must not merge usage");
    replace.run(mcpStep, key(mcpPointer));
    replace.run(message(selectedUser, scalar(5, 1)), key(userPointer));
    const simulated = readCursorSelections(databasePath)[0];
    assert.equal(simulated.mcpCalls.length, 1);
    assert.deepEqual(simulated.commands, [], "simulated followups retain tools but cannot fabricate user selections");
    assert.deepEqual(simulated.skillPaths, []);
    // Cursor forks retain parent history. Standalone child composers must not
    // turn inherited selections and immutable MCP steps into new usage.
    const childId = "00000000-0000-0000-0000-000000000002";
    replace.run(selectedUser, key(userPointer));
    const parentWithChild = message(state, data(16, message(data(1, childId), data(2, scalar(2, 1000)))));
    replace.run(JSON.stringify({ conversationState: `~${parentWithChild.toString("base64")}` }), `composerData:${conversationId}`);
    insert.run(`composerData:${childId}`, JSON.stringify({ conversationState: `~${state.toString("base64")}` }));
    const forked = readCursorSelections(databasePath);
    const child = forked.find(row => row.conversationId === childId);
    assert.deepEqual(child?.commands ?? [], [], "child context cannot establish a fresh human command selection");
    assert.deepEqual(child?.skillPaths ?? [], [], "child context cannot establish a fresh human skill selection");
    assert.deepEqual(scanLocal(scanOptions).capabilities.filter(row => row.agent === "cursor"), capabilities, "a child fork must not duplicate parent capability usage");
    const childStepPointer = Buffer.alloc(32, 6), childTurnPointer = Buffer.alloc(32, 7), childStatePointer = Buffer.alloc(32, 8);
    const childArgs = message(data(3, "new-child-call"), data(4, "fixture-mcp"));
    const childStep = data(2, message(data(15, message(data(1, childArgs), data(2, poison))), data(57, "new-child-call"), scalar(60, Date.parse("2026-09-07T00:00:02Z"))));
    insert.run(key(childStepPointer), childStep);
    insert.run(key(childTurnPointer), data(1, message(data(1, userPointer), data(2, mcpPointer), data(2, childStepPointer))));
    insert.run(key(childStatePointer), scalar(2, 1000));
    replace.run(JSON.stringify({ conversationState: `~${data(8, childTurnPointer).toString("base64")}` }), `composerData:${childId}`);
    replace.run(JSON.stringify({ conversationState: `~${message(state, data(31, message(data(1, childId), data(2, childStatePointer)))).toString("base64")}` }), `composerData:${conversationId}`);
    const childCapabilities = scanLocal(scanOptions).capabilities.filter(row => row.agent === "cursor");
    assert.equal(childCapabilities.find(row => row.kind === "mcp")?.invocations, 2, "new child calls count beside shared inherited calls");
    assert.equal(childCapabilities.find(row => row.kind === "skill")?.triggerTyped, 1);
    assert.equal(childCapabilities.find(row => row.kind === "command")?.triggerTyped, 1);
    // The same child history may exist only inline or behind a blob reference.
    const childState = data(8, childTurnPointer);
    replace.run(data(1, childState), key(childStatePointer));
    database.prepare("DELETE FROM cursorDiskKV WHERE key = ?").run(`composerData:${childId}`);
    assert.deepEqual(scanLocal(scanOptions).capabilities.filter(row => row.agent === "cursor"), childCapabilities, "referenced-only child history must not disappear");
    const inlineParent = message(state, data(16, message(data(1, childId), data(2, data(1, childState)))));
    replace.run(JSON.stringify({ conversationState: `~${inlineParent.toString("base64")}` }), `composerData:${conversationId}`);
    assert.deepEqual(scanLocal(scanOptions).capabilities.filter(row => row.agent === "cursor"), childCapabilities, "inline-only child history must match the standalone source");
    const cycle = message(childState, data(16, message(data(1, conversationId), data(2, scalar(2, 1000)))));
    const cyclicParent = message(state, data(16, message(data(1, childId), data(2, data(1, cycle)))));
    replace.run(JSON.stringify({ conversationState: `~${cyclicParent.toString("base64")}` }), `composerData:${conversationId}`);
    assert.throws(() => readCursorSelections(databasePath), /Cursor/, "cyclic child graphs must abort rather than produce partial usage");
    replace.run(JSON.stringify({ conversationState: `~${message(state, data(31, message(data(1, childId), data(2, childStatePointer)))).toString("base64")}` }), `composerData:${conversationId}`);
    database.prepare("DELETE FROM cursorDiskKV WHERE key = ?").run(key(childStatePointer));
    assert.throws(() => readCursorSelections(databasePath), /Cursor/, "missing referenced child state must not silently lose capability usage");
    replace.run(JSON.stringify({ conversationState: `~${inlineParent.toString("base64")}` }), `composerData:${conversationId}`);
    database.prepare("DELETE FROM cursorDiskKV WHERE key = ?").run(key(userPointer));
    assert.throws(() => readCursorSelections(databasePath), /Cursor/);
    assert.deepEqual(scanLocal({ ...scanOptions, capabilities: false }).capabilities, [], "policy-off collection must not open a corrupt Cursor graph");
  } finally {
    database?.close();
    fs.rmSync(fixtureHome, { recursive: true, force: true });
  }
  console.log("OK  Cursor binary selections skip content, deduplicate replay and fail on incomplete referenced metadata");
}
