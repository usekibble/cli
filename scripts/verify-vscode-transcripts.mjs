/** Prevent duplicated/misattributed tool time, broken collection and content leaks. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVsCodeTranscript, scanVsCodeTranscripts } from "../dist/sources/vscode-transcripts.js";

export async function verifyVsCodeTranscripts() {
  const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const otherSession = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const epoch = Date.parse("2026-09-07T12:00:00.000Z");
  const start = (toolCallId, at, toolName = "read_file") => ({ type: "tool.execution_start", at,
    data: { toolCallId, toolName, arguments: "PRIVATE_ARGUMENTS" } });
  const complete = (toolCallId, at, success = true) => ({ type: "tool.execution_complete", at,
    data: { toolCallId, success, result: { content: "PRIVATE_RESULT" } } });
  const stream = (events, id = sessionId) => {
    const records = [{ type: "session.start", id: "event-0", parentId: null,
      timestamp: new Date(epoch).toISOString(), data: { sessionId: id, version: 1,
        producer: "copilot-agent", context: { cwd: "PRIVATE_PATH" } } }];
    for (const [index, event] of events.entries()) records.push({ type: event.type,
      id: `event-${index + 1}`, parentId: Object.hasOwn(event, "parentId") ? event.parentId : records.at(-1).id,
      timestamp: new Date(epoch + event.at).toISOString(), data: event.data });
    return records;
  };
  const parse = (events) => parseVsCodeTranscript(stream(events), sessionId);
  const control = stream([start("call-1", 100), complete("call-1", 125),
    start("call-2", 200), complete("call-2", 240, false)]);
  const measured = parseVsCodeTranscript(control, sessionId);
  assert.equal(measured.length, 2);
  assert.deepEqual(measured.map((event) => event.endMs - event.startMs), [25, 40]);
  assert(measured.every((event) => event.uniqueInSession));
  assert.deepEqual(measured.map((event) => event.executionResolved), [true, false]);
  assert(measured.every((event) => !("outcome" in event)), "promise resolution became a semantic outcome");
  assert(!JSON.stringify(measured).includes("PRIVATE_"));
  assert.deepEqual(parseVsCodeTranscript(control, sessionId), measured, "repeated reading duplicated tool time");
  assert.throws(() => parseVsCodeTranscript(control, otherSession), /Invalid VS Code/,
    "a transcript from a different session was accepted");

  // A model can reuse its ID; retain distinct observed intervals without
  // presenting the stripped base ID as a safe join to a saved chat card.
  const repeated = parse([start("same", 10), complete("same", 30), start("same", 40), complete("same", 70)]);
  assert.deepEqual(repeated.map((event) => event.endMs - event.startMs), [20, 30]);
  assert(repeated.every((event) => !event.uniqueInSession));
  assert.equal(new Set(repeated.map((event) => event.startEventId)).size, 2);
  const incompleteRepeat = parse([start("same", 10), complete("same", 30), start("same", 40)]);
  assert.equal(incompleteRepeat.length, 1);
  assert.equal(incompleteRepeat[0].uniqueInSession, false, "a pending repeat was hidden by paired-only output");
  const unmatchedRepeat = parse([complete("same", 5, false), start("same", 10), complete("same", 30)]);
  assert.equal(unmatchedRepeat[0].uniqueInSession, false, "an unmatched failure was hidden by paired-only output");

  // Concurrent same-ID starts cannot be paired FIFO, LIFO or by tool name.
  assert.deepEqual(parse([start("same", 10), start("same", 20, "run_in_terminal"),
    complete("same", 30), complete("same", 40)]), []);
  const afterOverlap = parse([start("same", 10), start("same", 20), complete("same", 30),
    complete("same", 40), start("same", 50), complete("same", 80),
    start("independent", 90), complete("independent", 100)]);
  assert.deepEqual(afterOverlap.map((event) => [event.endMs - event.startMs, event.uniqueInSession]), [[30, false], [10, true]]);

  // Existing-file resume resets parentId without emitting another session.start.
  // No timing may bridge the unknown period between editor processes.
  assert.deepEqual(parse([start("same", 10), { ...complete("same", 100), parentId: null }]), []);
  const restart = parse([start("same", 10), { ...start("same", 100), parentId: null }, complete("same", 125)]);
  assert.equal(restart[0].endMs - restart[0].startMs, 25);
  assert.equal(restart[0].uniqueInSession, false);

  // Replayed assistant rounds have synthetic timestamps and may carry tool
  // requests. Neither those payloads nor any other content field is touched.
  const privacy = stream([
    { type: "user.message", at: -100, data: {} },
    { type: "assistant.turn_start", at: -50, data: {} },
    { type: "assistant.message", at: -50, data: {} },
    { type: "assistant.turn_end", at: -50, data: {} },
    { type: "future.event", at: 1, data: {} },
    start("private-control", 100), complete("private-control", 125),
  ]);
  const forbidden = () => { throw new Error("private payload was read"); };
  for (const index of [1, 2, 3, 4, 5]) Object.defineProperty(privacy[index], "data", { get: forbidden });
  for (const key of ["context", "startTime", "copilotVersion", "vscodeVersion"]) Object.defineProperty(privacy[0].data, key, { get: forbidden });
  for (const key of ["arguments", "content", "result"]) Object.defineProperty(privacy[6].data, key, { get: forbidden });
  for (const key of ["arguments", "content", "result"]) Object.defineProperty(privacy[7].data, key, { get: forbidden });
  const privateControl = parseVsCodeTranscript(privacy, sessionId);
  assert.equal(privateControl.length, 1, "replayed or unknown records invented tool intervals");
  assert.equal(privateControl[0].endMs - privateControl[0].startMs, 25);

  const corrupt = (mutate) => {
    const records = structuredClone(control);
    mutate(records);
    assert.throws(() => parseVsCodeTranscript(records, sessionId), /Invalid VS Code/);
  };
  corrupt((records) => { records[2].id = records[1].id; });
  corrupt((records) => { records[2].parentId = "missing-event"; });
  corrupt((records) => { records[1].data.toolCallId = "not an opaque id"; });
  corrupt((records) => { records[1].data.toolName = "PRIVATE COMMAND CONTENT"; });
  corrupt((records) => { records[2].data.success = "true"; });
  corrupt((records) => { records[2].timestamp = new Date(epoch + 99).toISOString(); });
  corrupt((records) => { records[2].timestamp = "2026-02-30T12:00:00.000Z"; });
  corrupt((records) => { records[0].data.version = 2; });
  corrupt((records) => { records[0].data.producer = "unknown"; });
  corrupt((records) => { records.splice(0, 1); records[0].parentId = null; });
  corrupt((records) => { records.push({ ...records[0], id: "second-session-start" }); });

  // Scanner checks exercise the real fixed-directory discovery and JSONL reader.
  const home = mkdtempSync(join(tmpdir(), "kibble-vscode-transcript-check-"));
  const root = join(home, "Code");
  const dir = join(root, "User/workspaceStorage/workspace/GitHub.copilot-chat/transcripts");
  const path = join(dir, `${sessionId}.jsonl`);
  const write = (target, value) => { mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, value); };
  const log = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const options = { userDataDirs: [root], sessionIds: new Set([sessionId]) };
  try {
    assert.deepEqual(scanVsCodeTranscripts(options), { files: 0, tools: [] });
    write(path, log(control));
    assert.deepEqual(scanVsCodeTranscripts(options), { files: 1, tools: measured });
    assert.deepEqual(scanVsCodeTranscripts(options).tools, measured, "rescanning duplicated transcript intervals");
    // An unrelated corrupt session is never opened when the caller scopes IDs.
    write(join(dir, `${otherSession}.jsonl`), "PRIVATE_CORRUPT_CONTENT\n");
    write(join(dir, "not-a-session.jsonl"), "PRIVATE_CORRUPT_CONTENT\n");
    write(join(root, "unrelated", `${sessionId}.jsonl`), "PRIVATE_CORRUPT_CONTENT\n");
    assert.deepEqual(scanVsCodeTranscripts(options).tools, measured);
    assert.deepEqual(scanVsCodeTranscripts({ ...options, sessionIds: new Set() }), { files: 0, tools: [] });
    assert.throws(() => scanVsCodeTranscripts({ userDataDirs: [root] }), /Invalid VS Code/);
    write(path, log(stream([start("call-1", 100), complete("call-1", 125)], otherSession)));
    assert.throws(() => scanVsCodeTranscripts(options), /Invalid VS Code/);

    write(path, log(control) + '{"type":"tool.execution_start"');
    const partial = scanVsCodeTranscripts(options).tools;
    assert.deepEqual(partial.map((event) => event.endMs - event.startMs), [25, 40]);
    assert(partial.every((event) => !event.uniqueInSession), "a partial record could hide a reused ID");
    write(path, log(control).trimEnd());
    assert.deepEqual(scanVsCodeTranscripts(options).tools, measured, "valid final JSON without newline was lost");
    write(path, log(control) + "PRIVATE_CORRUPT_CONTENT\n");
    assert.throws(() => scanVsCodeTranscripts(options), /Invalid VS Code/);
    write(path, log(control.slice(0, 2)) + "PRIVATE_CORRUPT_CONTENT\n" + log(control.slice(2)));
    assert.throws(() => scanVsCodeTranscripts(options), /Invalid VS Code/);
    write(path, log(control.slice(0, 2)));
    assert.deepEqual(scanVsCodeTranscripts(options).tools, [], "unfinished execution invented a completion");

    // A copied transcript does not resurrect old intervals or double-count time.
    const copied = join(root, "User/workspaceStorage/old-workspace/GitHub.copilot-chat/transcripts", `${sessionId}.jsonl`);
    write(copied, log(control));
    utimesSync(copied, new Date(epoch), new Date(epoch));
    write(path, log(control.slice(0, 3)));
    utimesSync(path, new Date(epoch + 1000), new Date(epoch + 1000));
    const newest = scanVsCodeTranscripts(options);
    assert.equal(newest.files, 2);
    assert.deepEqual(newest.tools, [measured[0]], "an older copy resurrected removed activity");
    // Alias roots point to the same files, not an additional copy to ingest.
    const alias = join(home, "Code-Alias");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    assert.deepEqual(scanVsCodeTranscripts({ ...options, userDataDirs: [root, alias] }), newest);
    assert(!JSON.stringify(newest).includes(home), "local filesystem paths escaped metadata projection");
    assert(!JSON.stringify(newest).includes("PRIVATE_"));
  } finally { rmSync(home, { recursive: true, force: true }); }
  console.log("OK  VS Code transcript fixtures: safe pairing, session scope, replay, partial writes and privacy");
}
