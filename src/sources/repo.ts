import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Repo identity, without the path.
 *
 * Agent transcripts record an absolute working directory --
 * `/Users/alice/clients/acme-bank/api`. That single string leaks the engineer's
 * username, the machine's directory layout, and often a client or customer name.
 * None of it is needed to answer "which repos consume tokens", so none of it
 * leaves the machine: only the final path segment, or the `owner/repo` from a
 * git remote where one is recorded.
 *
 * Every path that enters Kibble's pipeline goes through `repoName()` first.
 */

/** Directory names that identify a checkout no better than not answering. */
const UNINFORMATIVE = new Set([
  "", "/", ".", "..",
  "src", "lib", "tmp", "temp", "var", "opt", "usr", "mnt", "private",
  "home", "users", "workspace", "workspaces", "repos", "projects", "code",
  "dev", "git", "documents", "desktop", "downloads",
]);

/**
 * Monorepo containers. A segment directly inside one of these is a package, not
 * the checkout, so `/w/kibble/apps/web` is the `kibble` repo -- not `web`.
 */
const CONTAINERS = new Set(["apps", "packages", "services", "libs", "modules", "app"]);

/** Directories whose immediate children are usernames, never repos. */
const HOME_ROOTS = new Set(["users", "home"]);

/**
 * `git@github.com:owner/repo.git` or `https://host/owner/repo.git` -> `owner/repo`.
 * Any credentials in the URL are dropped with the rest of it.
 */
export function ownerFromRemote(url: string | null | undefined): string | null {
  const full = repoFromRemote(url, true);
  const parts = full?.split("/") ?? [];
  return parts.length === 2 ? (parts[0] ?? null) : null;
}

/**
 * By default returns the repo NAME only. The same checkout reaches us as
 * `owner/repo` from one agent and a bare directory from another, and keying on
 * the full slug would file one repo under two identities.
 */
export function repoFromRemote(
  url: string | null | undefined,
  withOwner = false,
): string | null {
  if (!url) return null;
  const cleaned = url.trim().replace(/\.git$/, "");
  const scp = /^[\w.-]+@[\w.-]+:(.+)$/.exec(cleaned);
  const pathPart = scp?.[1] ?? (() => {
    try {
      return new URL(cleaned).pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  })();
  if (!pathPart) return null;
  const segments = pathPart.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  // Keep at most owner/repo -- deeper paths are self-hosted group nesting.
  const slug = segments.slice(-2).join("/");
  return withOwner ? slug : (segments[segments.length - 1] ?? null);
}

/**
 * An absolute working directory -> the checkout's name, never the path.
 *
 * Walks up through uninformative segments so `/w/kibble/apps/web` reports
 * `kibble` rather than `web`. Returns null when nothing useful survives, which
 * the caller reports as unattributed rather than guessing.
 */
export function repoFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  let segments = cwd.split(/[/\\]/).filter(Boolean);
  // A Claude Code worktree lives at `<repo>/.claude/worktrees/<branch-ish>`.
  // The directory is named after the branch, so reporting it would file a
  // branch as a repo; the checkout is the segment before `.claude`.
  const wt = segments.findIndex(
    (seg, i) => seg === ".claude" && segments[i + 1] === "worktrees",
  );
  if (wt > 0) segments = segments.slice(0, wt);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    const parent = segments[i - 1]?.toLowerCase();
    const lower = segment.toLowerCase();
    if (UNINFORMATIVE.has(lower)) continue;
    // A container directory is not itself the checkout.
    if (CONTAINERS.has(lower)) continue;
    // `/home/deploy` and `/Users/alice` -- the segment is a username, not a repo.
    if (i > 0 && parent && HOME_ROOTS.has(parent)) continue;
    // Inside a monorepo container this is a package; the repo is further up.
    if (i > 0 && parent && CONTAINERS.has(parent)) continue;
    return segment;
  }
  return null;
}

/**
 * Ask the checkout itself, when it is still on disk.
 *
 * Walks up from the working directory to the nearest `.git`. A linked worktree
 * keeps a `.git` *file* pointing at `<main>/.git/worktrees/<name>`, which is
 * followed to the main checkout, so a branch-named worktree directory reports
 * the repo it belongs to. The remote in `.git/config` names the repo better
 * than any directory; the directory name is the fallback. Only the name comes
 * out, and only for a directory that exists: a transcript from a checkout
 * that has since been deleted goes through the path heuristic instead.
 */
export function repoFromDisk(cwd: string | null | undefined): string | null {
  if (!cwd || !existsSync(cwd)) return null;
  let dir = cwd;
  for (let depth = 0; depth < 32; depth++) {
    const dotGit = join(dir, ".git");
    let root: string | null = null;
    try {
      if (statSync(dotGit).isDirectory()) {
        root = dir;
      } else {
        // `gitdir: /main/.git/worktrees/<name>` -> /main
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        const target = m?.[1]?.trim();
        const at = target?.replace(/\\/g, "/").indexOf("/.git/worktrees/") ?? -1;
        root = target && at > 0 ? target.slice(0, at) : dir;
      }
    } catch {
      /* no .git here; keep walking up */
    }
    if (root) {
      try {
        const config = readFileSync(join(root, ".git", "config"), "utf8");
        const url = /^\s*url\s*=\s*(.+)$/m.exec(config)?.[1];
        const fromRemote = repoFromRemote(url);
        if (fromRemote) return fromRemote;
      } catch {
        /* no config or no remote; the directory name will do */
      }
      return repoFromCwd(root);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Prefer the git remote's identity, then the checkout on disk, then the path. */
export function repoName(input: {
  remoteUrl?: string | null;
  cwd?: string | null;
}): string | null {
  return repoFromRemote(input.remoteUrl) ?? repoFromDisk(input.cwd) ?? repoFromCwd(input.cwd);
}

/** True if a value still looks like a filesystem path. Used to assert we never send one. */
export function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(value);
}
