import { looksLikePath, repoName } from "./repo.js";
import type { UsageCounts } from "./capabilities.js";
import { TranscriptDeduper } from "./transcript-dedup.js";
import { codexDuration, codexItem, codexSettings, codexTool, CodexTokenReader } from "./codex.js";
import type { Rec, TranscriptVisitor } from "./transcripts.js";

/**
 * The sidecar: what each repo cost, and what the agent did there.
 *
 * Neither tokscale surface reports a workspace, so this reads the transcripts
 * directly. Claude Code records `cwd` on every record; Codex records `cwd`
 * plus a git remote in its session header. Having opened the file for that
 * one field, everything else here is read from the same records: record
 * types, block types, enum values, booleans and integers. The message bodies
 * are never opened.
 *
 * The walk itself is `transcripts.ts`, so that one read and one parse of each
 * file feeds this and `capabilities.ts` together; `sources/local.ts` drives
 * both. This file is the visitor, not the reader.
 *
 * WHAT LEAVES THE MACHINE: a repo NAME, branch names, token counts, counts of
 * things (tool calls, errors, turns, edits, lines, hook failures) and the
 * names of enum-like things (tool names, client version, entrypoint, effort,
 * stop reason, attachment kind, hook name). The absolute path is read,
 * reduced by `repoName()`, and discarded -- see repo.ts for why.
 *
 * WHAT IS NEVER READ: message text, thinking, tool arguments, tool output
 * (`stdout`, `stderr`, `content`), file contents (`originalFile`,
 * `oldString`, `newString`), file paths inside edits, hostnames. The line
 * counts on an edit come from the first character of each diff line and the
 * hunk headers, never from the line itself.
 *
 * The server's ingest schema is `.strict()` and lists every field below by
 * name, so this file cannot quietly widen what is sent: a new field is a plan
 * decision on both ends.
 */

/**
 * The name-valued dimensions. Each is a small closed vocabulary (a tool name,
 * a version string, an enum) counted per repo-day. The server rejects any
 * facet not on this list.
 */
export const REPO_FACETS = [
  /** `tool_use.name` in Claude Code; the semantic item kind in Codex, MCP as `mcp__<server>`. */
  "tool",
  /** Which model answered, per repo. */
  "model",
  /** `cli`, `claude-desktop`, `claude-vscode`, `sdk-cli`. Codex: `originator`. */
  "entrypoint",
  /** The client version that wrote the record. */
  "version",
  /** Reasoning effort the request ran at. */
  "effort",
  /** `usage.service_tier`. */
  "service_tier",
  /** `usage.speed`. */
  "speed",
  /** `message.stop_reason`. A rising `max_tokens` share is work being cut off. */
  "stop_reason",
  /** Runtime notices the client injected (`attachment.type`). */
  "attachment",
  /** A hook that failed: `<hookName> exit <code>`. Never its command or output. */
  "hook_error",
  /** Codex `item_completed.item.type`: the only cross-agent tool grain Codex offers. */
  "item",
  /** Codex `turn_context.approval_policy`. */
  "approval_policy",
  /** Codex `turn_context.sandbox_policy.type`. */
  "sandbox_policy",
  /** Codex `session_meta.model_provider`. */
  "provider",
] as const;
export type RepoFacet = (typeof REPO_FACETS)[number];

export interface RepoFacetCount {
  facet: RepoFacet;
  value: string;
  count: number;
}

