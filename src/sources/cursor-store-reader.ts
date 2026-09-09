import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import Database from "libsql";
import { readCursorAgentMetadata, type CursorAgentMetadata } from "./cursor-agent-metadata.js";

const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_STATES = 10_000;
const failure = () => new Error("Could not read complete Cursor selection metadata; collection stopped.");

/** Read one WAL-aware snapshot. The file URI enforces SQLite's read-only mode. */
export function readCursorSelectionSnapshot(databasePath: string): CursorAgentMetadata[] {
  let db: InstanceType<typeof Database> | undefined;
  try {
    try {
      if (!statSync(databasePath).isFile()) throw failure();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const uri = pathToFileURL(databasePath);
    uri.searchParams.set("mode", "ro");
    // libsql's readonly property is always false. URI mode=ro is enforced by
    // SQLite itself, including rejection of writes and missing database files.
    db = new Database(uri.href, { timeout: 1_000 });
    db.exec("BEGIN");
    // A fresh installation may not have created its conversation store yet.
    // An existing object with the wrong type or schema is corruption, not empty.
    const schema = db.prepare(
      "SELECT type FROM sqlite_master WHERE name = 'cursorDiskKV' COLLATE NOCASE",
    ).all() as { type: string }[];
    if (schema.length === 0) {
      db.exec("COMMIT");
      return [];
    }
    if (schema.length !== 1 || schema[0]!.type !== "table") throw failure();
    // libsql batches iterator rows. Bound all projected bytes before fetching
    // any strings so one batch cannot allocate many oversized states.
    const bounds = db.prepare(`
      SELECT count(*) AS count, coalesce(sum(length(state)), 0) AS bytes,
        coalesce(max(invalid), 0) AS invalid
      FROM (
        SELECT CASE WHEN length(value) <= ${MAX_TOTAL_BYTES} AND json_valid(value)
          THEN json_extract(value, '$.conversationState') ELSE NULL END AS state,
          CASE WHEN length(value) <= ${MAX_TOTAL_BYTES} AND json_valid(value)
            THEN 0 ELSE 1 END AS invalid
        FROM cursorDiskKV WHERE key GLOB 'composerData:*' LIMIT ${MAX_STATES + 1}
      )
    `).get() as { count: number; bytes: number; invalid: number };
    if (bounds.count > MAX_STATES || bounds.invalid !== 0
      || bounds.bytes > 4 * Math.ceil(MAX_TOTAL_BYTES / 3) + MAX_STATES) throw failure();
    const states: { conversationId: string; state: Buffer }[] = [];
    let count = 0, totalBytes = 0;
    // Only the state projection crosses the database boundary. Oversized or
    // invalid JSON fails without returning conversation text to JavaScript.
    const rows = db.prepare(`
      SELECT substr(key, 14) AS conversationId,
        CASE WHEN length(value) <= ${MAX_TOTAL_BYTES} AND json_valid(value)
          THEN json_extract(value, '$.conversationState') ELSE NULL END AS state,
        CASE WHEN length(value) <= ${MAX_TOTAL_BYTES} AND json_valid(value)
          THEN 1 ELSE 0 END AS valid
      FROM cursorDiskKV WHERE key GLOB 'composerData:*' LIMIT ${MAX_STATES + 1}
    `).iterate();
    for (const raw of rows) {
      if (++count > MAX_STATES) throw failure();
      const row = raw as { conversationId: unknown; state: unknown; valid: unknown };
      if (row.valid !== 1) throw failure();
      // Drafts may have no conversation state or an empty encoded protobuf.
      if (row.state === null || row.state === "~") continue;
      if (typeof row.conversationId !== "string" || typeof row.state !== "string"
        || row.state.length > 1 + 4 * Math.ceil(MAX_BLOB_BYTES / 3)
        || !row.state.startsWith("~")) throw failure();
      const state = Buffer.from(row.state.slice(1), "base64");
      if (state.length > MAX_BLOB_BYTES || `~${state.toString("base64")}` !== row.state) throw failure();
      totalBytes += state.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw failure();
      states.push({ conversationId: row.conversationId, state });
    }
    const blob = db.prepare(`
      SELECT CASE WHEN (typeof(value) = 'blob' AND length(value) <= ${MAX_BLOB_BYTES})
        OR (typeof(value) = 'text' AND length(value) <= ${MAX_BLOB_BYTES * 2})
        THEN value ELSE NULL END AS value
      FROM cursorDiskKV WHERE key = ?
    `);
    const result = readCursorAgentMetadata(states, key => {
      if (!/^agentKv:blob:[0-9a-f]{64}$/.test(key)) throw failure();
      const row = blob.get(key) as { value: unknown } | undefined;
      if (!row || row.value === null) return null;
      if (Buffer.isBuffer(row.value)) return row.value;
      if (typeof row.value === "string" && row.value.length % 2 === 0
        && !/[^0-9a-f]/i.test(row.value)) return Buffer.from(row.value, "hex");
      throw failure();
    });
    db.exec("COMMIT");
    return result;
  } catch {
    // SQLite errors can quote SQL values or local paths. Do not expose them.
    throw failure();
  } finally {
    try { db?.close(); } catch { throw failure(); }
  }
}
