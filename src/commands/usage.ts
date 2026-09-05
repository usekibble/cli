import { loadConfig } from "../config.js";
import { sameServerOrigin } from "../server.js";

/** Same ceiling as push: no request may hang a scripted caller forever. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * What `GET /api/cli/usage` answers. Everything is the token owner's own
 * aggregates: the server scopes every figure to the one member this machine's
 * link token names, so this command can never read a colleague's data.
 */
export interface UsageReport {
  member: { email: string };
  organization: { name: string };
  range: {
    since: string;
    until: string;
    days: number;
    priorSince: string;
    priorUntil: string;
    /** True when the plan's retention floor cut the window short. */
    clamped: boolean;
  };
  /** Integer micros throughout: 1,000,000 costMicros is $1.00. */
  totals: PeriodTotals;
  prior: PeriodTotals;
  daily: { date: string; costMicros: number; isBilled: boolean }[];
  byAgent: Slice[];
  byModel: Slice[];
  /** Day by agent by model rows, the finest grain the server keeps. */
  detail: {
    date: string;
    agent: string;
    model: string;
    costMicros: number;
    tokens: number;
    isBilled: boolean;
  }[];
}

interface PeriodTotals {
  costMicros: number;
  tokens: number;
  billedMicros: number;
  estimatedMicros: number;
  activeMembers: number;
}

interface Slice {
  label: string;
  costMicros: number;
  tokens: number;
  billedShare: number;
}

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function utcDay(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * The words people say, mapped onto the windows the server keeps. `day` is
 * today so far; `week` and `month` are the dashboard's own 7 and 30 day
 * windows, so the number here matches the number on the screen.
 */
function windowFor(range: string | undefined): { range?: string; since?: string; until?: string } {
  switch (range ?? "month") {
    case "day":
      return { since: utcDay(0), until: utcDay(0) };
    case "week":
    case "7d":
      return { range: "7d" };
    case "month":
    case "30d":
      return { range: "30d" };
    case "90d":
      return { range: "90d" };
    default:
      throw new Error(`unknown range "${range}" -- use day, week, month, or 90d`);
  }
}

export async function usage(opts: {
  range?: string;
  since?: string;
  until?: string;
  json?: boolean;
  server?: string;
}): Promise<void> {
  const config = loadConfig();
  const server = opts.server ?? config.server;
  if (!config.linkToken) {
    throw new Error("Not linked. Run `kibble login` first.");
  }
  if (!sameServerOrigin(server, config.server)) {
    throw new Error("This credential belongs to another server. Run `kibble login --server <url>` first.");
  }

  const url = new URL("/api/cli/usage", server);
  if (opts.since || opts.until) {
    if (!opts.since || !opts.until) {
      throw new Error("--since and --until go together, both YYYY-MM-DD");
    }
    url.searchParams.set("since", opts.since);
    url.searchParams.set("until", opts.until);
  } else {
    const w = windowFor(opts.range);
    if (w.range) url.searchParams.set("range", w.range);
    if (w.since && w.until) {
      url.searchParams.set("since", w.since);
      url.searchParams.set("until", w.until);
    }
  }

  const res = await fetch(url, {
    redirect: "error",
    headers: { authorization: `Bearer ${config.linkToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`usage read failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const report = (await res.json()) as UsageReport;

  if (opts.json) {
    // For scripts and agents: the server's answer, verbatim.
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const { range, totals, prior } = report;
  console.log(
    `${report.member.email} at ${report.organization.name}  ${range.since}..${range.until}` +
      (range.clamped ? "  (cut to your plan's retention window)" : ""),
  );
  const delta = totals.costMicros - prior.costMicros;
  console.log(
    `  total   ${usd(totals.costMicros).padStart(10)}  ${totals.tokens.toLocaleString().padStart(15)} tokens` +
      `   ${delta >= 0 ? "+" : "-"}${usd(Math.abs(delta))} vs prior ${range.days} day(s)`,
  );
  if (totals.billedMicros > 0) {
    console.log(
      `  of it   ${usd(totals.billedMicros).padStart(10)} vendor-billed, ${usd(totals.estimatedMicros)} estimated (never summed twice: billed wins the day)`,
    );
  }
  for (const [title, slices] of [
    ["by agent", report.byAgent],
    ["by model", report.byModel],
  ] as const) {
    if (slices.length === 0) continue;
    console.log(`\n  ${title}`);
    for (const s of slices) {
      console.log(
        `    ${s.label.padEnd(28)} ${usd(s.costMicros).padStart(10)}  ${s.tokens.toLocaleString().padStart(15)} tokens`,
      );
    }
  }
  if (totals.costMicros === 0) {
    console.log("\n  No usage in this window.");
  }
  console.log("\n  Full day-by-day detail: kibble usage --json");
}
