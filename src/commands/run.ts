import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { basename, resolve } from "node:path";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { CiJsonLines, CiStreamCollector, type CiAgent } from "../sources/ci-stream.js";
import type { CiReceipt } from "../ci-receipt.js";
import { ciWorkspace, type CiWorkspace } from "../ci-workspace.js";
import { ciUploadConfig, uploadCiReceipt } from "./ci.js";
export type { CiReceipt } from "../ci-receipt.js";

export interface CiInvocation {
  agent: CiAgent;
  executable: string;
  args: string[];
}

/** Inspect mode flags only. Prompts, paths and config values never enter receipts. */
export function ciInvocation(command: string[]): CiInvocation {
  const [executable, ...args] = command;
  const name = basename(executable ?? "").replace(/\.exe$/i, "");
  const agent = name === "codex" ? "codex" : name === "claude" ? "claude-code" : null;
  if (!executable || !agent) throw new Error("Use kibble run --receipt <file> -- codex exec ... or claude -p ...");
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  const has = (...names: string[]) => flags.some((arg) => names.some((key) => arg === key || arg.startsWith(`${key}=`)));
  if (agent === "codex") {
    if (args[0] !== "exec" || flags.includes("resume") || flags.includes("review")) {
      throw new Error("CI capture supports a new codex exec invocation; resume and review are not supported.");
    }
    if (flags.some((arg) => /^(--ephemeral|--json)=/.test(arg))) {
      throw new Error("Codex CI capture requires --ephemeral and --json without values.");
    }
  } else {
    if (has("--resume", "--continue", "--fork-session", "--resume-session-at", "--input-format", "--replay-user-messages", "--session-persistence") ||
      flags.some((arg) => /^-[cr]/.test(arg) && !arg.startsWith("--"))) {
      throw new Error("CI capture supports a new Claude print invocation with text input; resume and streaming input are not supported.");
    }
    for (let i = 0; i < flags.length; i++) {
      const arg = flags[i]!;
      if ((arg === "--output-format" && flags[i + 1] !== "stream-json") ||
        (arg.startsWith("--output-format=") && arg !== "--output-format=stream-json") ||
        /^--(no-session-persistence|verbose)=/.test(arg)) {
        throw new Error("Claude CI capture requires --output-format stream-json --verbose --no-session-persistence.");
      }
    }
  }
  return {
    agent, executable,
    args: agent === "codex" ? ["exec", "--ephemeral", "--json", ...args.slice(1)]
      : ["-p", "--no-session-persistence", "--output-format", "stream-json", "--verbose", ...args],
  };
}

