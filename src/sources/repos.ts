import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { looksLikePath, repoName } from "./repo.js";
import type { UsageCounts } from "./capabilities.js";

/**
 * Which repos consume tokens.
 *
 * Neither tokscale surface reports a workspace, so this reads the transcripts
 * directly for the one field they omit. Claude Code records `cwd` on every
 * record; Codex records `cwd` plus a git remote in its session header.
 *
 * WHAT LEAVES THE MACHINE: a repo NAME and token counts. The absolute path is
 * read, reduced by `repoName()`, and discarded -- see repo.ts for why.
 */

export interface RepoUsage {
  date: string;
  agent: string;
  repo: string;
  branch: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  messageCount: number;
  costMicros: number;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

interface Acc {
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  messageCount: number;
  costMicros: number;
  branch: string | null;
}

export function scanRepos(options: {
  since: string;
  until: string;
  home?: string;
  priceOf?: (model: string, usage: UsageCounts) => number;
}): RepoUsage[] {
  const home = options.home ?? homedir();
  const priceOf = options.priceOf ?? (() => 0);
  const acc = new Map<string, Acc>();
  const seen = new Set<string>();

  const add = (
    date: string,
    agent: string,
    repo: string,
    branch: string | null,
    usage: UsageCounts,
    micros: number,
  ) => {
    const key = `${date}|${agent}|${repo}`;
    let a = acc.get(key);
    if (!a) {
      a = {
        tokensIn: 0,
        tokensOut: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        messageCount: 0,
        costMicros: 0,
        branch,
      };
      acc.set(key, a);
    }
    a.tokensIn += usage.input_tokens ?? 0;
    a.tokensOut += usage.output_tokens ?? 0;
    a.tokensCacheRead += usage.cache_read_input_tokens ?? 0;
    a.tokensCacheWrite += usage.cache_creation_input_tokens ?? 0;
    a.messageCount += 1;
    a.costMicros += micros;
    if (!a.branch && branch) a.branch = branch;
  };

  // --- Claude Code: cwd and gitBranch on every record --------------------
  for (const file of walk(join(home, ".claude", "projects"))) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const date = String(r.timestamp ?? "").slice(0, 10);
      if (!date || date < options.since || date > options.until) continue;

      const message = (r.message ?? {}) as Record<string, unknown>;
      const usage = message.usage as UsageCounts | undefined;
      if (!usage) continue;

      const requestId = String(r.requestId ?? message.id ?? "");
      if (requestId) {
        if (seen.has(requestId)) continue;
        seen.add(requestId);
      }

      // The path is reduced here and never retained.
      const repo = repoName({ cwd: String(r.cwd ?? "") });
      if (!repo) continue;
      const branch = r.gitBranch ? String(r.gitBranch) : null;
      add(
        date,
        "claude-code",
        repo,
        branch,
        usage,
        priceOf(String(message.model ?? ""), usage),
      );
    }
  }

  // --- Codex: cwd and a git remote in the session header ------------------
  for (const file of walk(join(home, ".codex", "sessions"))) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let repo: string | null = null;
    let branch: string | null = null;

    for (const line of text.split("\n")) {
      if (!line) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload = (r.payload ?? {}) as Record<string, unknown>;

      if (r.type === "session_meta") {
        const git = (payload.git ?? {}) as Record<string, unknown>;
        // A git remote names the repo better than any directory does.
        repo = repoName({
          remoteUrl: git.repository_url ? String(git.repository_url) : null,
          cwd: payload.cwd ? String(payload.cwd) : null,
        });
        branch = git.branch ? String(git.branch) : null;
        continue;
      }
      if (!repo) continue;

      const date = String(r.timestamp ?? "").slice(0, 10);
      if (!date || date < options.since || date > options.until) continue;

      // Codex reports token usage on token_count events.
      const info = (payload.info ?? {}) as Record<string, unknown>;
      const last = (info.last_token_usage ?? null) as Record<string, number> | null;
      if (!last) continue;

      const usage: UsageCounts = {
        input_tokens: last.input_tokens ?? 0,
        output_tokens: last.output_tokens ?? 0,
        cache_read_input_tokens: last.cached_input_tokens ?? 0,
        cache_creation_input_tokens: 0,
      };
      if (!usage.input_tokens && !usage.output_tokens) continue;
      add(date, "codex", repo, branch, usage, 0);
    }
  }

  return [...acc.entries()]
    .map(([key, a]) => {
      const [date, agent, ...rest] = key.split("|");
      return {
        date: date!,
        agent: agent!,
        repo: rest.join("|"),
        branch: a.branch,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        tokensCacheRead: a.tokensCacheRead,
        tokensCacheWrite: a.tokensCacheWrite,
        messageCount: a.messageCount,
        costMicros: a.costMicros,
      };
    })
    // Belt and braces: nothing that still looks like a path may be reported.
    .filter((r) => r.repo && !looksLikePath(r.repo))
    .sort((a, b) => b.costMicros - a.costMicros || b.messageCount - a.messageCount);
}
