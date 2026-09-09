import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (!process.env.KIBBLE_CURSOR_STORE_FIXTURE) {
  const fixtureHome = fs.mkdtempSync(join(tmpdir(), "kibble-cursor-selection # "));
  let failure;
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, KIBBLE_CURSOR_STORE_FIXTURE: fixtureHome },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout || child.error?.message);
    process.stdout.write(child.stdout);
    // Production reads must release handles before returning, including errors.
    // Rename/delete is the behavioral check on Windows, not a forced GC or retry.
    const { readCursorSelections } = await import("../dist/sources/cursor-store.js");
    const appData = process.platform === "darwin" ? join(fixtureHome, "Library", "Application Support")
      : process.platform === "win32" ? join(fixtureHome, "AppData", "Roaming") : join(fixtureHome, ".config");
    const emptyPath = join(fixtureHome, "empty.vscdb");
    assert.deepEqual(readCursorSelections(emptyPath), []);
    fs.renameSync(emptyPath, `${emptyPath}.moved`);
    fs.unlinkSync(`${emptyPath}.moved`);
    const databasePath = join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
    assert.throws(() => readCursorSelections(databasePath), /complete Cursor selection metadata/);
    const moved = `${databasePath}.moved`;
    fs.renameSync(databasePath, moved);
    fs.unlinkSync(moved);
  } catch (error) { failure = error; }
  finally {
    try { fs.rmSync(fixtureHome, { recursive: true, force: true }); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "Cursor fixture and cleanup failed") : error; }
  }
  if (failure) throw failure;
} else {
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
  const fixtureHome = process.env.KIBBLE_CURSOR_STORE_FIXTURE;
  const appData = process.platform === "darwin" ? join(fixtureHome, "Library", "Application Support")
    : process.platform === "win32" ? join(fixtureHome, "AppData", "Roaming") : join(fixtureHome, ".config");
  const databasePath = join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  let database;
  try {
    const empty = new Database(join(fixtureHome, "empty.vscdb"));
    empty.exec("CREATE TABLE fixture_control (id INTEGER)");
    empty.close();
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
    assert.deepEqual(projected[0].skillPaths, [], "worker output must not retain selected paths");
    assert.equal(projected[0].skillArtifacts.length, 1);
    assert(!JSON.stringify(projected).includes(fixtureHome));
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

  }
  console.log("OK  Cursor binary selections skip content, deduplicate replay and fail on incomplete referenced metadata");
}

}
