import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscripts } from "../dist/sources/transcripts.js";

const READ_BYTES = 64 * 1024;
const dir = mkdtempSync(join(tmpdir(), "kibble-transcripts-"));

try {
  const records = join(dir, "records.jsonl");
  const empty = join(dir, "empty.jsonl");
  const final = join(dir, "final.jsonl");
  const missing = join(dir, "missing.jsonl");

  const prefix = '{"order":1,"padding":"';
  const splitPadding = READ_BYTES - 1 - Buffer.byteLength(prefix);
  assert.ok(splitPadding > 0);
  const longLine = `${prefix}${"x".repeat(splitPadding)}界${"y".repeat(READ_BYTES * 2)}"}`;
  writeFileSync(
    records,
    `${longLine}\nnot json\n\n${JSON.stringify({ order: 2, value: "after malformed" })}\n`,
  );
  writeFileSync(empty, "");
  writeFileSync(final, JSON.stringify({ order: 3, value: "no final newline" }));

  const firstRecords = [];
  const secondRecords = [];
  const events = [];
  let fileNumber = 0;
  readTranscripts(
    [
      { path: records, mtimeMs: 1 },
      { path: empty, mtimeMs: 1 },
      { path: final, mtimeMs: 1 },
    ],
    [
      {
        startFile() {
          fileNumber += 1;
          events.push(`start:${fileNumber}`);
        },
        record(record) {
          firstRecords.push(record);
          events.push(`record:${fileNumber}:${record.order}`);
        },
      },
      {
        startFile() {
          events.push(`second-start:${fileNumber}`);
        },
        record(record) {
          secondRecords.push(record);
        },
      },
    ],
  );

  assert.throws(
    () => readTranscripts([{ path: missing, mtimeMs: 1 }], [{ record() {} }]),
    /could not open a transcript/,
    "a disappeared or unreadable transcript cannot silently reduce daily totals",
  );

  assert.deepEqual(
    events,
    [
      "start:1",
      "second-start:1",
      "record:1:1",
      "record:1:2",
      "start:2",
      "second-start:2",
      "start:3",
      "second-start:3",
      "record:3:3",
    ],
    "readable files must reset visitors once before records, including empty files",
  );
  assert.deepEqual(
    firstRecords.map(({ order, value }) => ({ order, value })),
    [
      { order: 1, value: undefined },
      { order: 2, value: "after malformed" },
      { order: 3, value: "no final newline" },
    ],
    "malformed lines must be skipped without losing later or unterminated records",
  );
  assert.equal(firstRecords[0].padding.length, splitPadding + 1 + READ_BYTES * 2);
  assert.equal(firstRecords[0].padding[splitPadding], "界");
  assert.equal(secondRecords.length, firstRecords.length);
  for (let index = 0; index < firstRecords.length; index += 1) {
    assert.equal(
      secondRecords[index],
      firstRecords[index],
      "all visitors must receive the one parsed record object",
    );
  }

  const fdCount = () => {
    try {
      return readdirSync("/dev/fd").length;
    } catch {
      return null;
    }
  };
  const beforeFds = fdCount();
  const visitorError = new Error("visitor stopped");
  for (let attempt = 0; attempt < 32; attempt += 1) {
    assert.throws(
      () => readTranscripts(
        [{ path: final, mtimeMs: 1 }],
        [{ record() { throw visitorError; } }],
      ),
      (error) => error === visitorError,
      "visitor errors must propagate",
    );
  }
  const afterFds = fdCount();
  if (beforeFds !== null && afterFds !== null) {
    assert.equal(afterFds, beforeFds, "visitor errors must not leak transcript file descriptors");
  }

  const originalRead = fs.readSync;
  fs.readSync = () => { throw new Error("synthetic first-read failure"); };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => readTranscripts([{ path: records, mtimeMs: 1 }], [{ record() {} }]),
      /could not start reading a transcript/,
    );
  } finally {
    fs.readSync = originalRead;
    syncBuiltinESMExports();
  }
  let reads = 0;
  fs.readSync = (...args) => {
    if (++reads === 2) throw new Error("synthetic mid-file I/O failure");
    return originalRead(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => readTranscripts([{ path: records, mtimeMs: 1 }], [{ record() {} }]),
      /could not finish reading a transcript/,
      "a partial scan must fail instead of replacing complete daily counts",
    );
  } finally {
    fs.readSync = originalRead;
    syncBuiltinESMExports();
  }

  console.log("OK  transcript streaming preserves records, visitor state and file cleanup");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
