import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * How each agent on this machine is billed: a flat subscription, metered API
 * usage, or a cloud provider's account. The dashboard needs it because a
 * subscription machine's local rows are covered by a seat, not by the
 * list-price estimate the collector puts beside them.
 *
 * Both files this reads hold far more than what leaves: `~/.claude.json`
 * carries the account, organization and machine ids and the signed-in email,
 * `~/.codex/auth.json` carries live OAuth tokens. Each is parsed, three fields
 * are copied out, and the rest is dropped here. Nothing on the wire is an
 * identifier: `mode` and `tier` are closed enums the server rejects any other
 * value for, and `multiplier` is the 5 or 20 of a Max plan.
 *
 * Where each value comes from, checked against Claude Code 2.1.251 and the
 * Codex source (`codex-rs/protocol/src/account.rs`, `login/src/token_data.rs`):
 *
 *   Claude Code  `oauthAccount.organizationType` is one of `claude_pro`,
 *                `claude_max`, `claude_team`, `claude_enterprise` for a
 *                claude.ai login; Claude Code itself labels anything else
 *                "Claude API". `organizationRateLimitTier` is
 *                `default_claude_max_5x` / `_20x`. A Bedrock, Vertex or
 *                Foundry install has no login and is flagged by an env var.
 *   Codex        `auth_mode` is `chatgpt` or `apikey`; the plan is the
 *                `chatgpt_plan_type` claim in the id_token JWT (`free`, `go`,
 *                `plus`, `pro`, `team`, `business`, `enterprise`, `edu`,
 *                and dated or usage-based variants of those).
 */
export const PLAN_MODES = ["subscription", "api", "cloud"] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

export const PLAN_TIERS = [
  "free",
  "plus",
  "pro",
  "max",
  "team",
  "business",
  "enterprise",
  "edu",
] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export interface AgentPlan {
  /** Normalized agent name, the same one the usage rows carry. */
  agent: "claude-code" | "codex";
  mode: PlanMode;
  /** Only when the mode is a subscription and the file names one. */
  tier?: PlanTier;
  /** The Max plan's 5x or 20x; absent everywhere else. */
  multiplier?: number;
}

export interface PlanOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const CLAUDE_TIERS: Record<string, PlanTier> = {
  claude_pro: "pro",
  claude_max: "max",
  claude_team: "team",
  claude_enterprise: "enterprise",
};

/** The env flags Claude Code reads to route through a cloud provider. */
const CLAUDE_CLOUD_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

function truthy(v: unknown): boolean {
  return typeof v === "string" ? v !== "" && v !== "0" && v !== "false" : v === true || v === 1;
}

/**
 * `~/.claude.json` and `~/.claude/settings.json`. Only the presence of a flag
 * or a key is tested, never its value, and none of it is returned.
 */
export function claudePlan(home: string, env: NodeJS.ProcessEnv): AgentPlan | null {
  const agent = "claude-code" as const;
  const settings = readJson(join(home, ".claude", "settings.json"));
  const settingsEnv = (settings?.env ?? {}) as Record<string, unknown>;
  if (CLAUDE_CLOUD_FLAGS.some((f) => truthy(env[f]) || truthy(settingsEnv[f]))) {
    return { agent, mode: "cloud" };
  }

  const config = readJson(join(home, ".claude.json"));
  const account = (config?.oauthAccount ?? null) as Record<string, unknown> | null;
  const orgType = typeof account?.organizationType === "string" ? account.organizationType : null;
  const tier = orgType ? CLAUDE_TIERS[orgType] : undefined;
  if (tier) {
    const plan: AgentPlan = { agent, mode: "subscription", tier };
    const limit = account?.organizationRateLimitTier;
    const m = typeof limit === "string" ? /_(\d+)x$/.exec(limit) : null;
    if (m) plan.multiplier = Number(m[1]);
    return plan;
  }

  const keyed =
    typeof env.ANTHROPIC_API_KEY === "string" ||
    typeof env.ANTHROPIC_AUTH_TOKEN === "string" ||
    typeof settings?.apiKeyHelper === "string" ||
    typeof config?.primaryApiKey === "string" ||
    orgType !== null;
  if (keyed) return { agent, mode: "api" };
  // No login and no key: Claude Code is not set up here, so nothing to say.
  return null;
}

/**
 * The Codex plan claim, folded onto the closed tier list. The two Pro tiers
 * have distinct claims -- `prolite` is the $100 5x-of-Plus tier, `pro` the
 * $200 20x -- so both report the tier as `pro` and tell them apart with the
 * multiplier, the same field a Claude Max plan uses for its 5x and 20x.
 */
function codexTier(claim: string): { tier: PlanTier; multiplier?: number } | undefined {
  if (claim === "free" || claim === "go") return { tier: "free" };
  if (claim === "plus") return { tier: "plus" };
  if (claim === "prolite") return { tier: "pro", multiplier: 5 };
  if (claim.startsWith("pro")) return { tier: "pro", multiplier: 20 };
  if (claim === "team") return { tier: "team" };
  if (claim.startsWith("edu")) return { tier: "edu" };
  if (claim.startsWith("enterprise") || claim.startsWith("ent")) return { tier: "enterprise" };
  if (claim === "business" || claim.startsWith("self_serve_business")) return { tier: "business" };
  return undefined;
}

/**
 * The payload of a JWT is base64url JSON and is readable without the key;
 * Codex itself reads the claim this way and never verifies the signature.
 * Only `chatgpt_plan_type` is taken from it.
 */
function planClaim(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    return typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null;
  } catch {
    return null;
  }
}

/** `~/.codex/auth.json`. The tokens in it are never read past the one claim. */
export function codexPlan(home: string, env: NodeJS.ProcessEnv): AgentPlan | null {
  const agent = "codex" as const;
  const path = join(home, ".codex", "auth.json");
  const auth = existsSync(path) ? readJson(path) : null;
  const mode = typeof auth?.auth_mode === "string" ? auth.auth_mode.toLowerCase() : null;

  if (mode === "chatgpt") {
    const tokens = (auth?.tokens ?? {}) as Record<string, unknown>;
    const claim = planClaim(tokens.id_token);
    const known = claim ? codexTier(claim) : undefined;
    if (!known) return { agent, mode: "subscription" };
    const plan: AgentPlan = { agent, mode: "subscription", tier: known.tier };
    if (known.multiplier) plan.multiplier = known.multiplier;
    return plan;
  }
  if (mode === "bedrockapikey") return { agent, mode: "cloud" };
  if (mode === "apikey" || typeof auth?.OPENAI_API_KEY === "string") return { agent, mode: "api" };
  if (mode !== null) return { agent, mode: "api" };
  if (typeof env.OPENAI_API_KEY === "string") return { agent, mode: "api" };
  return null;
}

/** Every agent whose billing this machine can tell. */
export function readPlans(options: PlanOptions = {}): AgentPlan[] {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const plans: AgentPlan[] = [];
  for (const read of [claudePlan, codexPlan]) {
    try {
      const plan = read(home, env);
      if (plan) plans.push(plan);
    } catch {
      // A file this cannot parse is a plan it cannot report; nothing else.
    }
  }
  return plans;
}

/** One line per agent for the push summary. Never sent. */
export function describePlans(plans: AgentPlan[]): string[] {
  return plans.map((p) => {
    const what =
      p.mode === "subscription"
        ? `${p.tier ?? "subscription"}${p.multiplier ? ` ${p.multiplier}x` : ""} subscription`
        : p.mode === "cloud"
          ? "cloud provider account"
          : "API key, metered";
    return `  ${p.agent.padEnd(14)} ${what}`;
  });
}
