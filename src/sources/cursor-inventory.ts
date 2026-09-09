import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { cursorUsagePath } from "./cursor.js";
import type { Inventory } from "./capabilities.js";

export interface CursorInventoryEntry {
  date: string;
  kind: "skill" | "command";
  name: string;
  descriptionTokens: number;
  /** Local alias identity only. Never added to capability wire rows. */
  artifact: string;
}

export function cursorArtifact(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

/** Workspace metadata only, with bounded roots. No transcript paths or bodies. */
export function cursorWorkspaces(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const p = payload as Record<string, unknown>;
  const candidates = typeof p.cwd === "string" ? [p.cwd] : Array.isArray(p.workspace_roots) ? p.workspace_roots.slice(0, 16) : [];
  return [...new Set(candidates.filter((path): path is string => typeof path === "string" && path.length <= 4096 && isAbsolute(path)))];
}

function directory(home: string): string { return join(dirname(cursorUsagePath(home)), "cursor-inventory"); }
function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[/\\\u0000-\u001f\u007f]/.test(value);
}

/** Replace one workspace's last observed inventory atomically, names and sizes only. */
export function captureCursorInventory(inventory: Inventory, cwds: string[], observedAt: Date, home = homedir()): void {
  if (!cwds.length) return;
  const date = observedAt.toISOString().slice(0, 10);
  const entries: CursorInventoryEntry[] = [];
  for (const [kind, values] of [["skill", inventory.skills], ["command", inventory.commands]] as const) {
    for (const [name, entry] of values) {
      if (entry.source !== "project" || entry.alias || !validName(name)) continue;
      entries.push({ date, kind, name, descriptionTokens: entry.descriptionTokens, artifact: cursorArtifact(entry.realPath) });
    }
  }
  const dir = directory(home);
  const serialized = JSON.stringify({ version: 1, entries });
  if (entries.length > 10_000 || Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error("Cursor project inventory exceeds the supported snapshot size.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${cursorArtifact(JSON.stringify([...cwds].sort()))}.json`);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, serialized, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Last observed snapshots, not an assertion about projects changed since their last hook. */
export function readCursorInventory(home: string, since: string, until: string): CursorInventoryEntry[] {
  let files: string[];
  const dir = directory(home);
  try { files = readdirSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Could not read Cursor project inventory.");
  }
  const out: CursorInventoryEntry[] = [];
  try {
    for (const file of files.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const path = join(dir, file);
      if (statSync(path).size > 8 * 1024 * 1024) throw new Error();
      const snapshot = JSON.parse(readFileSync(path, "utf8"));
      if (!snapshot || snapshot.version !== 1 || Object.keys(snapshot).sort().join() !== "entries,version" || !Array.isArray(snapshot.entries) || snapshot.entries.length > 10_000) throw new Error();
      for (const entry of snapshot.entries) {
        if (!entry || Object.keys(entry).sort().join() !== "artifact,date,descriptionTokens,kind,name" || !["skill", "command"].includes(entry.kind) || !validName(entry.name) || !Number.isSafeInteger(entry.descriptionTokens) || entry.descriptionTokens < 0 || !/^[a-f0-9]{64}$/.test(entry.artifact) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw new Error();
        const day = new Date(`${entry.date}T00:00:00Z`);
        if (!Number.isFinite(day.valueOf()) || day.toISOString().slice(0, 10) !== entry.date) throw new Error();
        if (entry.date >= since && entry.date <= until) out.push(entry);
      }
    }
  } catch { throw new Error("Invalid or unreadable Cursor project inventory; collection stopped."); }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
