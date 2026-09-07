import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { copilotCapabilityName } from "./copilot-config.js";
import { PricingContext } from "./pricing.js";
import { transcriptFloor } from "./transcripts.js";
import type { UsageCounts } from "./capabilities.js";
import type { CollectOptions, CollectResult, NormalizedDailyUsage, SessionRef, SourceContext, UsageSource } from "./types.js";

type Obj = Record<string, unknown>;
type Shape = true | { [key: string]: Shape } | readonly [Shape];
const obj = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): string | null => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v) ? v : null;
const modelName = (v: unknown): string | null => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v) ? v : null;

// Project before replaying mutations: neither the retained state nor any
// consumer can access prompts, replies, tool arguments, output, or references.
const requestShape: Shape = {
  requestId: true, timestamp: true, responseTimestamp: true, modelId: true,
  agent: { extensionId: { value: true } },
  modelState: { value: true, completedAt: true }, isCanceled: true,
  promptTokens: true, completionTokens: true, elapsedMs: true,
  modelTotals: [{ model: true, inputTokens: true, outputTokens: true, cachedTokens: true }],
  result: { metadata: {
    resolvedModel: true, promptTokens: true, outputTokens: true,
    claudeSessionId: true, copilotSessionId: true,
    toolCallRounds: [{ modelId: true }],
  } },
  slashCommand: { name: true },
  response: [{ kind: true, toolId: true, toolCallId: true, isComplete: true,
    source: { type: true, serverLabel: true } }],
};
const sessionShape: Shape = { sessionId: true, workingDirectory: true, requests: [requestShape] };

function project(value: unknown, shape: Shape): unknown {
  if (shape === true) return value === null || ["string", "number", "boolean"].includes(typeof value) ? value : undefined;
  if (Array.isArray(shape)) return Array.isArray(value) ? value.map((v) => project(v, shape[0]!)) : undefined;
  const result: Obj = Object.create(null);
  const source = obj(value);
  for (const [key, child] of Object.entries(shape)) {
    if (Object.hasOwn(source, key)) result[key] = project(source[key], child);
  }
  return result;
}

/** VS Code objectMutationLog.ts: initial, set, array splice/push, delete.
 * https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts
 * Unknown/private paths are ignored before touching their value. Malformed
 * structural operations fail collection rather than publish a partial total.
 */
export function replayVsCode(records: Iterable<unknown>): Obj {
  let state: unknown;
  for (const raw of records) {
    const entry = obj(raw);
    if (entry.kind === 0) {
      if (state !== undefined) throw new Error("Unexpected VS Code chat snapshot");
      state = project(entry.v, sessionShape);
      continue;
    }
    if (![1, 2, 3].includes(Number(entry.kind)) || !Array.isArray(entry.k) || state === undefined) {
      throw new Error("Unsupported VS Code chat mutation");
    }
    const path = entry.k;
    let shape: Shape = sessionShape;
    let allowed = true;
    for (const key of path) {
      if (Array.isArray(shape) && count(key)) shape = shape[0]!;
      else if (shape !== true && !Array.isArray(shape) && typeof key === "string" && Object.hasOwn(shape, key)) {
        shape = (shape as Record<string, Shape>)[key]!;
      } else { allowed = false; break; }
    }
    if (!allowed) continue;
    let parent = { root: state } as Obj;
    let key: string | number = "root";
    for (const segment of path) {
      const next = parent[key];
      if (!next || typeof next !== "object") throw new Error("Invalid VS Code chat mutation target");
      parent = next as Obj;
      key = segment;
    }
    if (entry.kind === 1) parent[key] = project(entry.v, shape);
    else if (entry.kind === 3) delete parent[key];
    else {
      const target = parent[key];
      if (!Array.isArray(target) || !Array.isArray(shape)) throw new Error("Invalid VS Code chat array mutation");
      if (entry.i !== undefined) {
        if (!count(entry.i) || entry.i > target.length) throw new Error("Invalid VS Code chat splice index");
        target.length = entry.i;
      }
      if (entry.v !== undefined && !Array.isArray(entry.v)) throw new Error("Invalid VS Code chat append");
      for (const value of (entry.v ?? []) as unknown[]) target.push(project(value, shape[0]!));
    }
    if (path.length === 0) state = parent.root;
  }
  return obj(state);
}

export interface VsCodeOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** VS Code --user-data-dir roots, not workspace or source-code directories. */
  userDataDirs?: string[];
}

export function vsCodeDataDirs(options: VsCodeOptions = {}): string[] {
  if (options.userDataDirs) return options.userDataDirs;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  if (env.KIBBLE_VSCODE_USER_DATA_DIR) return [env.KIBBLE_VSCODE_USER_DATA_DIR];
  if (env.VSCODE_PORTABLE) return [join(env.VSCODE_PORTABLE, "user-data")];
  const platform = options.platform ?? process.platform;
  const base = platform === "darwin" ? join(home, "Library", "Application Support")
    : platform === "win32" ? env.APPDATA || join(home, "AppData", "Roaming")
    : env.XDG_CONFIG_HOME || join(home, ".config");
  return [join(base, "Code"), join(base, "Code - Insiders")];
}

