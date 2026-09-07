import { CopilotSource } from "./copilot.js";
import { TokscaleCliSource } from "./tokscale-cli.js";
import { TokscaleCoreSource } from "./tokscale-core.js";
import { VsCodeCopilotSource } from "./vscode.js";
import { TokscaleHybridSource } from "./tokscale-hybrid.js";
import type { SourceContext, CollectOptions, CollectResult, UsageSource } from "./types.js";

/** Manual, scheduled and diagnostic collection share the same coverage. */
export function createSource(context: SourceContext = {}): UsageSource {
  return new DefaultSource(new TokscaleHybridSource(new TokscaleCoreSource(context)), context);
}

export class DefaultSource implements UsageSource {
  readonly name: string;
  readonly coverage: string;
  private readonly copilot: UsageSource;
  private readonly vscode: UsageSource;

  constructor(private readonly core: UsageSource, context: SourceContext = {}, copilot?: UsageSource, vscode?: UsageSource) {
    this.copilot = copilot ?? new CopilotSource(context);
    this.vscode = vscode ?? new VsCodeCopilotSource(context);
    this.name = core.name;
    this.coverage = `${core.coverage}; GitHub Copilot CLI and VS Code chat counters with session ids`;
  }

  async version(): Promise<string> {
    return `${await this.core.version()}; ${await this.copilot.version()}; ${await this.vscode.version()}`;
  }

  async collect(options: CollectOptions): Promise<CollectResult> {
    const [core, copilot, vscode] = await Promise.all([
      this.core.collect(options),
      this.copilot.collect(options),
      this.vscode.collect(options),
    ]);
    // The pinned core does not parse Copilot. Keep this filter so a future core
    // upgrade cannot silently double it before the dedicated parser is removed.
    return mergeCollections({
      daily: core.daily.filter((row) => row.agent !== "copilot"),
      sessions: core.sessions.filter((session) => session.agent !== "copilot"),
    }, copilot, vscode);
  }
}

/** One wire row per day/agent/model. Ingest replaces duplicate grain rows,
 * so merely concatenating CLI and VS Code arrays would lose one source.
 */
export function mergeCollections(...results: CollectResult[]): CollectResult {
  const daily = new Map<string, CollectResult["daily"][number]>();
  for (const result of results) for (const row of result.daily) {
    const key = `${row.date}\0${row.agent}\0${row.model}`;
    const existing = daily.get(key);
    if (!existing) { daily.set(key, { ...row }); continue; }
    for (const field of ["tokensIn", "tokensOut", "tokensCacheRead", "tokensCacheWrite", "tokensReasoning", "messageCount", "costMicros"] as const) existing[field] += row[field];
  }
  return {
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date) || b.costMicros - a.costMicros),
    sessions: results.flatMap((r) => r.sessions),
  };
}

export { CopilotSource, VsCodeCopilotSource, TokscaleCliSource, TokscaleCoreSource, TokscaleHybridSource };
export { TOKSCALE_CORE_AGENTS } from "./tokscale-hybrid.js";
/** Both sidecars over one read of the transcripts. */
export { scanLocal } from "./local.js";
/** How each agent on this machine is billed: mode, tier, nothing that identifies. */
export { readPlans, describePlans, PLAN_MODES, PLAN_TIERS } from "./plans.js";
export * from "./types.js";
