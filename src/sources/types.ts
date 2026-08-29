/**
 * The adapter boundary for Lane A.
 *
 * Kibble never talks to a log parser directly. Parsers are third-party,
 * fast-moving, and single-maintainer (plan section 10) -- so everything
 * downstream depends on this interface instead, and swapping one for another is
 * a new file rather than a rewrite. Two implementations ship today:
 * `TokscaleCoreSource` (the Rust library, in-process) and `TokscaleCliSource`
 * (the CLI binary, broader client coverage).
 */

/**
 * One day of usage for one (agent, model) pair on this machine.
 *
 * Counts only. No prompts, no file contents, no tool arguments, no repo paths.
 * This shape is the entire payload the collector is allowed to send.
 */
export interface NormalizedDailyUsage {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  /** Normalized agent name: claude-code, codex, gemini, ... */
  agent: string;
  model: string;
  provider: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensReasoning: number;
  messageCount: number;
  /** Integer millionths of a USD. Never a float -- see AGENTS.md. */
  costMicros: number;
}

/**
 * A session the collector observed, for the Lane A/B dedup ledger and for
 * session-size percentiles. Ids only -- a session id is an opaque UUID and
 * carries nothing about what was said or which repo it ran in.
 *
 * Only sources that expose session ids populate this; the CLI's graph export
 * does not, so it returns none.
 */
export interface SessionRef {
  sessionId: string;
  agent: string;
  /** UTC day the session's first observed message falls on. */
  date: string;
  messageCount: number;
  costMicros: number;
}

export interface CollectResult {
  daily: NormalizedDailyUsage[];
  sessions: SessionRef[];
}

export interface CollectOptions {
  /** Inclusive UTC start date, YYYY-MM-DD. */
  since: string;
  /** Inclusive UTC end date, YYYY-MM-DD. */
  until: string;
}

export interface UsageSource {
  readonly name: string;
  /** Human-readable note on coverage, shown by `kibble doctor`. */
  readonly coverage: string;
  /** Version of the underlying parser, for support and drift diagnosis. */
  version(): Promise<string>;
  collect(options: CollectOptions): Promise<CollectResult>;
}

/** tokscale client ids -> Kibble's normalized agent names. */
export const AGENT_NAMES: Record<string, string> = {
  claude: "claude-code",
  codex: "codex",
  cursor: "cursor",
  gemini: "gemini",
  opencode: "opencode",
  copilot: "copilot",
  amp: "amp",
  droid: "droid",
  zed: "zed",
  cline: "cline",
  goose: "goose",
  junie: "junie",
  warp: "warp",
  trae: "trae",
  kiro: "kiro",
  openclaw: "openclaw",
  pi: "pi",
  kimi: "kimi",
};

export function normalizeAgent(client: string): string {
  return AGENT_NAMES[client] ?? client;
}

/** Float dollars -> integer micro-dollars. Rounded exactly once. */
export function toMicros(costDollars: number): number {
  if (!Number.isFinite(costDollars)) return 0;
  return Math.round(costDollars * 1_000_000);
}