/** Counters on a repo-day. Every one is an integer; every one is a sum or a max. */
export interface RepoActivity {
  /** Distinct session ids seen in the repo that day. */
  sessions: number;
  /** `tool_use` blocks (Claude Code); classified or legacy completed tool items (Codex). */
  toolCalls: number;
  /** `tool_result.is_error` (Claude Code); a failed or declined completed tool item (Codex). Conflates a rejection with a failure. */
  toolErrors: number;
  /** Tool calls that reported a duration, and their total wall clock. */
  toolTimed: number;
  toolDurationMs: number;
  thinkingBlocks: number;
  textBlocks: number;
  /** A `user` record with no `tool_result` block is a person typing. Codex reports it directly. */
  humanTurns: number;
  /** Agentic turns (`turn_duration` in Claude Code, task/turn lifecycle events in Codex), their wall clock and message counts. */
  turns: number;
  turnDurationMs: number;
  turnDurationMsMax: number;
  turnMessages: number;
  turnMessagesMax: number;
  /** Model calls inside agentic turns (`usage.iterations[]`). */
  iterations: number;
  /** Records that belong to a subagent rather than the main thread. */
  sidechainMessages: number;
  tokensReasoning: number;
  tokensCacheWrite1h: number;
  tokensCacheWrite5m: number;
  /** Server-side tools, billed outside the token math. */
  webSearchRequests: number;
  webFetchRequests: number;
  /** Edits that carried a diff, their hunks, and the lines added and removed. */
  edits: number;
  hunks: number;
  linesAdded: number;
  linesRemoved: number;
  /** A tool call the person stopped. */
  interrupted: number;
  /** A human rewrote what the agent produced before it landed. */
  userModified: number;
  /** A shell call that ran outside the sandbox. */
  sandboxDisabled: number;
  /** API calls that errored and were retried. */
  apiErrors: number;
  /** Recorded completed compactions, including manual compactions. */
  compactions: number;
  hookRuns: number;
  hookErrors: number;
}

export const ACTIVITY_KEYS = [
  "sessions",
  "toolCalls",
  "toolErrors",
  "toolTimed",
  "toolDurationMs",
  "thinkingBlocks",
  "textBlocks",
  "humanTurns",
  "turns",
  "turnDurationMs",
  "turnDurationMsMax",
  "turnMessages",
  "turnMessagesMax",
  "iterations",
  "sidechainMessages",
  "tokensReasoning",
  "tokensCacheWrite1h",
  "tokensCacheWrite5m",
  "webSearchRequests",
  "webFetchRequests",
  "edits",
  "hunks",
  "linesAdded",
  "linesRemoved",
  "interrupted",
  "userModified",
  "sandboxDisabled",
  "apiErrors",
  "compactions",
  "hookRuns",
  "hookErrors",
] as const satisfies readonly (keyof RepoActivity)[];

export interface RepoUsage extends RepoActivity {
  date: string;
  agent: string;
  repo: string;
  /**
   * The first branch seen for this repo-day. A sample, kept for servers that
   * predate `branches`; `branches` is the accurate field.
   */
  branch: string | null;
  /**
   * Every branch the repo saw that day, sorted. A branch is the nearest thing
   * to a unit of work the collector can see, and the server counts them, so
   * reporting only the first would undercount the day's work by however often
   * the engineer switched. Names only, like `repo`, and never a path.
   */
  branches: string[];
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  messageCount: number;
  costMicros: number;
  facets: RepoFacetCount[];
}

/** Per facet, the most common values are kept; the tail is dropped, never merged. */
const FACET_VALUES_PER_ROW = 100;
const FACET_VALUE_MAX = 128;


function obj(v: unknown): Rec {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
}
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, FACET_VALUE_MAX) : null;
}

class Acc implements RepoActivity {
  tokensIn = 0;
  tokensOut = 0;
  tokensCacheRead = 0;
  tokensCacheWrite = 0;
  messageCount = 0;
  costMicros = 0;
  branch: string | null = null;
  branches = new Set<string>();
  sessionIds = new Set<string>();
  facets = new Map<RepoFacet, Map<string, number>>();

  sessions = 0;
  toolCalls = 0;
  toolErrors = 0;
  toolTimed = 0;
  toolDurationMs = 0;
  thinkingBlocks = 0;
  textBlocks = 0;
  humanTurns = 0;
  turns = 0;
  turnDurationMs = 0;
  turnDurationMsMax = 0;
  turnMessages = 0;
  turnMessagesMax = 0;
  iterations = 0;
  sidechainMessages = 0;
  tokensReasoning = 0;
  tokensCacheWrite1h = 0;
  tokensCacheWrite5m = 0;
  webSearchRequests = 0;
  webFetchRequests = 0;
  edits = 0;
  hunks = 0;
  linesAdded = 0;
  linesRemoved = 0;
  interrupted = 0;
  userModified = 0;
  sandboxDisabled = 0;
  apiErrors = 0;
  compactions = 0;
  hookRuns = 0;
  hookErrors = 0;

  facet(facet: RepoFacet, value: string | null, by = 1) {
    if (!value) return;
    let m = this.facets.get(facet);
    if (!m) {
      m = new Map();
      this.facets.set(facet, m);
    }
    m.set(value, (m.get(value) ?? 0) + by);
  }