function children(dir: string): string[] {
  try { return readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Cannot list VS Code chat storage");
  }
}
function cwdFromUri(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try { return fileURLToPath(value); } catch { return null; }
}
interface ChatFile { path: string; mtime: number; cwd: string | null }
function chatFiles(options: VsCodeOptions): ChatFile[] {
  const files: ChatFile[] = [];
  const seen = new Set<string>();
  const add = (dir: string, cwd: string | null) => {
    const names = children(dir);
    for (const name of names) {
      if (!/^[\da-f-]{36}\.jsonl?$/i.test(name)) continue;
      if (name.endsWith(".json") && names.includes(`${name}l`)) continue;
      const path = join(dir, name);
      try {
        const real = realpathSync(path);
        const stat = statSync(real);
        if (!stat.isFile() || seen.has(real)) continue;
        seen.add(real); files.push({ path: real, mtime: stat.mtimeMs, cwd });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot inspect VS Code chat storage");
      }
    }
  };
  for (const root of vsCodeDataDirs(options)) {
    const user = join(root, "User");
    const workspace = join(user, "workspaceStorage");
    for (const name of children(workspace)) {
      let cwd: string | null = null;
      try { cwd = cwdFromUri(obj(JSON.parse(readFileSync(join(workspace, name, "workspace.json"), "utf8"))).folder); } catch { /* multi-root or empty workspace: no single repo */ }
      add(join(workspace, name, "chatSessions"), cwd);
    }
    for (const global of [join(user, "globalStorage"), ...children(join(user, "profiles")).map((p) => join(user, "profiles", p, "globalStorage"))]) {
      add(join(global, "emptyWindowChatSessions"), null);
      add(join(global, "transferredChatSessions"), null);
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
}

export interface VsCodeModelUsage {
  model: string; tokensIn: number; tokensOut: number; tokensCacheRead: number;
}
export interface VsCodeRequest {
  sessionId: string; requestId: string; date: string; cwd: string | null;
  usages: VsCodeModelUsage[]; lastCallOnly: boolean; durationMs: number;
  cancelled: boolean; failed: boolean; rounds: number; command: string | null;
  tools: { id: string; name: string; server: string | null }[];
}
export interface VsCodeScan { files: number; sessions: number; requests: VsCodeRequest[] }

/** The stream is projected immediately; no raw conversation state escapes. */
function readSession(file: ChatFile): Obj {
  let text: string;
  try { text = readFileSync(file.path, "utf8"); } catch { throw new Error("Cannot read VS Code chat counters"); }
  if (file.path.endsWith(".json")) {
    try { return obj(project(JSON.parse(text), sessionShape)); }
    catch { throw new Error("Invalid VS Code chat counter snapshot"); }
  }
  function* records() {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.trim()) continue;
      try { yield JSON.parse(lines[i]!); } catch {
        // The editor may still be appending the final line. Corruption in the
        // middle is different: replaying past it could duplicate whole turns.
        if (i === lines.length - 1 && !text.endsWith("\n")) break;
        throw new Error("Invalid VS Code chat counter log");
      }
    }
  }
  return replayVsCode(records());
}

