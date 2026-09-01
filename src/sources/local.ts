import { homedir } from "node:os";
import { join } from "node:path";
import { CapabilityCollector, type CapabilityRecord, type UsageCounts } from "./capabilities.js";
import { RepoCollector, type RepoUsage } from "./repos.js";
import {
  harvestCwds,
  listJsonl,
  partitionByFloor,
  readTranscripts,
  transcriptFloor,
} from "./transcripts.js";

/**
 * Both sidecars, one pass over the transcripts.
 *
 * `repo_daily` and `capability_daily` are cuts of the same records, so reading
 * the machine twice to produce them was work done for nothing: every transcript
 * was opened, split and JSON-parsed once per sidecar, every hour. Here the
 * Claude Code transcripts are walked once and each record is handed to both
 * collectors, and files whose mtime predates the window are not opened at all.
 *
 * Codex sessions ride the same rule: one walk feeds the repo collector and the
 * capability collector's Codex visitor together.
 */
export interface ScanOptions {
  since: string;
  until: string;
  home?: string;
  priceOf?: (model: string, usage: UsageCounts) => number;
}

export interface LocalScan {
  repos: RepoUsage[];
  capabilities: CapabilityRecord[];
}

export function scanLocal(
  options: ScanOptions & { repos?: boolean; capabilities?: boolean },
): LocalScan {
  const home = options.home ?? homedir();
  const wantRepos = options.repos ?? true;
  const wantCapabilities = options.capabilities ?? true;
  const floor = transcriptFloor(options.since);

  const repoCollector = wantRepos ? new RepoCollector(options) : null;
  const capabilityCollector = wantCapabilities
    ? new CapabilityCollector({ ...options, home })
    : null;

  const claude = partitionByFloor(listJsonl(join(home, ".claude", "projects")), floor);
  readTranscripts(claude.recent, [
    ...(repoCollector ? [repoCollector.claude()] : []),
    ...(capabilityCollector ? [capabilityCollector.visitor()] : []),
  ]);
  // The skipped files still have to answer "which checkouts have a `.claude`".
  if (capabilityCollector) {
    const cwds = new Set<string>();
    harvestCwds(claude.older, cwds);
    for (const cwd of cwds) capabilityCollector.addCwd(cwd);
  }

  if (repoCollector || capabilityCollector) {
    const codex = partitionByFloor(listJsonl(join(home, ".codex", "sessions")), floor);
    readTranscripts(codex.recent, [
      ...(repoCollector ? [repoCollector.codex()] : []),
      ...(capabilityCollector ? [capabilityCollector.codexVisitor()] : []),
    ]);
  }

  return {
    repos: repoCollector?.finish() ?? [],
    capabilities: capabilityCollector?.finish() ?? [],
  };
}

/** Repo attribution alone, for callers that do not want the capability pass. */
export function scanRepos(options: ScanOptions): RepoUsage[] {
  return scanLocal({ ...options, capabilities: false }).repos;
}

/** Capability usage alone. */
export function scanCapabilities(options: ScanOptions): CapabilityRecord[] {
  return scanLocal({ ...options, repos: false }).capabilities;
}
