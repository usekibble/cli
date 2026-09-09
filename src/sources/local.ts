import { homedir } from "node:os";
import { statSync } from "node:fs";
import { join } from "node:path";
import { CapabilityCollector, type CapabilityRecord, type UsageCounts } from "./capabilities.js";
import { copilotHome, copilotTranscripts } from "./copilot.js";
import { RepoCollector, type RepoUsage } from "./repos.js";
import { ModelActivityCollector, type ModelActivity } from "./model-activity.js";
import { codexHome } from "./codex-inventory.js";
import { scanVsCode } from "./vscode.js";
import type { CursorSample } from "./cursor.js";
import type { CursorToolSample } from "./cursor-tools.js";
import type { CursorActivitySample } from "./cursor-activity.js";
import { readCursorSelections } from "./cursor-store.js";
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
 * Copilot's events.jsonl files do the same through their own visitors.
 */
export interface ScanOptions {
  since: string;
  until: string;
  home?: string;
  copilotHome?: string;
  vscodeUserDataDirs?: string[];
  priceOf?: (model: string, usage: UsageCounts, provider?: string) => number;
  /** Cursor usage days anchor inventory, never inferred invocation counts. */
  cursorActiveDates?: Iterable<string>;
  cursorSamples?: Iterable<CursorSample>;
  cursorTools?: Iterable<CursorToolSample>;
  cursorActivity?: Iterable<CursorActivitySample>;
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
  const copilotRoot = options.copilotHome ?? copilotHome(home);
  const wantRepos = options.repos ?? true;
  const wantCapabilities = options.capabilities ?? true;
  const floor = transcriptFloor(options.since);

  const repoCollector = wantRepos ? new RepoCollector(options) : null;
  const modelCollector = wantRepos ? new ModelActivityCollector(options) : null;
  const capabilityCollector = wantCapabilities
    ? new CapabilityCollector({ ...options, home, copilotHome: copilotRoot })
    : null;
  for (const date of options.cursorActiveDates ?? []) capabilityCollector?.addCursorActivity(date);
  for (const sample of options.cursorActivity ?? []) {
    repoCollector?.addCursorActivity(sample);
    modelCollector?.addCursorActivity(sample);
    capabilityCollector?.addCursorActivity(sample.date);
  }
  for (const sample of options.cursorSamples ?? []) {
    repoCollector?.addCursor(sample);
    modelCollector?.addCursor(sample);
    capabilityCollector?.addCursorActivity(sample.date);
  }
  for (const sample of options.cursorTools ?? []) {
    repoCollector?.addCursorTool(sample);
    modelCollector?.addCursorTool(sample);
    capabilityCollector?.addCursorActivity(sample.date);
  }
  if (capabilityCollector) {
    const appData = process.platform === "darwin" ? join(home, "Library", "Application Support")
      : process.platform === "win32" ? (home === homedir() ? process.env.APPDATA : undefined) ?? join(home, "AppData", "Roaming")
      : (home === homedir() ? process.env.XDG_CONFIG_HOME : undefined) ?? join(home, ".config");
    for (const selection of readCursorSelections(join(appData, "Cursor", "User", "globalStorage", "state.vscdb"))) {
      capabilityCollector.addCursorSelection(selection);
    }
  }

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

  if (repoCollector || capabilityCollector) {
    // Replay VS Code's metadata log once for both sidecars, never read its
    // separate content transcript or reconstruct tool input from messages.
    for (const request of scanVsCode({ ...options, home, userDataDirs: options.vscodeUserDataDirs }).requests) {
      repoCollector?.vscode(request);
      capabilityCollector?.vscode(request);
    }
    const copilot = partitionByFloor(copilotTranscripts(copilotRoot), floor);
    readTranscripts(copilot.recent, [
      ...(repoCollector ? [repoCollector.copilot()] : []),
      ...(capabilityCollector ? [capabilityCollector.copilotVisitor()] : []),
    ]);
    if (capabilityCollector) {
      const cwds = new Set<string>();
      harvestCwds(copilot.older, cwds, (record) => {
        if (record.type !== "session.start" && record.type !== "session.resume") return null;
        const data = record.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) return null;
        const context = (data as Record<string, unknown>).context;
        return context && typeof context === "object" && !Array.isArray(context)
          ? (context as Record<string, unknown>).cwd
          : null;
      });
      for (const cwd of cwds) capabilityCollector.addCopilotCwd(cwd);
    }
  }

  return {
    repos: repoCollector?.finish() ?? [],
    modelActivity: modelCollector?.finish() ?? [],
    capabilities: capabilityCollector?.finish() ?? [],
  };
}
