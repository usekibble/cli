import { homedir } from "node:os";
import { statSync } from "node:fs";
import { join } from "node:path";
import { CapabilityCollector, type CapabilityRecord, type UsageCounts } from "./capabilities.js";
import { RepoCollector, type RepoUsage } from "./repos.js";
import { ModelActivityCollector, type ModelActivity } from "./model-activity.js";
import { codexHome } from "./codex-inventory.js";
import {
  harvestCwds,
  listJsonl,
  partitionByFloor,
  readTranscripts,
  transcriptFloor,
} from "./transcripts.js";

/**
 * Transcript sidecars, one pass over the transcripts.
 *
 * `repo_daily`, `capability_daily`, and `model_activity_daily` are cuts of the
 * same records. Here the Claude Code transcripts are walked once and each
 * record is handed to the requested collectors, and files whose mtime predates
 * the window are not opened at all.
 *
 * Codex sessions ride the same rule: one walk feeds every requested Codex
 * visitor together.
 */
export interface ScanOptions {
  since: string;
  until: string;
  home?: string;
  priceOf?: (model: string, usage: UsageCounts, provider?: string) => number;
}

export interface LocalScan {
  repos: RepoUsage[];
  capabilities: CapabilityRecord[];
  modelActivity: ModelActivity[];
}

export function scanLocal(
  options: ScanOptions & { repos?: boolean; capabilities?: boolean },
): LocalScan {
  const home = options.home ?? homedir();
  const wantRepos = options.repos ?? true;
  const wantCapabilities = options.capabilities ?? true;
  const floor = transcriptFloor(options.since);

  const repoCollector = wantRepos ? new RepoCollector(options) : null;
  const modelCollector = wantRepos ? new ModelActivityCollector(options) : null;
  const capabilityCollector = wantCapabilities
    ? new CapabilityCollector({ ...options, home })
    : null;

  const claude = partitionByFloor(listJsonl(join(home, ".claude", "projects")), floor);
  readTranscripts(claude.recent, [
    ...(repoCollector ? [repoCollector.claude()] : []),
    ...(modelCollector ? [modelCollector.claude()] : []),
    ...(capabilityCollector ? [capabilityCollector.visitor()] : []),
  ]);
  // The skipped files still have to answer "which checkouts have a `.claude`".
  if (capabilityCollector) {
    const cwds = new Set<string>();
    harvestCwds(claude.older, cwds);
    for (const cwd of cwds) capabilityCollector.addCwd(cwd);
  }

  if (repoCollector || capabilityCollector) {
    const codex = partitionByFloor([...listJsonl(join(codexHome(home), "sessions")), ...listJsonl(join(codexHome(home), "archived_sessions"))], floor);
    readTranscripts(codex.recent, [
      ...(repoCollector ? [repoCollector.codex()] : []),
      ...(modelCollector ? [modelCollector.codex()] : []),
      ...(capabilityCollector ? [capabilityCollector.codexVisitor()] : []),
    ]);
    if (capabilityCollector) {
      const cwds = new Set<string>();
      harvestCwds(codex.older, cwds, "codex");
      for (const cwd of cwds) capabilityCollector.addCodexCwd(cwd);
      // Named CLI commands have a distinct source. Never re-read transcripts to
      // recover them, or infer them from expanded prompts or shell tool calls.
      const path = join(codexHome(home), "history.jsonl");
      let history;
      try { history = statSync(path); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("could not inspect Codex command history", { cause });
      }
      if (history && history.mtimeMs >= floor) {
        readTranscripts([{ path, mtimeMs: history.mtimeMs }], [capabilityCollector.codexHistoryVisitor()]);
      }
    }
  }

  return {
    repos: repoCollector?.finish() ?? [],
    modelActivity: modelCollector?.finish() ?? [],
    capabilities: capabilityCollector?.finish() ?? [],
  };
}
