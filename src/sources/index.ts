import { TokscaleCliSource } from "./tokscale-cli.js";
import { TokscaleCoreSource } from "./tokscale-core.js";
import type { UsageSource } from "./types.js";

export type SourceName = "core" | "cli";

/**
 * The Rust core is the default: it runs in-process and reports session ids,
 * which the CLI's graph export cannot. Teams running agents outside the
 * library's 9 clients can opt into the CLI with `--source cli`.
 */
export function createSource(name: SourceName = "core"): UsageSource {
  return name === "cli" ? new TokscaleCliSource() : new TokscaleCoreSource();
}

export function parseSourceName(value: string | undefined): SourceName {
  if (value === undefined) return "core";
  if (value === "core" || value === "cli") return value;
  throw new Error(`unknown --source ${value}. Expected "core" or "cli".`);
}

export { TokscaleCliSource, TokscaleCoreSource };
/** Both sidecars over one read of the transcripts. */
export { scanLocal, scanRepos, scanCapabilities } from "./local.js";
/** How each agent on this machine is billed: mode, tier, nothing that identifies. */
export { readPlans, describePlans, PLAN_MODES, PLAN_TIERS } from "./plans.js";
export * from "./types.js";