  turn(durationMs: number, messages: number) {
    this.turns += 1;
    this.turnDurationMs += durationMs;
    this.turnDurationMsMax = Math.max(this.turnDurationMsMax, durationMs);
    this.turnMessages += messages;
    this.turnMessagesMax = Math.max(this.turnMessagesMax, messages);
  }

  /**
   * Count a diff's lines by their first character only. The hunk header is
   * `@@ -a,b +c,d @@` and each body line starts with ` `, `+` or `-`; nothing
   * past the first character is looked at.
   */
  diffLines(lines: unknown) {
    if (!Array.isArray(lines)) return;
    for (const line of lines) {
      if (typeof line !== "string" || line.length === 0) continue;
      const c = line[0];
      if (c === "+" && !line.startsWith("+++")) this.linesAdded += 1;
      else if (c === "-" && !line.startsWith("---")) this.linesRemoved += 1;
    }
  }
}

/**
 * Accumulates repo-days across both transcript formats.
 *
 * The walk lives in `transcripts.ts` so that one read and one parse can feed
 * this and `capabilities.ts` together; this class is what it feeds. Claude Code
 * and Codex get a visitor each because the formats share nothing but the
 * `.jsonl` extension: Claude Code stamps `cwd` on every record, while Codex
 * declares its repo once in a session header and every later record in the file
 * inherits it, which is the per-file state `startFile` resets.
 */
export class RepoCollector {
  private readonly acc = new Map<string, Acc>();
  private readonly claudeSeen = new TranscriptDeduper();
  private readonly codexSeen = new TranscriptDeduper();
  /** `repoName()` asks the disk; a transcript repeats the same cwd thousands of times. */
  private readonly repoByCwd = new Map<string, string | null>();
  private readonly priceOf: (model: string, usage: UsageCounts, provider?: string) => number;

  constructor(private readonly options: {
    since: string;
    until: string;
    priceOf?: (model: string, usage: UsageCounts, provider?: string) => number;
  }) {
    this.priceOf = options.priceOf ?? (() => 0);
  }

  private readonly at = (date: string, agent: string, repo: string, branch: string | null): Acc => {
    const key = `${date}|${agent}|${repo}`;
    let a = this.acc.get(key);
    if (!a) {
      a = new Acc();
      this.acc.set(key, a);
    }
    if (!a.branch && branch) a.branch = branch;
    if (branch) a.branches.add(branch);
    return a;
  };

  private readonly inRange = (date: string): boolean =>
    date.length === 10 && date >= this.options.since && date <= this.options.until;