export function writeReceipt(path: string, receipt: CiReceipt, first = false): void {
  const temporary = first ? path : `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    if (!first) renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!first && created) { try { unlinkSync(temporary); } catch { /* Renamed already. */ } }
  }
}

/** Execute without a shell; retain only explicitly constructed receipt fields. */
export async function captureCiRun(invocation: CiInvocation, receiptPath: string, workspace?: CiWorkspace): Promise<{ receipt: CiReceipt; exitCode: number; saved: boolean }> {
  const started = Date.now();
  const startedMono = performance.now();
  const collector = new CiStreamCollector(invocation.agent);
  const lines = new CiJsonLines(collector);
  const receipt: CiReceipt = {
    schemaVersion: 1, revision: 0, runId: randomUUID(), agent: invocation.agent,
    accountingScope: invocation.agent === "codex" ? "codex_main_thread" : "claude_query_including_subagents",
    startedAt: new Date(started).toISOString(), endedAt: null, durationMs: null,
    outcome: "running", process: { exitCode: null, signal: null, forwardedSignal: null }, ...collector.snapshot(),
    ...(workspace ? { workspace } : {}),
  };
  // Reserve the destination before starting a paid run. Never overwrite a prior run.
  try { writeReceipt(receiptPath, receipt, true); }
  catch { throw new Error("Cannot create the CI receipt. Use a new file in an existing writable directory."); }

  const child = spawn(invocation.executable, invocation.args, {
    stdio: ["inherit", "pipe", "pipe"], shell: false, detached: process.platform !== "win32",
    env: { ...process.env, KIBBLE_CI_TOKEN: undefined },
  });
  let signal: "SIGINT" | "SIGTERM" | null = null;
  let launchFailed = false;
  let persistenceFailed = false;
  let dirty = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    Object.assign(receipt, collector.snapshot());
    receipt.revision++;
    try { writeReceipt(receiptPath, receipt); }
    catch { persistenceFailed = true; }
    dirty = false;
  };
  const send = (value: NodeJS.Signals) => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, value);
      else child.kill(value);
    } catch { /* The process may already have exited. */ }
  };
  const interrupt = (value: "SIGINT" | "SIGTERM") => {
    signal ??= value;
    send(value);
    if (!killTimer) killTimer = setTimeout(() => send("SIGKILL"), 10_000);
  };
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const checkpoint = setInterval(() => { if (dirty) persist(); }, 500);
  child.stdout.on("data", (chunk: Buffer) => { lines.write(chunk); dirty = true; });
  child.stdout.on("error", () => { collector.issue("stream_error"); dirty = true; });
  // Agent stderr can contain prompts, credentials or tool output too.
  child.stderr.resume();
  child.stderr.on("error", () => { collector.issue("stream_error"); dirty = true; });
  child.on("error", () => { launchFailed = true; });
  child.on("exit", () => {
    // A detached tool must not keep the collector waiting indefinitely on pipes.
    drainTimer = setTimeout(() => {
      collector.issue("stream_error"); child.stdout.destroy(); child.stderr.destroy();
    }, 2_000);
  });
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("close", (code, closedSignal) => done({ code, signal: closedSignal }));
  });
  if (signal) send("SIGKILL"); // Clean up remaining group members after cancellation.
  clearInterval(checkpoint);
  clearTimeout(killTimer);
  clearTimeout(drainTimer);
  process.removeListener("SIGINT", onInt);
  process.removeListener("SIGTERM", onTerm);
  lines.end();
  Object.assign(receipt, collector.snapshot());
  // Node reports negative spawn error numbers when no child actually started.
  receipt.process = { exitCode: launchFailed ? null : ended.code, signal: ended.signal, forwardedSignal: signal };
  receipt.endedAt = new Date().toISOString();
  receipt.durationMs = Math.round(performance.now() - startedMono);
  receipt.outcome = launchFailed ? "launch_failed" : signal || ended.signal ? "interrupted"
    : ended.code === 0 && receipt.agentResult === "succeeded" ? "succeeded" : "failed";
  if (receipt.outcome === "interrupted" && receipt.usageStatus === "complete") receipt.usageStatus = "partial";
  let saved = true;
  receipt.revision++;
  try { writeReceipt(receiptPath, receipt); }
  catch { persistenceFailed = true; saved = false; }
  if (persistenceFailed) console.error("Kibble could not save every CI receipt update. The file may be incomplete.");
  const finalSignal = signal ?? ended.signal;
  const exitCode = finalSignal ? 128 + (constants.signals[finalSignal] ?? 1)
    : ended.code && ended.code > 0 ? ended.code
    : receipt.outcome !== "succeeded" || receipt.usageStatus !== "complete" || persistenceFailed ? 1 : 0;
  return { receipt, exitCode, saved };
}

export async function run(command: string[], options: { receipt?: string; upload?: boolean; server?: string }): Promise<void> {
  if (!options.receipt) throw new Error("Use --receipt <file> before the agent command.");
  const invocation = ciInvocation(command);
  const upload = options.upload ? ciUploadConfig(options.server) : null;
  const result = await captureCiRun(invocation, resolve(options.receipt), ciWorkspace(process.cwd()));
  process.exitCode = result.exitCode;
  console.log(`Kibble run ${result.receipt.runId}: ${result.receipt.outcome}; usage ${result.receipt.usageStatus}; cost ${result.receipt.costBasis}. ${result.saved ? "Receipt saved locally" : "Receipt save failed"}.`);
  if (upload) {
    try {
      const ack = await uploadCiReceipt(result.receipt, upload);
      console.log(`Kibble CI upload: ${ack.status}.`);
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = result.exitCode || 1;
    }
  }
}
