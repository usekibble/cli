import { homedir } from "node:os";
import { join } from "node:path";
import { readCursorLog } from "./cursor-log.js";
import { repoName } from "./repo.js";
import { normalizeCursorCallId, storedCursorCallId } from "./cursor-call-id.js";

/** Local-only receipt timestamps measure observed turn time, never session time. */
export interface CursorActivitySample {
  version: 1;
  event: "beforeSubmitPrompt" | "stop" | "subagentStop";
  date: string;
  observedMs: number;
  conversationId: string;
  generationId: string;
  model: string | null;
  repo: string | null;
  status: "completed" | "aborted" | "error" | null;
  cursorVersion: string | null;
  subagentId?: string;
  sidechainMessages?: number;
  /** Child duration stays local: it is not a parent turn or tool duration. */
  subagentDurationMs?: number;
  /** Derived after pairing, not a persisted field. */
  durationMs?: number | null;
}
const KEYS = ["version", "event", "date", "observedMs", "conversationId", "generationId", "model", "repo", "status", "cursorVersion"];
const SUBAGENT_KEYS = [...KEYS, "subagentId", "sidechainMessages", "subagentDurationMs"];
function invalid(): never { throw new Error("Invalid Cursor activity metadata; collection stopped."); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) return invalid();
  return value.toLowerCase();
}
function name(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 128 || !/^[a-z\d][a-z\d._:/+-]*$/i.test(value)) return invalid();
  return value;
}
function repo(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 128 || /[/\\\u0000-\u001f\u007f]/.test(value) || value === "." || value === "..") return invalid();
  return value;
}
function version(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,8}(?:[.-][a-z\d.-]{1,32})?$/i.test(value)) return invalid();
  return value;
}
function status(value: unknown): CursorActivitySample["status"] {
  if (value == null) return null;
  if (value !== "completed" && value !== "aborted" && value !== "error") return invalid();
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function duration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return invalid();
  return count(Math.round(value));
}

/** cursor.com/docs/hooks: read common metadata only, never prompt or attachments. */
export function normalizeCursorActivity(payload: unknown, observedAt = new Date()): CursorActivitySample | null {
  const p = object(payload);
  if (p.hook_event_name !== "beforeSubmitPrompt" && p.hook_event_name !== "stop" && p.hook_event_name !== "subagentStop") return null;
  // Follow-up generations still establish completed activity. Pair and dedup
  // by their exact generation IDs, never by the conversation's loop number.
  if (p.hook_event_name !== "beforeSubmitPrompt" && p.loop_count !== undefined) {
    if (typeof p.loop_count !== "number" || !Number.isSafeInteger(p.loop_count) || p.loop_count < 0) return invalid();
  }
  const observedMs = observedAt.getTime();
  if (!Number.isSafeInteger(observedMs) || observedMs < 0) return invalid();
  let cwd = typeof p.cwd === "string" && p.cwd.length <= 4096 ? p.cwd : null;
  if (!cwd && Array.isArray(p.workspace_roots) && p.workspace_roots.length === 1) {
    const root: unknown = p.workspace_roots[0];
    if (typeof root === "string" && root.length <= 4096) cwd = root;
  }
  return { version: 1, event: p.hook_event_name, date: observedAt.toISOString().slice(0, 10), observedMs,
    conversationId: id(p.conversation_id), generationId: id(p.generation_id), model: name(p.model),
    repo: repo(cwd ? repoName({ cwd }) : null), status: p.hook_event_name !== "beforeSubmitPrompt" ? status(p.status) : null,
    cursorVersion: version(p.cursor_version),
    ...(p.hook_event_name === "subagentStop" ? { subagentId: normalizeCursorCallId(p.subagent_id) ?? invalid(), sidechainMessages: count(p.message_count), subagentDurationMs: duration(p.duration_ms) } : {}) };
}

export function cursorActivityPath(home = homedir()): string {
  const xdg = home === homedir() ? process.env.XDG_CONFIG_HOME : undefined;
  return join(xdg || join(home, ".config"), "kibble", "cursor-activity.jsonl");
}

function decode(value: unknown): CursorActivitySample {
  const p = object(value);
  const keys = p.event === "subagentStop" ? SUBAGENT_KEYS : KEYS;
  if (Object.keys(p).length !== keys.length || keys.some(key => !Object.hasOwn(p, key)) || p.version !== 1) return invalid();
  if (p.event !== "beforeSubmitPrompt" && p.event !== "stop" && p.event !== "subagentStop") return invalid();
  if (typeof p.observedMs !== "number" || !Number.isSafeInteger(p.observedMs) || p.observedMs < 0 || !Number.isFinite(new Date(p.observedMs).getTime())) return invalid();
  if (new Date(p.observedMs).toISOString().slice(0, 10) !== p.date) return invalid();
  if (p.event === "beforeSubmitPrompt" && p.status !== null) return invalid();
  return { version: 1, event: p.event, date: p.date as string, observedMs: p.observedMs,
    conversationId: id(p.conversationId), generationId: id(p.generationId), model: name(p.model),
    repo: repo(p.repo), status: status(p.status), cursorVersion: version(p.cursorVersion),
    ...(p.event === "subagentStop" ? { subagentId: storedCursorCallId(p.subagentId) ?? invalid(), sidechainMessages: count(p.sidechainMessages), subagentDurationMs: count(p.subagentDurationMs) } : {}) };
}

export function readCursorActivity(path: string): CursorActivitySample[] {
  const seen = new Map<string, CursorActivitySample>();
  for (const sample of readCursorLog(path, "activity", decode)) {
    const key = JSON.stringify([sample.conversationId, sample.event === "subagentStop" ? sample.subagentId : sample.generationId, sample.event]);
    const previous = seen.get(key);
    if (previous) {
      if (JSON.stringify({ ...previous, date: sample.date, observedMs: sample.observedMs }) !== JSON.stringify(sample)) {
        throw new Error("Conflicting Cursor activity metadata; collection stopped.");
      }
    } else seen.set(key, sample);
  }
  return [...seen.values()].map(sample => {
    const start = seen.get(JSON.stringify([sample.conversationId, sample.generationId, "beforeSubmitPrompt"]));
    // Different repositories or a backwards clock cannot establish turn time.
    const durationMs = sample.event === "stop" && start && start.repo === sample.repo && sample.observedMs >= start.observedMs
      ? sample.observedMs - start.observedMs : null;
    return { ...sample, durationMs };
  });
}
