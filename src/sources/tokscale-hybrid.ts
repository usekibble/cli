import { TokscaleCliSource } from "./tokscale-cli.js";
import { TokscaleCoreSource } from "./tokscale-core.js";
import type {
  CollectOptions,
  CollectResult,
  UsageSource,
} from "./types.js";

/**
 * Agents owned by the local adapter, including Kibble's dedicated decoders.
 *
 * Keep this list aligned with TokscaleCoreSource.coverage when updating the
 * native dependency. The hybrid must exclude these agents from the CLI export
 * even when the core found no rows, otherwise one parser regression can make a
 * supported agent silently fall back to a known-inaccurate total.
 */
export const TOKSCALE_CORE_AGENTS = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "gemini",
  "amp",
  "droid",
  "openclaw",
  "pi",
  "kimi",
] as const;

const CORE_AGENT_SET = new Set<string>(TOKSCALE_CORE_AGENTS);

/**
 * Broad tokscale coverage without double counting its overlapping parsers.
 *
 * The local adapter owns its eight native agents, Codex and Cursor decoders. The CLI
 * export contributes only agents outside that set. This keeps the verified
 * Claude Code totals and session ids while retaining the CLI's wider coverage.
 * Cursor account-wide CSV caches are excluded even when no hook samples exist:
 * importing the same account on two laptops would double-count its spend.
 */
export class TokscaleHybridSource implements UsageSource {
  readonly name = "tokscale-core+codex+cursor+cli";
  readonly coverage =
    "8 native clients, Codex transcripts, experimental Cursor stop hooks, and CLI fallback for additional agents";

  constructor(
    private readonly core: UsageSource = new TokscaleCoreSource(),
    private readonly fallback: UsageSource = new TokscaleCliSource(),
  ) {}

  async version(): Promise<string> {
    const [core, fallback] = await Promise.all([
      this.core.version(),
      this.fallback.version(),
    ]);
    return `${core}; ${fallback}`;
  }

  async collect(options: CollectOptions): Promise<CollectResult> {
    const [core, fallback] = await Promise.all([
      this.core.collect(options),
      this.fallback.collect(options),
    ]);
    // Account caches belong to the separate account snapshot lane. Their
    // presence must neither duplicate spend nor block local activity capture.
    const fallbackDaily = fallback.daily.filter(
      (row) => !CORE_AGENT_SET.has(row.agent),
    );
    const fallbackSessions = fallback.sessions.filter(
      (session) => !CORE_AGENT_SET.has(session.agent),
    );

    return {
      daily: [...core.daily, ...fallbackDaily].sort(
        (a, b) => a.date.localeCompare(b.date) || b.costMicros - a.costMicros,
      ),
      sessions: [...core.sessions, ...fallbackSessions],
    };
  }
}