export function scanVsCode(options: VsCodeOptions & CollectOptions): VsCodeScan {
  const files = chatFiles(options).filter((file) => file.mtime >= transcriptFloor(options.since));
  const sessions = new Set<string>();
  const requests = new Set<string>();
  const out: VsCodeRequest[] = [];
  for (const file of files) {
    const state = readSession(file);
    const sessionId = id(state.sessionId);
    // Workspace migration leaves copies. The newest snapshot owns deletions
    // and edits too; merging older snapshots would resurrect removed requests.
    if (!sessionId || sessions.has(sessionId)) continue;
    sessions.add(sessionId);
    for (const raw of Array.isArray(state.requests) ? state.requests : []) {
      const r = obj(raw);
      const requestId = id(r.requestId);
      if (!requestId || requests.has(requestId)) continue;
      requests.add(requestId);
      const metadata = obj(obj(r.result).metadata);
      const extension = obj(obj(r.agent).extensionId).value;
      if (typeof extension !== "string" || extension.toLowerCase() !== "github.copilot-chat") continue;
      // Claude and CLI sessions displayed by VS Code have their own sources.
      if (metadata.claudeSessionId || metadata.copilotSessionId) continue;
      if (typeof r.modelId !== "string" || (r.modelId.includes("/") && !r.modelId.startsWith("copilot/"))) continue;
      if (!count(r.timestamp) || !Number.isFinite(new Date(r.timestamp).getTime())) continue;
      const date = new Date(r.timestamp).toISOString().slice(0, 10);
      if (date < options.since || date > options.until) continue;
      const model = modelName(metadata.resolvedModel) ?? modelName(r.modelId.replace(/^copilot\//, ""));
      const usages: VsCodeModelUsage[] = [];
      for (const total of Array.isArray(r.modelTotals) ? r.modelTotals : []) {
        const u = obj(total); const name = modelName(u.model);
        if (name && count(u.inputTokens) && count(u.outputTokens) && count(u.cachedTokens) && u.cachedTokens <= u.inputTokens) {
          usages.push({ model: name, tokensIn: u.inputTokens - u.cachedTokens, tokensOut: u.outputTokens, tokensCacheRead: u.cachedTokens });
        }
      }
      const rounds = Array.isArray(metadata.toolCallRounds) ? metadata.toolCallRounds.length : 0;
      let lastCallOnly = false;
      if (usages.length === 0 && model) {
        const input = count(metadata.promptTokens) ? metadata.promptTokens : r.promptTokens;
        const output = count(metadata.outputTokens) ? metadata.outputTokens : r.completionTokens;
        if (count(input) && count(output)) {
          // Legacy VS Code only persists the LAST model call, not the sum of
          // an agent loop. Never multiply by rounds or derive tokens from text.
          usages.push({ model, tokensIn: input, tokensOut: output, tokensCacheRead: 0 });
          lastCallOnly = rounds !== 1;
        }
      }
      const tools = new Map<string, VsCodeRequest["tools"][number]>();
      for (const raw of Array.isArray(r.response) ? r.response : []) {
        const part = obj(raw);
        if (part.kind !== "toolInvocationSerialized") continue;
        const toolId = id(part.toolCallId);
        const name = copilotCapabilityName(part.toolId);
        if (!toolId || !name) continue;
        const source = obj(part.source);
        tools.set(toolId, { id: toolId, name, server: source.type === "mcp" ? copilotCapabilityName(source.serverLabel) : null });
      }
      out.push({
        sessionId: `vscode-${sessionId}`, requestId, date,
        cwd: cwdFromUri(state.workingDirectory) ?? file.cwd,
        usages, lastCallOnly, durationMs: count(r.elapsedMs) ? r.elapsedMs : 0,
        cancelled: obj(r.modelState).value === 2 || r.isCanceled === true,
        failed: obj(r.modelState).value === 3, rounds,
        command: copilotCapabilityName(obj(r.slashCommand).name), tools: [...tools.values()],
      });
    }
  }
  return { files: files.length, sessions: sessions.size, requests: out };
}

export class VsCodeCopilotSource implements UsageSource {
  readonly name = "copilot-vscode";
  readonly coverage = "Copilot in VS Code and Insiders: persisted token counters, repo and activity metadata";
  private readonly pricing: PricingContext;
  constructor(private readonly options: VsCodeOptions & SourceContext & { priceOf?: (model: string, usage: UsageCounts) => number } = {}) {
    this.pricing = options.pricing ?? new PricingContext();
  }
  async version(): Promise<string> { return "VS Code chat session JSON/JSONL v3"; }
  async collect(range: CollectOptions): Promise<CollectResult> {
    const scan = scanVsCode({ ...this.options, ...range });
    if (!this.options.priceOf) {
      await this.pricing.prefetch(scan.requests.flatMap((r) => r.usages.map((u) => ({ model: u.model, provider: "github-copilot" }))));
    }
    const price = this.options.priceOf ?? ((model: string, usage: UsageCounts) => this.pricing.costMicros({ model, provider: "github-copilot" }, {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    }));
    const partial = scan.requests.filter((r) => r.lastCallOnly).length;
    if (partial) console.warn(`Copilot VS Code: ${partial} request(s) only retain the last model call; recorded tokens are not full agent-loop totals.`);
    const daily = new Map<string, NormalizedDailyUsage>();
    const sessions = new Map<string, SessionRef>();
    for (const r of scan.requests) {
      if (!r.usages.length) continue;
      let cost = 0;
      for (const u of r.usages) {
        const key = `${r.date}|${u.model}`;
        const row = daily.get(key) ?? { date: r.date, agent: "copilot", model: u.model, provider: "github-copilot", tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensReasoning: 0, messageCount: 0, costMicros: 0 };
        const micros = price(u.model, { input_tokens: u.tokensIn, output_tokens: u.tokensOut, cache_read_input_tokens: u.tokensCacheRead });
        row.tokensIn += u.tokensIn; row.tokensOut += u.tokensOut; row.tokensCacheRead += u.tokensCacheRead;
        row.messageCount++; row.costMicros += micros; cost += micros; daily.set(key, row);
      }
      const session = sessions.get(r.sessionId) ?? { sessionId: r.sessionId, agent: "copilot", date: r.date, messageCount: 0, costMicros: 0 };
      session.date = r.date < session.date ? r.date : session.date;
      session.messageCount++; session.costMicros += cost; sessions.set(r.sessionId, session);
    }
    return { daily: [...daily.values()], sessions: [...sessions.values()] };
  }
}
