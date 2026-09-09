import { homedir } from "node:os";
import { join } from "node:path";
import { readCursorLog } from "./cursor-log.js";
import { repoName } from "./repo.js";
import { normalizeCursorCallId, storedCursorCallId } from "./cursor-call-id.js";

/** Completed-call metadata only. Arguments, output and error messages stay unread. */
export interface CursorToolSample {
  version: 1;
  date: string;
  conversationId: string;
  generationId: string;
  model: string | null;
  repo: string | null;
  toolId: string;
  toolName: string;
  durationMs: number | null;
  failed: boolean;
}

const KEYS = ["version", "date", "conversationId", "generationId", "model", "repo", "toolId", "toolName", "durationMs", "failed"];
function invalid(): never { throw new Error("Invalid Cursor tool metadata; collection stopped."); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) return invalid();
  return value.toLowerCase();
}
function name(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || value.length > 128 || !pattern.test(value)) return invalid();
  return value;
}
function tool(value: unknown): string {
  const valueName = name(value, /^[a-z\d][a-z\d._:-]*$/i);
  // Tool activity remains available when capability inventory is disabled.
  // MCP server and tool identities belong to that separate policy boundary.
  return /^(?:MCP:|mcp__)/i.test(valueName) ? "MCP" : valueName;
}
function duration(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function repo(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 128 || /[/\\\u0000-\u001f\u007f]/.test(value) || value === "." || value === "..") return invalid();
  return value;
}

/** The documented postToolUse and postToolUseFailure fields, cursor.com/docs/hooks. */
export function normalizeCursorTool(payload: unknown, observedAt = new Date()): CursorToolSample | null {
  const p = object(payload);
  if (p.hook_event_name !== "postToolUse" && p.hook_event_name !== "postToolUseFailure") return null;
  if (!Number.isFinite(observedAt.getTime())) return invalid();
  const conversationId = uuid(p.conversation_id), generationId = uuid(p.generation_id);
  const toolId = normalizeCursorCallId(p.tool_use_id) ?? invalid();
  const toolName = tool(p.tool_name);
  const model = p.model === undefined || p.model === null ? null : name(p.model, /^[a-z\d][a-z\d._:/+-]*$/i);
  // Cursor reports fractional milliseconds. Persist the integer milliseconds
  // required by activity aggregates without discarding an otherwise valid call.
  const rawDuration = p.duration;
  if (rawDuration !== undefined && rawDuration !== null &&
    (typeof rawDuration !== "number" || !Number.isFinite(rawDuration) || rawDuration < 0 || rawDuration > Number.MAX_SAFE_INTEGER)) return invalid();
  const durationMs = rawDuration === undefined || rawDuration === null ? null : duration(Math.round(rawDuration as number));
  let cwd = typeof p.cwd === "string" && p.cwd.length <= 4096 ? p.cwd : null;
  if (!cwd && Array.isArray(p.workspace_roots) && p.workspace_roots.length === 1) {
    const root: unknown = p.workspace_roots[0];
    if (typeof root === "string" && root.length <= 4096) cwd = root;
  }
  return { version: 1, date: observedAt.toISOString().slice(0, 10), conversationId, generationId,
    model, repo: repo(cwd ? repoName({ cwd }) : null), toolId, toolName, durationMs,
    failed: p.hook_event_name === "postToolUseFailure" };
}

export function cursorToolsPath(home = homedir()): string {
  const xdg = home === homedir() ? process.env.XDG_CONFIG_HOME : undefined;
  return join(xdg || join(home, ".config"), "kibble", "cursor-tools.jsonl");
}

function decode(value: unknown): CursorToolSample {
  const p = object(value);
  if (p.version !== 1 || Object.keys(p).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(p, key))) return invalid();
  if (typeof p.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return invalid();
  const date = new Date(`${p.date}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== p.date || typeof p.failed !== "boolean") return invalid();
  return { version: 1, date: p.date, conversationId: uuid(p.conversationId), generationId: uuid(p.generationId),
    model: p.model === null ? null : name(p.model, /^[a-z\d][a-z\d._:/+-]*$/i), repo: repo(p.repo),
    toolId: storedCursorCallId(p.toolId) ?? invalid(), toolName: tool(p.toolName),
    durationMs: duration(p.durationMs), failed: p.failed };
}

/** Read one complete initial file snapshot. A partial or conflicting log aborts collection. */
export function readCursorTools(path: string): CursorToolSample[] {
  const seen = new Map<string, CursorToolSample>();
  for (const sample of readCursorLog(path, "tool", decode)) {
    const key = JSON.stringify([sample.conversationId, sample.generationId, sample.toolId]);
    const previous = seen.get(key);
    if (previous) {
      if (JSON.stringify({ ...previous, date: sample.date }) !== JSON.stringify(sample)) {
        throw new Error("Conflicting Cursor tool metadata; collection stopped.");
      }
    } else seen.set(key, Object.freeze(sample));
  }
  return [...seen.values()];
}