  /** Claude Code: cwd and gitBranch on every record. */
  claude(): TranscriptVisitor {
    const { at, inRange, claudeSeen, repoByCwd, priceOf } = this;
    return {
      record: (r: Rec) => {
        const date = String(r.timestamp ?? "").slice(0, 10);
        if (!inRange(date)) return;

        // The path is reduced here and never retained.
        const cwd = String(r.cwd ?? "");
        if (!cwd) return;
        let repo = repoByCwd.get(cwd);
        if (repo === undefined) {
          repo = repoName({ cwd });
          repoByCwd.set(cwd, repo);
        }
        if (!repo) return;
        const branch = str(r.gitBranch);
        const a = at(date, "claude-code", repo, branch);

        const sessionId = str(r.sessionId);
        const recordId = str(r.uuid);
        if (!claudeSeen.first("record", sessionId, recordId)) return;
        if (sessionId) a.sessionIds.add(sessionId);
        const type = r.type;
        if (type === "system" && r.subtype === "compact_boundary") a.compactions += 1;

        if (type === "assistant" || type === "user") {
          if (r.isSidechain === true) a.sidechainMessages += 1;
        }

        if (type === "assistant") {
          const message = obj(r.message);
          // One API response is written as one record per content block, each
          // carrying the same usage: blocks are counted per record, tokens once.
          const content = Array.isArray(message.content) ? message.content : [];
          for (const [index, block] of content.entries()) {
            const b = obj(block);
            if (b.type === "tool_use") {
              const toolId = str(b.id) ?? (recordId ? `${recordId}:${index}` : null);
              if (!claudeSeen.first("tool", sessionId, toolId)) continue;
              a.toolCalls += 1;
              a.facet("tool", str(b.name));
            } else if (b.type === "thinking") a.thinkingBlocks += 1;
            else if (b.type === "text") a.textBlocks += 1;
          }
          const requestId = String(r.requestId ?? message.id ?? "");
          const stop = str(message.stop_reason);
          if (stop && claudeSeen.first("stop", sessionId, requestId || null)) {
            a.facet("stop_reason", stop);
          }
          const usage = message.usage as UsageCounts | undefined;
          if (!usage) return;
          if (num(usage.input_tokens) + num(usage.output_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens) === 0) return;
          if (!claudeSeen.first("response", sessionId, requestId || null)) return;
          const u = obj(usage);
          a.tokensIn += num(u.input_tokens);
          a.tokensOut += num(u.output_tokens);
          a.tokensCacheRead += num(u.cache_read_input_tokens);
          a.tokensCacheWrite += num(u.cache_creation_input_tokens);
          a.messageCount += 1;
          a.costMicros += priceOf(String(message.model ?? ""), usage);
          a.tokensReasoning += num(obj(u.output_tokens_details).thinking_tokens);
          const cc = obj(u.cache_creation);
          a.tokensCacheWrite1h += num(cc.ephemeral_1h_input_tokens);
          a.tokensCacheWrite5m += num(cc.ephemeral_5m_input_tokens);
          const st = obj(u.server_tool_use);
          a.webSearchRequests += num(st.web_search_requests);
          a.webFetchRequests += num(st.web_fetch_requests);
          if (Array.isArray(u.iterations)) a.iterations += u.iterations.length;
          a.facet("model", str(message.model));
          a.facet("entrypoint", str(r.entrypoint));
          a.facet("version", str(r.version));
          a.facet("effort", str(r.effort));
          a.facet("service_tier", str(u.service_tier));
          a.facet("speed", str(u.speed));
          return;
        }

        if (type === "user") {
          const message = obj(r.message);
          const rawContent = message.content;
          const content = Array.isArray(rawContent) ? rawContent : [];
          const hasContent = typeof rawContent === "string"
            ? rawContent.length > 0
            : content.length > 0;
          let results = 0;
          for (const block of content) {
            const b = obj(block);
            if (b.type !== "tool_result") continue;
            results += 1;
            if (b.is_error === true) a.toolErrors += 1;
          }
          if (results === 0 && r.isMeta !== true && hasContent) a.humanTurns += 1;
          const result = r.toolUseResult;
          if (result && typeof result === "object" && !Array.isArray(result)) {
            const t = result as Rec;
            if (t.interrupted === true) a.interrupted += 1;
            if (t.userModified === true) a.userModified += 1;
            if (t.dangerouslyDisableSandbox === true) a.sandboxDisabled += 1;
            if (typeof t.durationMs === "number") {
              a.toolTimed += 1;
              a.toolDurationMs += num(t.durationMs);
            }
            if (Array.isArray(t.structuredPatch) && t.structuredPatch.length > 0) {
              a.edits += 1;
              a.hunks += t.structuredPatch.length;
              for (const hunk of t.structuredPatch) a.diffLines(obj(hunk).lines);
            }
          }
          return;
        }

        if (type === "system") {
          if (r.subtype === "turn_duration") a.turn(num(r.durationMs), num(r.messageCount));
          else if (r.subtype === "api_error") a.apiErrors += 1;
          return;
        }

        if (type === "attachment") {
          const att = obj(r.attachment);
          const kind = str(att.type);
          a.facet("attachment", kind);
          if (kind === "hook_non_blocking_error") {
            a.hookRuns += 1;
            a.hookErrors += 1;
            const name = str(att.hookName) ?? str(att.hookEvent) ?? "hook";
            a.facet("hook_error", `${name} exit ${num(att.exitCode)}`);
          } else if (kind === "hook_success") {
            a.hookRuns += 1;
          }
        }
      },
    };
  }

