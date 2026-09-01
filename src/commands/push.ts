import { createHash } from "node:crypto";
import { loadConfig, saveConfig, type KibbleConfig } from "../config.js";
import { acquire } from "../lock.js";
import { enforcePolicy } from "./schedule.js";
import type { CapabilityRecord } from "../sources/capabilities.js";
import { priceRecord } from "../sources/pricing.js";
import { scanLocal } from "../sources/local.js";
import { describePlans, readPlans } from "../sources/plans.js";
import { summarizeRepos } from "../sources/repos.js";
import { createSource, parseSourceName } from "../sources/index.js";
import type { CollectResult, NormalizedDailyUsage } from "../sources/types.js";

/** No request is allowed to hang the scheduled push into the next hour. */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * How far back a machine that has been offline will reach on its own.
 *
 * The window used to be a fixed yesterday..today, so a laptop that could not
 * reach the server for two days silently lost the first one. It now resumes
 * from the last day the server accepted, bounded here: a machine that has been
 * away for a year must not open a year of transcripts on the first push back,
 * and 30 days is what the personal plan retains anyway.
 */
const MAX_BACKFILL_DAYS = 30;

/** Resend an unchanged capability inventory this often, so a gap self-heals. */
const CAPABILITY_RESEND_MS = 6 * 60 * 60 * 1000;

