import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { copilotCapabilityName } from "./copilot-config.js";
import { PricingContext } from "./pricing.js";
import { transcriptFloor } from "./transcripts.js";
import { scanVsCodeTranscripts } from "./vscode-transcripts.js";
import type { UsageCounts } from "./capabilities.js";
import type { CollectOptions, CollectResult, NormalizedDailyUsage, SessionRef, SourceContext, UsageSource } from "./types.js";

type Obj = Record<string, unknown>;
type Shape = true | "presence" | "confirmation" | { [key: string]: Shape } | readonly [Shape];
const obj = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): string | null => typeof v === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(v) ? v : null;
const modelName = (v: unknown): string | null => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v) ? v : null;
const summaryShape: Shape = { toolCallRoundId: true, model: true, outcome: true };

// Project before replaying mutations: neither the retained state nor any
// consumer can access prompts, replies, tool arguments, output, or references.
const requestShape: Shape = {
  requestId: true, timestamp: true, responseTimestamp: true, modelId: true,
  agent: { extensionId: { value: true } },
  modelState: { value: true, completedAt: true }, isCanceled: true,
  isSystemInitiated: true,
  promptTokens: true, completionTokens: true, elapsedMs: true,
  modelTotals: [{ model: true, inputTokens: true, outputTokens: true, cachedTokens: true }],
  result: { metadata: {
    resolvedModel: true, promptTokens: true, outputTokens: true,
    claudeSessionId: true, copilotSessionId: true,
    toolCallRounds: [{ id: true, modelId: true, toolInputRetry: true,
      compaction: { type: true, id: true },
      toolCalls: [{ id: true, name: true }], thinking: { tokens: true } }],
    summary: summaryShape, summaries: [summaryShape],
  } },
  message: { parts: [{ kind: true, name: true, slashCommand: { command: true }, command: { name: true } }] },
  variableData: { variables: [{ kind: true, name: true, value: { $mid: true, kind: true } }] },
  slashCommand: { name: true },
  response: [{ kind: true, toolId: true, toolCallId: true, isComplete: true,
    // A legacy markdown part has no kind. Count its existence, not its text.
    value: "presence", hookType: true, stopReason: "presence", subAgentInvocationId: true,
    isConfirmed: "confirmation", resultDetails: { isError: true },
    toolSpecificData: { kind: true, requestUnsandboxedExecution: true,
      terminalCommandState: { exitCode: true, duration: true }, duration: true },
    source: { type: true, serverLabel: true } }],
};
const sessionShape: Shape = { sessionId: true, workingDirectory: true, requests: [requestShape] };