  /** Codex: cwd and a git remote in the session header. */
  codex(): TranscriptVisitor {
    const { at, inRange } = this;
    let repo: string | null = null;
    let branch: string | null = null;
    let sessionId: string | null = null;
    let fileNumber = 0;
    const tokens = new CodexTokenReader();
    let model: string | null = null;
    let meta: { version: string | null; provider: string | null; entrypoint: string | null } | null = null;
    return {
      startFile: (file) => {
        fileNumber += 1;
        tokens.startFile(file);
        repo = null;
        branch = null;
        sessionId = null;
        model = null;
        meta = null;
      },
      record: (r: Rec) => {
        const sample = tokens.read(r);
        const payload = obj(r.payload);

        if (r.type === "session_meta") {
          const git = obj(payload.git);
          // A git remote names the repo better than any directory does.
          repo = repoName({
            remoteUrl: git.repository_url ? String(git.repository_url) : null,
            cwd: payload.cwd ? String(payload.cwd) : null,
          });
          branch = str(git.branch);
          sessionId = str(payload.id);
          meta = {
            version: str(payload.cli_version),
            provider: str(payload.model_provider),
            entrypoint: str(payload.originator),
          };
          return;
        }
        const settings = codexSettings(r);
        if (settings) {
          model = str(settings.model) ?? model;
          if (typeof settings.cwd === "string") repo = repoName({ cwd: settings.cwd }) ?? repo;
        }
        if (!repo) return;
        const dedupScope = sessionId ?? `anonymous-file:${fileNumber}`;

        const date = sample?.date ?? String(r.timestamp ?? "").slice(0, 10);
        if (!inRange(date)) return;
        const a = at(date, "codex", repo, branch);
        if (sessionId && !a.sessionIds.has(sessionId)) {
          // Session-level facts are counted once, on the day the session first shows up in range.
          a.sessionIds.add(sessionId);
          if (meta) {
            a.facet("version", meta.version);
            a.facet("provider", meta.provider);
            a.facet("entrypoint", meta.entrypoint);
          }
        }

        if (settings) {
          if (!this.codexSeen.first("settings", dedupScope, str(payload.turn_id) ?? String(r.timestamp ?? ""))) return;
          if (r.type === "turn_context" && this.codexSeen.first("turn", dedupScope, str(payload.turn_id))) a.turns += 1;
          a.facet("model", str(settings.model));
          a.facet("effort", str(settings.effort ?? settings.reasoning_effort));
          a.facet("service_tier", str(settings.service_tier));
          a.facet("approval_policy", str(settings.approval_policy));
          a.facet("sandbox_policy", str(obj(settings.sandbox_policy).type));
          return;
        }
        if (sample) {
          const usage = sample.usage;
          a.tokensIn += usage.input_tokens ?? 0;
          a.tokensOut += usage.output_tokens ?? 0;
          a.tokensCacheRead += usage.cache_read_input_tokens ?? 0;
          a.tokensCacheWrite += usage.cache_creation_input_tokens ?? 0;
          a.tokensReasoning += sample.reasoning;
          if (sample.model !== "unknown") a.costMicros += this.priceOf(sample.model, usage, sample.provider);
          a.messageCount += 1;
          return;
        }
        if (r.type !== "event_msg") return;

        if (["task_started", "turn_started", "task_complete", "turn_complete", "turn_aborted"].includes(String(payload.type))) {
          const id = str(payload.turn_id);
          if (this.codexSeen.first("turn", dedupScope, id)) a.turns += 1;
          if (["task_complete", "turn_complete", "turn_aborted"].includes(String(payload.type)) && this.codexSeen.first("turn-end", dedupScope, id)) {
            const duration = Math.max(0, Math.round(num(payload.duration_ms)));
            a.turnDurationMs += duration;
            a.turnDurationMsMax = Math.max(a.turnDurationMsMax, duration);
            if (payload.type === "turn_aborted") a.interrupted += 1;
          }
          return;
        }
        if (payload.type === "hook_completed") {
          const run = obj(payload.run);
          if (!this.codexSeen.first("hook", dedupScope, str(run.id))) return;
          a.hookRuns += 1;
          if (run.status === "failed" || run.status === "blocked") a.hookErrors += 1;
          return;
        }
        if (payload.type === "stream_error") {
          if (this.codexSeen.first("api-error", dedupScope, `${payload.turn_id ?? ""}:${r.timestamp ?? ""}`)) a.apiErrors += 1;
          return;
        }

        // Classified and legacy completion events use the same opaque item id.
        const item = codexItem(r);
        if (item) {
          const kind = str(item.type);
          if (!kind) return;
          if (!this.codexSeen.first("item", dedupScope, str(item.id))) return;
          a.facet("item", kind);
          const tool = codexTool(item);
          if (tool) {
            a.toolCalls += 1;
            a.facet("tool", str(tool));
            if (["failed", "declined"].includes(String(item.status)) || (kind === "CommandExecution" && num(item.exit_code) !== 0)) a.toolErrors += 1;
            const duration = codexDuration(item);
            if (duration !== null) { a.toolTimed += 1; a.toolDurationMs += duration; }
          }
          switch (kind) {
            case "UserMessage":
              a.humanTurns += 1;
              break;
            case "ContextCompaction":
              a.compactions += 1;
              break;
            case "Reasoning":
              a.thinkingBlocks += 1;
              break;
            case "AgentMessage":
              a.textBlocks += 1;
              break;
            case "FileChange": {
              if (item.status === "failed" || item.status === "declined") break;
              // `changes` is keyed by path; only the values are looked at, and
              // of each diff only the first character of each line.
              const changes = obj(item.changes);
              const diffs = Object.values(changes);
              if (diffs.length > 0) a.edits += 1;
              for (const change of diffs) {
                const diff = obj(change).unified_diff;
                if (typeof diff !== "string") continue;
                const lines = diff.split("\n");
                a.hunks += lines.filter((l) => l.startsWith("@@")).length;
                a.diffLines(lines);
              }
              break;
            }
            case "WebSearch": a.webSearchRequests += 1; break;
            case "Extension": {
              const ext = str(item.kind);
              if (ext === "web.search") a.webSearchRequests += 1;
              break;
            }
          }
        }
      },
    };
  }

