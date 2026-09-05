import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { configPath } from "./config.js";
import { updateText as t } from "./update-messages.js";

export interface Runtime {
  root: string;
  version: string;
}

export interface UpdateState {
  enabled?: boolean;
  active?: Runtime;
  previous?: Runtime;
  npm?: string;
  checkedAt?: number;
  nextCheckAt?: number;
  error?: string;
}

// Update consent belongs to this local installation, independently of login.
export function updateHome(): string { return resolve(dirname(configPath()), "updates"); }
export function launcherPath(): string { return join(updateHome(), "launcher.mjs"); }

export function readUpdateState(): UpdateState {
  let raw: string;
  try { raw = readFileSync(join(updateHome(), "state.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(t("stateRead"));
  }
  try {
    const state = JSON.parse(raw) as UpdateState;
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error();
    if (state.enabled !== undefined && typeof state.enabled !== "boolean") throw new Error();
    for (const runtime of [state.active, state.previous]) {
      if (runtime !== undefined && (!runtime || typeof runtime.root !== "string" ||
        !isAbsolute(runtime.root) || typeof runtime.version !== "string")) throw new Error();
    }
    for (const time of [state.checkedAt, state.nextCheckAt]) {
      if (time !== undefined && (typeof time !== "number" || !Number.isFinite(time))) throw new Error();
    }
    if (state.npm !== undefined && (typeof state.npm !== "string" || !isAbsolute(state.npm))) throw new Error();
    if (state.error !== undefined && typeof state.error !== "string") throw new Error();
    return state;
  } catch { throw new Error(t("stateInvalid")); }
}

export function atomicWrite(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, body, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function writeUpdateState(state: UpdateState): void {
  atomicWrite(join(updateHome(), "state.json"), JSON.stringify(state, null, 2) + "\n");
}

export function managedLauncher(): string | undefined {
  return readUpdateState().active && existsSync(launcherPath()) ? launcherPath() : undefined;
}