function utcDay(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/** Group rows for the human-readable summary. Never sent to the server. */
function summarize(rows: NormalizedDailyUsage[]): string[] {
  const byAgent = new Map<string, { cost: number; tokens: number }>();
  for (const r of rows) {
    const acc = byAgent.get(r.agent) ?? { cost: 0, tokens: 0 };
    acc.cost += r.costMicros;
    acc.tokens +=
      r.tokensIn +
      r.tokensOut +
      r.tokensCacheRead +
      r.tokensCacheWrite +
      r.tokensReasoning;
    byAgent.set(r.agent, acc);
  }
  return [...byAgent.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(
      ([agent, v]) =>
        `  ${agent.padEnd(14)} ${usd(v.cost).padStart(10)}  ${v.tokens.toLocaleString().padStart(15)} tokens`,
    );
}

/** Session-size percentiles: whale sessions dominate spend, averages hide them. */
function sessionPercentiles(result: CollectResult): string | null {
  const costs = result.sessions.map((s) => s.costMicros).sort((a, b) => a - b);
  if (costs.length < 4) return null;
  const at = (q: number) => costs[Math.min(costs.length - 1, Math.floor(q * costs.length))]!;
  const total = costs.reduce((s, c) => s + c, 0);
  const top10 = costs.slice(Math.floor(costs.length * 0.9)).reduce((s, c) => s + c, 0);
  return (
    `  ${String(costs.length).padStart(4)} sessions   ` +
    `p50 ${usd(at(0.5))}  p90 ${usd(at(0.9))}  max ${usd(costs[costs.length - 1]!)}   ` +
    `top 10% = ${((top10 / total) * 100).toFixed(0)}% of spend`
  );
}

/** A capability that is installed and has done nothing in the window. */
function isIdle(c: CapabilityRecord): boolean {
  return c.invocations === 0 && c.attributedTurns === 0;
}

/**
 * Which day the first push of a run should start from.
 *
 * `lastPushedThrough` is the last day the server accepted. Re-sending it is
 * free (ingest is idempotent and the server skips an unchanged row), and it is
 * the only way a day worked through an outage ever arrives.
 */
function resumeFrom(config: KibbleConfig): string {
  const floor = utcDay(-MAX_BACKFILL_DAYS);
  const last = config.lastPushedThrough;
  const wanted = last && last < utcDay(-1) ? last : utcDay(-1);
  return wanted < floor ? floor : wanted;
}

export async function push(opts: {
  since?: string;
  until?: string;
  dryRun?: boolean;
  server?: string;
  source?: string;
  capabilities?: boolean;
  /** One line per run, for the hourly schedule's log. */
  quiet?: boolean;
}): Promise<void> {
  const config = loadConfig();
  const say = opts.quiet ? () => {} : console.log;
  const stamp = () => new Date().toISOString();
  const server = opts.server ?? config.server;
  // Resume from where the server left off, so an offline day is not lost; the
  // floor is yesterday, because a push early in the UTC day would otherwise
  // silently drop the tail of the previous day's work.
  const since = opts.since ?? resumeFrom(config);
  const until = opts.until ?? utcDay(0);

  // A dry run reads and prints; it competes with nothing and takes no lock.
  const lock = opts.dryRun ? null : acquire();
  if (lock && "busy" in lock) {
    console.log(
      `${opts.quiet ? `${stamp()}  ` : ""}Another \`kibble push\` has been running for ` +
        `${Math.round(lock.busy / 1000)}s; leaving this hour to it.`,
    );
    return;
  }

  try {
    await run();
  } finally {
    if (lock && "release" in lock) lock.release();
  }

  async function run(): Promise<void> {
    const source = createSource(parseSourceName(opts.source));
    const result = await source.collect({ since, until });
    const rows = result.daily;

    if (rows.length === 0) {
      console.log(`${opts.quiet ? `${stamp()}  ` : ""}No usage found for ${since}..${until}.`);
      return;
    }

    const total = rows.reduce((sum, r) => sum + r.costMicros, 0);
    const days = new Set(rows.map((r) => r.date)).size;

    say(`${since}..${until}  ${rows.length} rows across ${days} day(s)  [${source.name}]`);
    say(summarize(rows).join("\n"));
    say(`  ${"TOTAL".padEnd(14)} ${usd(total).padStart(10)}`);

    const percentiles = sessionPercentiles(result);
    if (percentiles) say(`\n${percentiles}`);

    // The organization's policy, echoed at login and on every push; on until a
    // server says otherwise. Names only -- see sources/capabilities.ts.
    const wantCapabilities = opts.capabilities ?? config.capabilities ?? true;
    const priceOf = await priceRecord(rows.map((r) => r.model));
    // One pass over the transcripts for both sidecars -- see sources/local.ts.
    const { repos, capabilities } = scanLocal({
      since,
      until,
      priceOf,
      capabilities: wantCapabilities,
    });
    if (repos.length > 0) say(`\n${summarizeRepos(repos).join("\n")}`);

    // How each agent is billed here: subscription, API key or a cloud account,
    // with the tier. Read from the agents' own login files; the ids and tokens
    // beside those fields stay in this process -- see sources/plans.ts.
    const plans = readPlans();
    if (plans.length > 0) say(`\n  billing:\n${describePlans(plans).join("\n")}`);

    // Installed-but-idle capabilities are most of the payload and change only
    // when somebody installs or removes something, so an unchanged set rides
    // along a few times a day rather than 24. The server upserts on
    // (date, member, kind, name), so a row left out is a row left as it was.
    const idle = capabilities.filter(isIdle);
    const digest = createHash("sha256")
      .update(JSON.stringify(idle.map((c) => [c.agent, c.date, c.kind, c.name, c.descriptionTokens])))
      .digest("hex");
    const sentAt = Date.parse(config.capabilityDigestAt ?? "");
    const resendIdle =
      digest !== config.capabilityDigest ||
      !Number.isFinite(sentAt) ||
      Date.now() - sentAt > CAPABILITY_RESEND_MS;
    const sending = resendIdle ? capabilities : capabilities.filter((c) => !isIdle(c));

    if (wantCapabilities) {
      const used = capabilities.length - idle.length;
      say(
        `\n  capabilities: ${used} used, ${idle.length} installed but never fired (names only)` +
          (resendIdle ? "" : ", unchanged since the last push and not re-sent"),
      );
    }

    if (opts.dryRun) {
      say(
        "\nDry run -- nothing sent. Payload is counts only: date, agent, model,\n" +
          "provider, token totals, message count, cost, opaque session ids, repo and\n" +
          "branch names, per-repo activity counts (tool calls, errors, turns,\n" +
          "edits, lines, hook failures) with tool, version and enum names, and,\n" +
          "while the organization asks for them, skill, command and MCP server\n" +
          "names with invocation counts and description sizes, and per agent\n" +
          "how this machine is billed (subscription, API key or cloud) and the\n" +
          "plan tier.\n" +
          "No prompts, no file contents, no tool arguments, no paths, no ids.",
      );
      return;
    }

    if (!config.linkToken) {
      throw new Error(
        "Not linked. Run `kibble login` first.",
      );
    }

    const payload = JSON.stringify({
      source: "local",
      collector: source.name,
      rows,
      sessions: result.sessions,
      capabilities: sending,
      repos,
      plans,
    });
    const res = await postWithRetry(new URL("/api/ingest", server), config.linkToken, payload);

    if (!res.ok) {
      throw new Error(
        `push failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
      );
    }

    const body = (await res.json()) as {
      applied?: number;
      sessions?: number;
      capabilities?: number;
      repos?: number;
      /** Org policies, echoed on every push so a change reaches this machine. */
      autoCollect?: boolean;
      collectCapabilities?: boolean;
    };
    console.log(
      (opts.quiet ? `${stamp()}  ` : "\n") +
        `Pushed ${body.applied ?? rows.length} rows` +
        (body.sessions ? `, ${body.sessions} session ids` : "") +
        (body.capabilities ? `, ${body.capabilities} capability rows` : "") +
        (body.repos ? `, ${body.repos} repo rows` : "") +
        ` to ${server}.`,
    );

    // Everything the push learned about itself, written once. Re-read first:
    // the scan and the request took time, and nothing here may clobber a
    // field another command changed meanwhile.
    const next: KibbleConfig = { ...loadConfig() };
    // Only ever forward: an explicit `--until` in the past must not rewind it.
    if (!next.lastPushedThrough || until > next.lastPushedThrough) {
      next.lastPushedThrough = until;
    }
    // Only when the server kept them; with the policy off it drops the section.
    if (wantCapabilities && body.collectCapabilities !== false && resendIdle) {
      next.capabilityDigest = digest;
      next.capabilityDigestAt = new Date().toISOString();
    }
    if (body.collectCapabilities !== undefined) next.capabilities = body.collectCapabilities;
    if (body.autoCollect !== undefined) next.autoCollect = body.autoCollect;
    saveConfig(next);

    if (body.collectCapabilities !== undefined && body.collectCapabilities !== config.capabilities) {
      console.log(
        `${opts.quiet ? `${stamp()}  ` : ""}Your organization turned capability reporting ${body.collectCapabilities ? "on" : "off"}; applied from the next push.`,
      );
    }
    enforcePolicy(next, body.autoCollect, (line) => console.log(opts.quiet ? `${stamp()}  ${line}` : line));
  }
}

/**
 * One retry, and only for failures that are about the moment rather than the
 * request: the server said "later" (429, 503), fell over (other 5xx), the
 * network dropped, or nothing answered inside `REQUEST_TIMEOUT_MS`. A 4xx is a
 * real answer and is returned as is. The wait is jittered so a fleet that
 * failed together does not retry together; ingest is idempotent, so a request
 * that landed but whose reply was lost is harmless.
 *
 * The timeout is not optional. Without it a connection that is accepted and
 * then never answered hangs the process forever, and cron and Task Scheduler,
 * unlike launchd, would start another one an hour later, and another.
 */
async function postWithRetry(url: URL, token: string, body: string): Promise<Response> {
  const attempt = () =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body,
      // A fresh signal per attempt: a timeout starts counting when it is made.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  const retryable = (res: Response) => res.status === 429 || res.status >= 500;

  let first: Response | undefined;
  try {
    first = await attempt();
    if (!retryable(first)) return first;
  } catch {
    // Network error or timeout: fall through to the retry.
  }

  const retryAfter = Number(first?.headers.get("retry-after"));
  const base = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5_000;
  await new Promise((r) => setTimeout(r, base + Math.random() * 10_000));

  try {
    return await attempt();
  } catch (err) {
    if (first) return first;
    throw err;
  }
}
