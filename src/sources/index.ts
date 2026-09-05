import { TokscaleCliSource } from "./tokscale-cli.js";
import { TokscaleCoreSource } from "./tokscale-core.js";
import { TokscaleHybridSource } from "./tokscale-hybrid.js";
import type { SourceContext, UsageSource } from "./types.js";

/**
 * Every collection combines core rows for supported agents with CLI-only
 * agents. Manual pushes, scheduled pushes and doctor use the same coverage.
 */
export function createSource(context: SourceContext = {}): UsageSource {
  return new TokscaleHybridSource(new TokscaleCoreSource(context));
}

export {
  TokscaleCliSource,
  TokscaleCoreSource,
  TokscaleHybridSource,
};
export { TOKSCALE_CORE_AGENTS } from "./tokscale-hybrid.js";
/** Transcript sidecars over one read of the transcripts. */
export { scanLocal } from "./local.js";
/** How each agent on this machine is billed: mode, tier, nothing that identifies. */
export { readPlans, describePlans, PLAN_MODES, PLAN_TIERS } from "./plans.js";
export * from "./types.js";
