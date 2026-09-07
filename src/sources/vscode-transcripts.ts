import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const sessionPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
function invalid(): never { throw new Error("Invalid VS Code tool transcript metadata"); }

export interface VsCodeToolInterval {
  sessionId: string;
  /** Original model ID, with VS Code's internal uniqueness suffix removed. */
  toolCallId: string;
  toolName: string;
  startEventId: string;
  completeEventId: string;
  startMs: number;
  endMs: number;
  /** Promise resolution only. False includes cancellation; true is not semantic success. */
  executionResolved: boolean;
  /** Exactly one start and completion for this base ID in the entire file. */
  uniqueInSession: boolean;
}

// Verified against VS Code 1.135.0, commit 08d4889f:
// extensions/copilot/src/extension/chat/vscode-node/sessionTranscriptService.ts.
// Tool timestamps bracket invokeToolWithEndpoint in prompts/node/panel/toolCalling.tsx;
// they include any confirmation wait and do not establish semantic tool outcomes.
/** Reads only structured envelope and tool execution metadata, never message bodies. */
export function parseVsCodeTranscript(records: Iterable<unknown>, expectedSessionId: string): VsCodeToolInterval[] {
  if (!sessionPattern.test(expectedSessionId)) invalid();
  type Start = { toolCallId: string; toolName: string; startEventId: string; startMs: number };
  const pending = new Map<string, { start: Start; outstanding: number; ambiguous: boolean }>();
  const seen = new Set<string>();
  const occurrences = new Map<string, { starts: number; completions: number }>();
  const intervals: VsCodeToolInterval[] = [];
  let previousId: string | null = null;
  let started = false;
  for (const value of records) {
    const raw = obj(value);
    const type = raw.type;
    const eventId = raw.id;
    const parentId = raw.parentId;
    const timestamp = raw.timestamp;
    if (typeof type !== "string" || !identifier(eventId) ||
      (parentId !== null && !identifier(parentId)) || typeof timestamp !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) invalid();
    const milliseconds = Date.parse(timestamp);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || new Date(milliseconds).toISOString() !== timestamp || seen.has(eventId)) invalid();
    seen.add(eventId);
    // Resuming an existing file resets parentId, without replay or a new start.
    // Never join a completion across that unobserved editor-process boundary.
    if (parentId === null) pending.clear();
    else if (parentId !== previousId) invalid();
    previousId = eventId;
    if (type === "session.start") {
      const data = obj(raw.data);
      if (started || data.sessionId !== expectedSessionId || data.version !== 1 || data.producer !== "copilot-agent" || parentId !== null) invalid();
      started = true;
      continue;
    }
    if (!started) invalid();
    // History replay synthesizes message/turn records, not execution events.
    // Other record payloads are deliberately never traversed.
    if (type !== "tool.execution_start" && type !== "tool.execution_complete") continue;
    const data = obj(raw.data);
    const toolCallId = data.toolCallId;
    if (!identifier(toolCallId)) invalid();
    const frequency = occurrences.get(toolCallId) ?? { starts: 0, completions: 0 };
    occurrences.set(toolCallId, frequency);
    if (type === "tool.execution_start") {
      frequency.starts++;
      const toolName = data.toolName;
      if (typeof toolName !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(toolName)) invalid();
      const existing = pending.get(toolCallId);
      if (existing) {
        existing.outstanding++;
        existing.ambiguous = true;
      } else pending.set(toolCallId, { start: { toolCallId, toolName, startEventId: eventId, startMs: milliseconds }, outstanding: 1, ambiguous: false });
    } else {
      frequency.completions++;
      const executionResolved = data.success;
      if (typeof executionResolved !== "boolean") invalid();
      const match = pending.get(toolCallId);
      // A failure can be logged before execution starts (input/hook failure).
      if (!match) continue;
      if (milliseconds < match.start.startMs) invalid();
      match.outstanding--;
      if (match.outstanding === 0) pending.delete(toolCallId);
      if (!match.ambiguous) intervals.push({ sessionId: expectedSessionId, ...match.start,
        completeEventId: eventId, endMs: milliseconds, executionResolved, uniqueInSession: false });
    }
  }
  // Count even unmatched records and records on previous process chains. One
  // emitted interval can otherwise hide another pending use of the same ID.
  for (const interval of intervals) {
    const frequency = occurrences.get(interval.toolCallId)!;
    interval.uniqueInSession = frequency.starts === 1 && frequency.completions === 1;
  }
  return intervals;
}

function children(dir: string): string[] {
  try { return readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Cannot list VS Code tool transcript storage");
  }
}

/** Existing extension workspace storage only. Does not enable hooks or logging. */
export function scanVsCodeTranscripts(options: { userDataDirs: readonly string[]; sessionIds?: ReadonlySet<string> }): { files: number; tools: VsCodeToolInterval[] } {
  const files: { path: string; sessionId: string; mtime: number }[] = [];
  const paths = new Set<string>();
  for (const root of options.userDataDirs) {
    const workspaces = join(root, "User", "workspaceStorage");
    for (const workspace of children(workspaces)) {
      const dir = join(workspaces, workspace, "GitHub.copilot-chat", "transcripts");
      for (const name of children(dir)) {
        if (!name.endsWith(".jsonl") || !sessionPattern.test(name.slice(0, -6))) continue;
        if (options.sessionIds && !options.sessionIds.has(name.slice(0, -6))) continue;
        try {
          const path = realpathSync(join(dir, name));
          const stat = statSync(path);
          if (!stat.isFile() || paths.has(path)) continue;
          paths.add(path);
          files.push({ path, sessionId: name.slice(0, -6), mtime: stat.mtimeMs });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot inspect VS Code tool transcript storage");
        }
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  const sessions = new Set<string>();
  const tools: VsCodeToolInterval[] = [];
  for (const file of files) {
    if (sessions.has(file.sessionId)) continue;
    sessions.add(file.sessionId);
    let text: string;
    try { text = readFileSync(file.path, "utf8"); } catch { throw new Error("Cannot read VS Code tool transcript metadata"); }
    let partialTail = false;
    function* records() {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(lines[i]!); } catch {
          if (i === lines.length - 1 && !text.endsWith("\n")) { partialTail = true; break; }
          invalid();
        }
        yield value;
      }
    }
    const intervals = parseVsCodeTranscript(records(), file.sessionId);
    // An unfinished record might introduce another use of a previously seen
    // base ID. Keep measured pairs, but do not claim safe joins until flushed.
    if (partialTail) for (const interval of intervals) interval.uniqueInSession = false;
    tools.push(...intervals);
  }
  return { files: files.length, tools };
}
