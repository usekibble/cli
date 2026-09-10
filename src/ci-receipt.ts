import { z } from "zod";

export const CI_RECEIPT_BYTES = 128 * 1024;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokens = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count,
  reasoning: count.nullable() }).strict().refine((v) => v.reasoning === null || v.reasoning <= v.output);
const model = tokens.safeExtend({ model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/), costMicros: count.nullable() });
/**
 * The checkout a run worked in, as the laptop sidecar already reports it: a
 * repo NAME (never a path or a full slug) and a git branch name. These are the
 * keys that let a CI receipt sit beside `repo_daily` and `repo_branches`, and
 * later beside whatever the code host says merged. Omitted, not nulled, when
 * nothing is known.
 */
const CI_REPO_NAME = /^(?!\.\.?$)[^\s/\\\x00-\x1f\x7f]{1,128}$/;
const CI_BRANCH_NAME = /^(?![-/])(?!.*(?:\.\.|\/\/|\/$|\.lock$|@\{))[^\s\\~^:?*[\]\x00-\x1f\x7f]{1,255}$/;
export const ciWorkspaceSchema = z.object({ repo: z.string().regex(CI_REPO_NAME).nullable(), branch: z.string().regex(CI_BRANCH_NAME).nullable() })
  .strict().refine((w) => w.repo !== null || w.branch !== null);
const signal = z.enum(["SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT",
  "SIGIO", "SIGIOT", "SIGKILL", "SIGPIPE", "SIGPOLL", "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT",
  "SIGSTOP", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGUNUSED", "SIGURG", "SIGUSR1",
  "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ", "SIGBREAK", "SIGINFO", "SIGLOST"]);

/** Shared strict wire contract, also used before any CLI network request. */
export const ciReceiptSchema = z.object({
  schemaVersion: z.literal(1), revision: count,
  runId: z.uuid(), agent: z.enum(["codex", "claude-code"]),
  source: z.literal("transcript").optional(), sessionKey: z.uuid().optional(),
  accountingScope: z.enum(["codex_main_thread", "claude_query_including_subagents", "recorded_session"]),
  startedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(), durationMs: count.nullable(),
  outcome: z.enum(["running", "succeeded", "failed", "interrupted", "launch_failed", "unknown"]),
  process: z.object({ exitCode: count.nullable(), signal: signal.nullable(), forwardedSignal: z.enum(["SIGINT", "SIGTERM"]).nullable() }).strict(),
  usageStatus: z.enum(["complete", "partial", "unavailable"]), tokens: tokens.nullable(),
  models: z.array(model).max(128), costMicros: count.nullable(), costBasis: z.enum(["agent_estimate", "list_price_estimate", "unavailable"]),
  agentResult: z.enum(["succeeded", "failed"]).nullable(),
  activity: z.object({ toolCalls: count, toolErrors: count }).strict(),
  workspace: ciWorkspaceSchema.optional(),
  issues: z.array(z.enum(["invalid_json", "oversized_record", "invalid_usage", "missing_final_usage", "main_agent_usage_only",
    "unsupported_model_name", "counter_limit", "stream_error", "transcript_usage_only"])).max(9),
}).strict().superRefine((r, ctx) => {
  const fail = () => ctx.addIssue({ code: "custom", message: "inconsistent receipt" });
  if ((r.costMicros === null) !== (r.costBasis === "unavailable")) fail();
  if ((r.tokens === null) !== (r.usageStatus === "unavailable")) fail();
  if (!r.tokens && (r.models.length || r.costMicros !== null)) fail();
  if (r.usageStatus === "complete" && r.issues.length) fail();
  if (r.source === "transcript") {
    if (!r.sessionKey || r.runId !== r.sessionKey || r.accountingScope !== "recorded_session" ||
      r.outcome !== "unknown" || r.endedAt !== null || r.durationMs !== null || r.agentResult !== null ||
      Object.values(r.process).some((value) => value !== null) || r.usageStatus === "complete" ||
      !r.issues.includes("transcript_usage_only") || r.costBasis === "agent_estimate") fail();
    if (r.revision !== transcriptRevision(r)) fail();
  } else {
    if (r.outcome === "unknown" || r.costBasis === "list_price_estimate" || r.issues.includes("transcript_usage_only")) fail();
    if (r.agent === "codex" ? r.accountingScope !== "codex_main_thread" || r.models.length || r.costMicros !== null
      : r.accountingScope !== "claude_query_including_subagents") fail();
  }
  if (new Set(r.models.map((m) => m.model)).size !== r.models.length) fail();
  if (r.tokens && r.models.length && !r.issues.includes("unsupported_model_name")) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (r.models.reduce((n, m) => n + m[key], 0) !== r.tokens[key]) fail();
    }
  }
  if (r.outcome === "running" || r.outcome === "unknown" ? r.endedAt !== null || r.durationMs !== null
    : r.endedAt === null || r.durationMs === null) fail();
  if (r.endedAt && Date.parse(r.endedAt) < Date.parse(r.startedAt)) fail();
  if (r.outcome === "succeeded" && (r.process.exitCode !== 0 || r.agentResult !== "succeeded")) fail();
});
export type CiReceipt = z.infer<typeof ciReceiptSchema>;

/** Content-derived revisions survive copied logs and lost local receipt files. */
export function transcriptRevision(r: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  activity: { toolCalls: number; toolErrors: number } }): number {
  return 1 + (r.tokens ? r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite : 0)
    + r.activity.toolCalls + r.activity.toolErrors;
}

/** Stable serialization makes property order irrelevant to replay detection. */
export function canonicalReceipt(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReceipt).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalReceipt(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
