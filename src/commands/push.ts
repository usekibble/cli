import { loadConfig } from "../config.js";
import { enforcePolicy } from "./schedule.js";
import { scanCapabilities } from "../sources/capabilities.js";
import { priceRecord } from "../sources/pricing.js";
import { scanRepos, summarizeRepos } from "../sources/repos.js";
import { createSource, parseSourceName } from "../sources/index.js";
import type { CollectResult, NormalizedDailyUsage } from "../sources/types.js";

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
  // Default window is yesterday..today: a push early in the UTC day would
  // otherwise silently drop the tail of the previous day's work.
  const since = opts.since ?? utcDay(-1);
  const until = opts.until ?? utcDay(0);

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

  // Opt-in, off by default. Names only -- see sources/capabilities.ts.
  const wantCapabilities = opts.capabilities ?? config.capabilities ?? false;
  const priceOf = await priceRecord(rows.map((r) => r.model));
  const repos = scanRepos({ since, until, priceOf });
  if (repos.length > 0) say(`\n${summarizeRepos(repos).join("\n")}`);

  const capabilities = wantCapabilities
    ? scanCapabilities({
        since,
        until,
        priceOf,
      })
    : [];
  if (wantCapabilities) {
    const used = capabilities.filter((c) => c.invocations > 0).length;
    const idle = capabilities.filter((c) => c.installed && c.invocations === 0).length;
    say(
      `\n  capabilities: ${used} used, ${idle} installed but never fired (names only)`,
    );
  }

  if (opts.dryRun) {
    say(
      "\nDry run -- nothing sent. Payload is counts only: date, agent, model,\n" +
        "provider, token totals, message count, cost, opaque session ids, repo and\n" +
        "branch names, and per-repo activity counts (tool calls, errors, turns,\n" +
        "edits, lines, hook failures) with tool, version and enum names.\n" +
        "No prompts, no file contents, no tool arguments, no paths.",
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
    capabilities,
    repos,
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
    /** Org policy, echoed on every push so a change reaches this machine. */
    autoCollect?: boolean;
  };
  console.log(
    (opts.quiet ? `${stamp()}  ` : "\n") +
      `Pushed ${body.applied ?? rows.length} rows` +
      (body.sessions ? `, ${body.sessions} session ids` : "") +
      (body.capabilities ? `, ${body.capabilities} capability rows` : "") +
      (body.repos ? `, ${body.repos} repo rows` : "") +
      ` to ${server}.`,
  );

  enforcePolicy(config, body.autoCollect, (line) => console.log(opts.quiet ? `${stamp()}  ${line}` : line));
}

/**
 * One retry, and only for failures that are about the moment rather than the
 * request: the server said "later" (429, 503), fell over (other 5xx), or the
 * network dropped. A 4xx is a real answer and is returned as is. The wait is
 * jittered so a fleet that failed together does not retry together; ingest is
 * idempotent, so a request that landed but whose reply was lost is harmless.
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
    });
  const retryable = (res: Response) => res.status === 429 || res.status >= 500;

  let first: Response | undefined;
  try {
    first = await attempt();
    if (!retryable(first)) return first;
  } catch {
    // Network error: fall through to the retry.
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