function project(value: unknown, shape: Shape): unknown {
  if (shape === "presence") return true;
  if (shape === "confirmation") return typeof value === "boolean" ? value : project(value, { type: true });
  if (shape === true) return value === null || ["string", "number", "boolean"].includes(typeof value) ? value : undefined;
  if (Array.isArray(shape)) return Array.isArray(value) ? value.map((v) => project(v, shape[0]!)) : undefined;
  const result: Obj = Object.create(null);
  const source = obj(value);
  for (const [key, child] of Object.entries(shape)) {
    if (Object.hasOwn(source, key)) result[key] = child === "presence" ? true : project(source[key], child);
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
      else if (shape === "confirmation" && key === "type") shape = true;
      else if (typeof shape === "object" && !Array.isArray(shape) && typeof key === "string" && Object.hasOwn(shape, key)) {
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
    if (entry.kind === 1) parent[key] = shape === "presence" ? true : project(entry.v, shape);
    else if (entry.kind === 3) delete parent[key];
    else if (shape === "presence") parent[key] = true;
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
  tools: {
    id: string; name: string; server: string | null; model: string | null;
    outcome: "success" | "error" | "cancelled" | "unknown";
    durationMs: number | null; sandboxBypass: boolean; subagent: boolean;
  }[];
  humanInitiated: boolean;
  thinkingBlocks: number; textBlocks: number; hookRuns: number; hookErrors: number;
  compactions: number; toolInputRetries: number; tokensReasoning: number;
  promptNames: string[];
  explicitCapabilities: { kind: "skill" | "command"; name: string }[];
  /** Existing wire counter names whose source coverage is incomplete. */
  unavailableMetrics: string[];
}
export interface VsCodeScan { files: number; sessions: number; requests: VsCodeRequest[] }

function transcriptToolId(tool: VsCodeRequest["tools"][number]): string {
  const nativeId = tool.subagent ? tool.id.slice(tool.id.lastIndexOf(":") + 1) : tool.id;
  return /__vscode-\d+$/.test(nativeId) ? nativeId.split("__vscode-")[0]! : nativeId;
}

// Evidence: VS Code 1.135.0 (08d4889f), chatService.ts,
// model/chatProgressTypes/chatToolInvocation.ts and Copilot's
// prompt/common/{conversation,intents}.ts. isComplete is serialized as true
// even for cancelled/uncompleted calls, so it never proves tool success.
function activity(r: Obj, metadata: Obj, compactionIds: Set<string>) {
  const tools = new Map<string, VsCodeRequest["tools"][number]>();
  const makeTool = (callId: string, name: string): VsCodeRequest["tools"][number] => ({
    id: callId, name, server: null, model: null, outcome: "unknown", durationMs: null,
    sandboxBypass: false, subagent: false,
  });
  const roundMap = new Map<string | number, Obj>();
  const rawRounds = Array.isArray(metadata.toolCallRounds) ? metadata.toolCallRounds : [];
  rawRounds.forEach((raw, index) => { const round = obj(raw); roundMap.set(id(round.id) ?? index, round); });
  const rounds = [...roundMap.values()];
  let compactions = 0, toolInputRetries = 0, tokensReasoning = 0;
  for (const round of rounds) {
    if (count(round.toolInputRetry) && round.toolInputRetry > 0) toolInputRetries++;
    if (count(obj(round.thinking).tokens)) tokensReasoning += obj(round.thinking).tokens as number;
    const compaction = obj(round.compaction);
    const compactionId = id(compaction.id);
    if (compaction.type === "compaction" && compactionId && !compactionIds.has(compactionId)) {
      compactionIds.add(compactionId); compactions++;
    }
    for (const raw of Array.isArray(round.toolCalls) ? round.toolCalls : []) {
      const call = obj(raw); const callId = id(call.id); const name = copilotCapabilityName(call.name);
      if (!callId || !name) continue;
      const tool = tools.get(callId) ?? makeTool(callId, name);
      tool.model = modelName(round.modelId);
      tools.set(callId, tool);
    }
  }
  // These metadata entries describe completed summaries, but may be repeated
  // when history is normalized. Count their stable round identities once.
  const summaries = Array.isArray(metadata.summaries) ? metadata.summaries : metadata.summary ? [metadata.summary] : [];
  for (const raw of summaries) {
    const summary = obj(raw); const roundId = id(summary.toolCallRoundId);
    if (!roundId || (summary.outcome !== undefined && summary.outcome !== "success")) continue;
    const key = `summary-${roundId}`;
    if (!compactionIds.has(key)) { compactionIds.add(key); compactions++; }
  }
  // Copilot appends __vscode-<counter> to native IDs, then uses the portion
  // before __vscode for rendered cards. Keep native IDs distinct: the same
  // model-provided ID can be reused for several actual calls.
  // toolCallingLoop.ts#createInternalToolCallId / toolCalling.tsx
  const cardAliases = new Map<string, string[]>();
  for (const nativeId of tools.keys()) {
    const cardId = /__vscode-\d+$/.test(nativeId) ? nativeId.split("__vscode")[0]! : nativeId;
    const candidates = cardAliases.get(cardId) ?? [];
    candidates.push(nativeId);
    cardAliases.set(cardId, candidates);
  }
  let thinkingBlocks = 0, textBlocks = 0, hookRuns = 0, hookErrors = 0;
  for (const raw of Array.isArray(r.response) ? r.response : []) {
    const part = obj(raw);
    if (part.kind === "thinking") thinkingBlocks++;
    else if (part.kind === "markdownContent" || (part.kind === undefined && part.value === true)) textBlocks++;
    // A stop reason can be an intentional policy block from a successful hook,
    // not an execution failure. Saved hook markers do not carry resultKind.
    else if (part.kind === "hook") hookRuns++;
    if (part.kind !== "toolInvocationSerialized") continue;
    const callId = id(part.toolCallId); const name = copilotCapabilityName(part.toolId);
    if (!callId || !name) continue;
    const subagentId = id(part.subAgentInvocationId);
    if (Object.hasOwn(part, "subAgentInvocationId") && part.subAgentInvocationId !== null && !subagentId) {
      throw new Error("Invalid VS Code subagent tool scope");
    }
    const candidates = subagentId ? undefined : cardAliases.get(callId);
    // A card with an ambiguous reused ID represents an already counted native
    // call, but cannot establish which call owns its outcome or duration.
    if (candidates && candidates.length > 1) continue;
    const key = subagentId ? `subagent:${subagentId}:${callId}` : candidates?.[0] ?? callId;
    const tool = tools.get(key) ?? makeTool(key, name);
    // The serialized tool ID is the editor's canonical tool identifier.
    tool.name = name;
    const source = obj(part.source);
    tool.server = source.type === "mcp" ? copilotCapabilityName(source.serverLabel) : null;
    tool.subagent = subagentId !== null;
    const specific = obj(part.toolSpecificData);
    const terminal = specific.kind === "terminal" ? obj(specific.terminalCommandState) : {};
    const confirmation = obj(part.isConfirmed).type;
    const denied = part.isConfirmed === false || confirmation === 0 || confirmation === 5;
    const isError = obj(part.resultDetails).isError;
    const exit = terminal.exitCode;
    if (denied) tool.outcome = "cancelled";
    else if (isError === true || (typeof exit === "number" && Number.isSafeInteger(exit) && exit !== 0)) tool.outcome = "error";
    else if (isError === false || exit === 0) tool.outcome = "success";
    if (count(terminal.duration)) tool.durationMs = terminal.duration;
    // A subagent tool's recorded duration is tool wall time, never turn time.
    else if (specific.kind === "subagent" && count(specific.duration)) tool.durationMs = specific.duration;
    tool.sandboxBypass = specific.kind === "terminal" && specific.requestUnsandboxedExecution === true;
    tools.set(key, tool);
  }
  const promptNames = new Set<string>();
  const explicitCapabilities = new Map<string, VsCodeRequest["explicitCapabilities"][number]>();
  let command = copilotCapabilityName(obj(r.slashCommand).name);
  for (const raw of Array.isArray(obj(r.message).parts) ? obj(r.message).parts as unknown[] : []) {
    const part = obj(raw);
    if (part.kind === "prompt") { const name = copilotCapabilityName(part.name); if (name) promptNames.add(name); }
    if (part.kind === "slash") command ??= copilotCapabilityName(obj(part.slashCommand).command);
    if (part.kind === "subcommand") command ??= copilotCapabilityName(obj(part.command).name);
  }
  for (const raw of Array.isArray(obj(r.variableData).variables) ? obj(r.variableData).variables as unknown[] : []) {
    const entry = obj(raw); const value = obj(entry.value); const name = copilotCapabilityName(entry.name);
    if (entry.kind === "generic" && value.$mid === "agentHostCompletion" && ["skill", "command"].includes(String(value.kind)) && name) {
      explicitCapabilities.set(`${value.kind}|${name}`, { kind: value.kind as "skill" | "command", name });
    }
  }
  return { tools: [...tools.values()], rounds: rounds.length, thinkingBlocks, textBlocks,
    hookRuns, hookErrors, compactions, toolInputRetries, tokensReasoning, command,
    promptNames: [...promptNames], explicitCapabilities: [...explicitCapabilities.values()] };
}

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
  const compactions = new Map<string, Set<string>>();
  const out: VsCodeRequest[] = [];
  // Transcript tool IDs have neither request nor child-agent scope. Uniqueness
  // must hold across the entire saved session, not just the requested dates.
  type TimingCandidate = { tool: VsCodeRequest["tools"][number]; requestStartMs: number | null };
  const timingCandidates = new Map<string, Map<string, TimingCandidate[]>>();
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
      const date = count(r.timestamp) && Number.isFinite(new Date(r.timestamp).getTime())
        ? new Date(r.timestamp).toISOString().slice(0, 10) : null;
      const inRange = date !== null && date >= options.since && date <= options.until;
      const compactionIds = inRange ? compactions.get(sessionId) ?? new Set<string>() : new Set<string>();
      if (inRange) compactions.set(sessionId, compactionIds);
      const details = activity(r, metadata, compactionIds);
      const candidates = timingCandidates.get(sessionId) ?? new Map<string, TimingCandidate[]>();
      timingCandidates.set(sessionId, candidates);
      for (const tool of details.tools) {
        const key = transcriptToolId(tool);
        const matches = candidates.get(key) ?? [];
        matches.push({ tool, requestStartMs: date !== null ? r.timestamp as number : null });
        candidates.set(key, matches);
      }
      if (!inRange || date === null) continue;
      const model = modelName(metadata.resolvedModel) ?? modelName(r.modelId.replace(/^copilot\//, ""));
      const usages: VsCodeModelUsage[] = [];
      const totalModels = new Set<string>();
      if (Object.hasOwn(r, "modelTotals") && !Array.isArray(r.modelTotals)) throw new Error("Invalid VS Code whole-turn token totals");
      for (const total of Array.isArray(r.modelTotals) ? r.modelTotals : []) {
        const u = obj(total); const name = modelName(u.model);
        if (!name || !count(u.inputTokens) || !count(u.outputTokens) || !count(u.cachedTokens) || u.cachedTokens > u.inputTokens || totalModels.has(name)) {
          // A partially accepted authoritative list would silently replace a
          // previously complete day with less spend on the next ingest.
          throw new Error("Invalid or duplicate VS Code whole-turn model totals");
        }
        totalModels.add(name);
        usages.push({ model: name, tokensIn: u.inputTokens - u.cachedTokens, tokensOut: u.outputTokens, tokensCacheRead: u.cachedTokens });
      }
      const rounds = details.rounds;
      let lastCallOnly = false;
      let outputComplete = usages.length > 0;
      if (usages.length === 0 && model) {
        const input = count(metadata.promptTokens) ? metadata.promptTokens : r.promptTokens;
        const singleModel = Array.isArray(metadata.toolCallRounds) && metadata.toolCallRounds.length > 0 &&
          metadata.toolCallRounds.every((raw) => modelName(obj(raw).modelId) === model);
        // chatModel.ts accumulates completionTokens across model calls, while
        // metadata.outputTokens is the last successful call. That running sum
        // can be attributed only when every recorded round names this model.
        const accumulatedOutput = singleModel && count(r.completionTokens);
        const output = accumulatedOutput ? r.completionTokens : count(metadata.outputTokens) ? metadata.outputTokens : r.completionTokens;
        if (count(input) && count(output)) {
          // Legacy VS Code only persists the LAST model call, not the sum of
          // an agent loop. Never multiply by rounds or derive tokens from text.
          usages.push({ model, tokensIn: input, tokensOut: output, tokensCacheRead: 0 });
          lastCallOnly = rounds !== 1;
          outputComplete = accumulatedOutput || rounds === 1;
        }
      }
      // Saved chat is not a complete telemetry stream. Preserve partial facts,
      // but never let absent outcomes or timers become a measured zero.
      const unavailable = new Set([
        "sidechainMessages", "tokensCacheWrite", "tokensCacheWrite1h", "tokensCacheWrite5m",
        "tokensReasoning", "webSearchRequests", "webFetchRequests", "edits", "hunks",
        "linesAdded", "linesRemoved", "userModified", "apiErrors", "hookRuns", "hookErrors",
        "sandboxDisabled", "compactions",
        // Saved request counts and model rounds do not establish Claude's
        // assistant-message or turn_duration.numMessages denominators.
        "messageCount", "turnMessages", "turnMessagesMax",
      ]);
      if (!Array.isArray(r.response)) for (const key of ["thinkingBlocks", "textBlocks", "toolCalls", "toolErrors", "interrupted", "toolTimed", "toolDurationMs"]) unavailable.add(key);
      if (!Array.isArray(metadata.toolCallRounds)) unavailable.add("iterations");
      if (!count(r.elapsedMs)) for (const key of ["turnDurationMs", "turnDurationMsMax"]) unavailable.add(key);
      // chatModel.toJSON() serializes Pending/NeedsInput as Cancelled too.
      // That state alone is not evidence that a request was interrupted.
      if (obj(r.modelState).value === 2 && r.isCanceled !== true) unavailable.add("interrupted");
      if (details.tools.some((tool) => tool.outcome === "unknown")) for (const key of ["toolErrors", "interrupted"]) unavailable.add(key);
      if (details.tools.some((tool) => tool.durationMs === null)) for (const key of ["toolTimed", "toolDurationMs"]) unavailable.add(key);
      if (lastCallOnly || usages.length === 0) for (const key of ["tokensIn", "tokensOut", "tokensCacheRead", "costMicros"]) unavailable.add(key);
      if (outputComplete) unavailable.delete("tokensOut");
      // Last-call fields contain no cache breakdown even on single-call turns.
      if (!Array.isArray(r.modelTotals) || r.modelTotals.length === 0) { unavailable.add("tokensCacheRead"); unavailable.add("costMicros"); }
      out.push({
        sessionId: `vscode-${sessionId}`, requestId, date,
        cwd: cwdFromUri(state.workingDirectory) ?? file.cwd,
        usages, lastCallOnly, durationMs: count(r.elapsedMs) ? r.elapsedMs : 0,
        cancelled: r.isCanceled === true,
        failed: obj(r.modelState).value === 3,
        humanInitiated: r.isSystemInitiated !== true,
        ...details, unavailableMetrics: [...unavailable].sort(),
      });
    }
  }
  const selectedSessions = new Set(out.map((request) => request.sessionId.slice("vscode-".length)));
  if (selectedSessions.size) {
    const transcripts = scanVsCodeTranscripts({ userDataDirs: vsCodeDataDirs(options), sessionIds: selectedSessions });
    for (const interval of transcripts.tools) {
      if (!interval.uniqueInSession) continue;
      const candidates = timingCandidates.get(interval.sessionId)?.get(interval.toolCallId);
      if (candidates?.length !== 1) continue;
      const candidate = candidates[0]!;
      if (candidate.tool.durationMs !== null || candidate.requestStartMs === null ||
        interval.startMs < candidate.requestStartMs) continue;
      // A deleted/rewound request can leave an old transcript interval behind.
      // A reused model ID in a newer request must not inherit that old timer.
      // This measures invocation wall time, including any approval wait. Keep
      // a more specific saved terminal/subagent timer when one already exists.
      // executionResolved is deliberately not mapped to a semantic outcome.
      candidate.tool.durationMs = interval.endMs - interval.startMs;
    }
    for (const request of out) {
      if (!request.tools.length || request.unavailableMetrics.includes("toolCalls") ||
        request.tools.some((tool) => tool.durationMs === null)) continue;
      request.unavailableMetrics = request.unavailableMetrics.filter((metric) => metric !== "toolTimed" && metric !== "toolDurationMs");
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
    if (partial) console.warn(`Copilot VS Code: ${partial} request(s) lack full per-model input totals; recorded tokens are not full agent-loop totals.`);
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