  finish(): RepoUsage[] {
    const acc = this.acc;
    return [...acc.entries()]
      .map(([key, a]) => {
        const [date, agent, ...rest] = key.split("|");
        const facets: RepoFacetCount[] = [];
        for (const [facet, values] of a.facets) {
          const top = [...values.entries()]
            .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
            .slice(0, FACET_VALUES_PER_ROW);
          for (const [value, count] of top) facets.push({ facet, value, count });
        }
        const row: RepoUsage = {
          date: date!,
          agent: agent!,
          repo: rest.join("|"),
          branch: a.branch,
          branches: [...a.branches].sort(),
          tokensIn: a.tokensIn,
          tokensOut: a.tokensOut,
          tokensCacheRead: a.tokensCacheRead,
          tokensCacheWrite: a.tokensCacheWrite,
          messageCount: a.messageCount,
          costMicros: a.costMicros,
          facets,
          ...Object.fromEntries(ACTIVITY_KEYS.map((k) => [k, a[k]])),
          sessions: a.sessionIds.size,
        } as RepoUsage;
        return row;
      })
      // A tool can finish after midnight without another priced response.
      // Preserve recorded activity while dropping directories merely opened.
      .filter((r) => r.messageCount > 0 || ACTIVITY_KEYS.some((key) => r[key] > 0))
      // Belt and braces: nothing that still looks like a path may be reported,
      // as a repo, a branch, or a facet value.
      .filter((r) => r.repo && !looksLikePath(r.repo))
      .map((r) => ({
        ...r,
        branches: r.branches.filter((b) => !looksLikePath(b)),
        facets: r.facets.filter((f) => !looksLikePath(f.value)),
      }))
      .sort((a, b) => b.costMicros - a.costMicros || b.messageCount - a.messageCount);
  }
}


/** A one-line, human-readable digest of what the scan found. Never sent. */
export function summarizeRepos(rows: RepoUsage[]): string[] {
  const sum = (k: keyof RepoActivity) => rows.reduce((s, r) => s + r[k], 0);
  const repos = new Set(rows.map((r) => r.repo)).size;
  const out = [`  repos: ${repos} (names only, never paths)`];
  if (rows.length === 0) return out;
  out.push(
    `  activity: ${sum("sessions")} sessions, ${sum("humanTurns")} human turns, ` +
      `${sum("toolCalls")} tool calls (${sum("toolErrors")} errored), ` +
      `${sum("edits")} edits +${sum("linesAdded")}/-${sum("linesRemoved")} lines, ` +
      `${sum("hookErrors")} hook errors, ${sum("compactions")} compactions`,
  );
  return out;
}
