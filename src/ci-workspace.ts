import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ciWorkspaceSchema, type CiReceipt } from "./ci-receipt.js";
import { findGitDir, repoFromCwd, repoFromDisk, repoFromRemote } from "./sources/repo.js";

export type CiWorkspace = NonNullable<CiReceipt["workspace"]>;

/**
 * Which checkout a CI run worked in, by name.
 *
 * The laptop collector answers this from the transcript's `cwd`; an ephemeral
 * `kibble run` has no transcript, so it asks the checkout on disk first (the
 * remote in `.git/config`, as `repoName()` does on a laptop), then the runner's
 * own repository variable, and only then the bare directory name, because a
 * job that runs the agent in a scratch directory must not file every repo
 * under `build`. The branch comes from the runner first because a pull-request
 * checkout is a detached HEAD: `GITHUB_HEAD_REF` names the source branch where
 * `.git/HEAD` holds only a commit.
 *
 * Only names survive: a value that still looks like a path, a slug or a ref
 * with shell-sensitive characters is dropped rather than sent, and a run that
 * yields neither a repo nor a branch sends no `workspace` at all.
 */
export function ciWorkspace(cwd: string, env: NodeJS.ProcessEnv = process.env): CiWorkspace | undefined {
  return ciWorkspaceOf(repoFromDisk(cwd) ?? repoFromEnvironment(env) ?? repoFromCwd(cwd), branchFromEnvironment(env) ?? branchFromDisk(cwd));
}

/** The wire contract decides what a name is; anything it refuses becomes null, never an error. */
export function ciWorkspaceOf(repo: string | null | undefined, branch: string | null | undefined): CiWorkspace | undefined {
  const valid = (value: string | null | undefined, key: "repo" | "branch") =>
    value && ciWorkspaceSchema.safeParse({ repo: null, branch: null, [key]: value }).success ? value : null;
  return ciWorkspaceSchema.safeParse({ repo: valid(repo, "repo"), branch: valid(branch, "branch") }).data;
}

/** `owner/repo` slugs and clone URLs reduce to the repo name, like a remote does. */
function repoFromEnvironment(env: NodeJS.ProcessEnv): string | null {
  for (const key of ["GITHUB_REPOSITORY", "CI_PROJECT_PATH", "BUILDKITE_REPO", "CIRCLE_REPOSITORY_URL"]) {
    const value = env[key]?.trim();
    if (!value) continue;
    const name = repoFromRemote(value) ?? value.split("/").filter(Boolean).pop()?.replace(/\.git$/, "");
    if (name) return name;
  }
  return null;
}

function branchFromEnvironment(env: NodeJS.ProcessEnv): string | null {
  const head = env.GITHUB_HEAD_REF?.trim();
  if (head) return head;
  // `GITHUB_REF_NAME` is `<n>/merge` on a pull request and a tag name on a tag build; neither is a branch.
  const ref = env.GITHUB_REF_NAME?.trim();
  if (ref && env.GITHUB_REF_TYPE !== "tag" && !/^\d+\/merge$/.test(ref)) return ref;
  for (const key of ["CI_COMMIT_BRANCH", "BUILDKITE_BRANCH", "CIRCLE_BRANCH", "BRANCH_NAME"]) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

/** The symbolic ref in this checkout's own HEAD. A detached HEAD is a commit, not a branch, and reads as none. */
function branchFromDisk(cwd: string): string | null {
  const found = findGitDir(cwd);
  if (!found) return null;
  try {
    return /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(found.gitDir, "HEAD"), "utf8"))?.[1]?.trim() || null;
  } catch { return null; }
}
