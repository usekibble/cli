import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { CursorAgentMetadata } from "./cursor-agent-metadata.js";

/** The subprocess returns local artifact hashes, never selected skill paths. */
export type CursorSelectionMetadata = CursorAgentMetadata & { skillArtifacts: string[] };
const failure = () => new Error("Could not read complete Cursor selection metadata; collection stopped.");

/** One process per WAL snapshot: libsql close leaves statements alive until GC.
 * Waiting for process exit releases all native handles even after corrupt data.
 */
export function readCursorSelections(databasePath: string): CursorSelectionMetadata[] {
  try {
    if (!statSync(databasePath).isFile()) throw failure();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw failure();
  }
  const source = import.meta.url.endsWith(".ts");
  const worker = new URL(source ? "./cursor-store-worker.ts" : "./cursor-store-worker.js", import.meta.url);
  const child = spawnSync(process.execPath, [
    ...(source ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href] : []), fileURLToPath(worker),
  ], {
    input: databasePath,
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (child.error || child.status !== 0) throw failure();
  try { return JSON.parse(child.stdout) as CursorSelectionMetadata[]; }
  catch { throw failure(); }
}
