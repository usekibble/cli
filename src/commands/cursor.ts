import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configPath, loadConfig } from "../config.js";
import { managedLauncher } from "../update-state.js";
import { CursorSource, cursorUsagePath, normalizeCursorStop } from "../sources/cursor.js";
import { cursorToolsPath, normalizeCursorTool } from "../sources/cursor-tools.js";
import { cursorInventory } from "../sources/capabilities.js";
import { captureCursorInventory, cursorWorkspaces } from "../sources/cursor-inventory.js";
import { cursorActivityPath, normalizeCursorActivity } from "../sources/cursor-activity.js";

const EVENTS = ["stop", "postToolUse", "postToolUseFailure", "beforeSubmitPrompt", "subagentStop"] as const;

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readObject(path: string): JsonObject {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Could not read Cursor hook configuration.");
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (object(value)) return value;
  } catch { /* report a content-free error below */ }
  throw new Error("Invalid Cursor hook configuration. Existing hooks were not changed.");
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function shellArgument(value: string): string {
  if (process.platform === "win32") {
    // cmd.exe expands percent and delayed-expansion variables inside quotes.
    if (/["\r\n%!]/.test(value)) throw new Error("Cursor hook paths cannot contain quotes, newlines, percent signs or exclamation marks on Windows.");
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function cursorInstall(home = homedir(), log: (message: string) => void = console.log): void {
  const path = join(home, ".cursor", "hooks.json");
  const receiptPath = join(dirname(configPath()), "cursor-hook.json");
  const config = readObject(path);
  if (config.version !== undefined && config.version !== 1) throw new Error("Unsupported Cursor hooks version. Existing hooks were not changed.");
  if (config.hooks !== undefined && !object(config.hooks)) throw new Error("Invalid Cursor hooks. Existing hooks were not changed.");
  const hooks = (config.hooks ?? {}) as JsonObject;
  for (const event of EVENTS) if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error("Invalid Cursor hooks. Existing hooks were not changed.");
  const receipt = readObject(receiptPath);
  const previous = receipt.path === path && typeof receipt.command === "string" ? receipt.command : null;
  const entry = managedLauncher() ?? resolve(process.argv[1]!);
  if (/\.tsx?$/.test(entry)) throw new Error("Build and install Kibble before installing Cursor hooks.");
  const command = [process.execPath, entry, "--config-home", dirname(dirname(configPath())), "cursor", "record"].map(shellArgument).join(" ");
  const nextHooks = { ...hooks };
  for (const event of EVENTS) {
    const entries = (hooks[event] ?? []) as unknown[];
    const retained = entries.filter((hook) => !object(hook) || (hook.command !== previous && hook.command !== command));
    nextHooks[event] = [...retained, { command, timeout: 10 }];
  }
  const next = { ...config, version: 1, hooks: nextHooks };
  if (JSON.stringify(config) === JSON.stringify(next) && receipt.path === path && receipt.command === command) return;
  atomicJson(path, next);
  atomicJson(receiptPath, { path, command });
  log("Installed experimental Cursor usage and tool hooks. Only future supported metadata is collected; run 'kibble cursor status' after a Cursor turn.");
}

/** Automatic collection needs its Cursor event source before the first push. */
export function ensureCursorHooks(log: (message: string) => void = console.log): void {
  const home = homedir();
  try {
    if (!statSync(join(home, ".cursor")).isDirectory()) throw new Error("Invalid Cursor directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Could not inspect Cursor installation for automatic collection.");
  }
  cursorInstall(home, log);
}

export function cursorUninstall(home = homedir()): void {
  const receiptPath = join(dirname(configPath()), "cursor-hook.json");
  const receipt = readObject(receiptPath);
  if (typeof receipt.path !== "string" || typeof receipt.command !== "string") {
    console.log("No recorded Kibble Cursor hook installation.");
    return;
  }
  if (receipt.path !== join(home, ".cursor", "hooks.json")) throw new Error("Cursor hook receipt targets a different home directory.");
  const config = readObject(receipt.path);
  if (object(config.hooks)) {
    const hooks = { ...config.hooks };
    for (const event of EVENTS) {
      const entries = hooks[event];
      if (!Array.isArray(entries)) continue;
      const retained = entries.filter((hook) => !object(hook) || hook.command !== receipt.command);
      if (retained.length === entries.length) continue;
      if (retained.length) hooks[event] = retained;
      else delete hooks[event];
    }
    atomicJson(receipt.path, { ...config, hooks });
  }
  unlinkSync(receiptPath);
  console.log("Removed Kibble's Cursor hooks. Other hooks and collected counts are retained.");
}

/** Cursor waits for this command: always acknowledge, never affect its turn. */
export async function cursorRecord(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const data of process.stdin) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      size += chunk.length;
      if (size <= 8 * 1024 * 1024) chunks.push(chunk);
    }
    if (size > 8 * 1024 * 1024) throw new Error("oversized hook input");
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const captureInventory = () => {
      if (!object(payload) || payload.hook_event_name !== "stop" || loadConfig().capabilities === false) return;
      const cwds = cursorWorkspaces(payload);
      if (cwds.length) captureCursorInventory(cursorInventory(homedir(), cwds), cwds, new Date());
    };
    const observedAt = new Date();
    // An optional activity field cannot prevent valid token counts being saved,
    // nor can unsupported token metadata discard a supported activity receipt.
    const normalize = <T>(read: () => T): T | null => {
      try { return read(); }
      catch {
        console.error("Kibble: unsupported Cursor metadata was skipped. No hook content was logged.");
        return null;
      }
    };
    const activity = normalize(() => normalizeCursorActivity(payload, observedAt));
    const tool = normalize(() => normalizeCursorTool(payload, observedAt));
    const sample = tool ?? normalize(() => normalizeCursorStop(payload, observedAt));
    if (!sample && !activity) {
      captureInventory();
      console.error("Kibble: Cursor did not provide supported hook metadata; nothing was recorded.");
      return;
    }
    const records: [string, unknown][] = [];
    if (sample) records.push([tool ? cursorToolsPath() : cursorUsagePath(), sample]);
    if (activity) records.push([cursorActivityPath(), activity]);
    for (const [path, value] of records) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        if (!fstatSync(fd).isFile()) throw new Error("invalid usage file");
        const line = Buffer.from(`${JSON.stringify(value)}\n`);
        if (writeSync(fd, line) !== line.length) throw new Error("incomplete usage write");
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    captureInventory();
  } catch {
    console.error("Kibble: Cursor usage could not be recorded. No hook content was logged.");
  } finally { console.log("{}"); }
}

export function cursorStatus(): void {
  const receipt = readObject(join(dirname(configPath()), "cursor-hook.json"));
  const config = readObject(join(homedir(), ".cursor", "hooks.json"));
  for (const event of EVENTS) {
    const entries = object(config.hooks) ? config.hooks[event] : null;
    const installed = Array.isArray(entries) && entries.some((hook) => object(hook) && typeof receipt.command === "string" && hook.command === receipt.command);
    console.log(`Cursor ${event} hook: ${installed ? "installed" : "not installed"}`);
  }
  const source = new CursorSource();
  const samples = source.snapshot({ since: "0001-01-01", until: "9999-12-31" });
  console.log(`Captured turns: ${samples.length}`);
  console.log(`Captured tool calls: ${source.toolSnapshot({ since: "0001-01-01", until: "9999-12-31" }).length}`);
  const activity = source.activitySnapshot({ since: "0001-01-01", until: "9999-12-31" });
  console.log(`Captured prompt submissions: ${activity.filter(sample => sample.event === "beforeSubmitPrompt").length}`);
  console.log(`Captured subagent completions: ${activity.filter(sample => sample.event === "subagentStop").length}`);
  console.log(`Paired observed turn durations: ${activity.filter(sample => sample.durationMs !== null && sample.durationMs !== undefined).length}`);
  console.log(`Latest captured UTC day: ${samples.map(sample => sample.date).sort().pop() ?? "none"}`);
  console.log("Experimental: token usage requires token-bearing stop hooks. Turn timing measures hook receipts, not model execution. Historical usage, skill/command invocations and full activity parity are not established.");
}
