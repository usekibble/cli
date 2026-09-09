import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, loadConfig, saveConfig } from "../config.js";
import { runTokscale, TokscaleCliSource } from "./tokscale-cli.js";
import type { CollectOptions, NormalizedDailyUsage } from "./types.js";

/** Account-wide totals never enter the device-scoped UsageSource daily rows. */
export interface CursorAccountSnapshot extends CollectOptions {
  accountId: string;
  fetchedAt: string;
  coveredDates: string[];
  rows: NormalizedDailyUsage[];
}

const LIMIT = 64 * 1024 * 1024;
const COUNTS = ["tokensIn", "tokensOut", "tokensCacheRead", "tokensCacheWrite", "tokensReasoning", "messageCount", "costMicros"] as const;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const snapshotPath = () => join(dirname(configPath()), "cursor-account.json");
function fail(): never { throw new Error("Invalid Cursor account snapshot. Run `kibble cursor sync` to refresh it."); }
function day(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function boundedRead(path: string): Buffer {
  if (statSync(path).size > LIMIT) throw new Error("Cursor account cache exceeds the safety limit.");
  const bytes = readFileSync(path);
  if (bytes.length > LIMIT) throw new Error("Cursor account cache exceeds the safety limit.");
  return bytes;
}

/** Validate and project, so unexpected local fields never reach the wire. */
export function validateCursorAccount(value: unknown): CursorAccountSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as CursorAccountSnapshot;
  if (typeof v.accountId !== "string" || !/^[a-f0-9]{64}$/.test(v.accountId) ||
    !day(v.since) || !day(v.until) || v.since > v.until ||
    Date.parse(v.until) - Date.parse(v.since) > 365 * 86400000 ||
    typeof v.fetchedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v.fetchedAt) ||
    !Number.isFinite(Date.parse(v.fetchedAt)) || Date.parse(v.fetchedAt) > Date.now() + 300000 ||
    v.fetchedAt.slice(0, 10) <= v.until || !Array.isArray(v.coveredDates) ||
    !v.coveredDates.length || v.coveredDates.length > 366 || !Array.isArray(v.rows) || v.rows.length > 10000) fail();
  const dates = new Set(v.coveredDates);
  if (dates.size !== v.coveredDates.length || v.coveredDates.some(d => !day(d) || d < v.since || d > v.until)) fail();
  const grains = new Set<string>();
  const rows = v.rows.map(r => {
    if (!r || !dates.has(r.date) || r.agent !== "cursor" || typeof r.model !== "string" || !r.model.length || r.model.length > 128 ||
      !(r.provider === null || typeof r.provider === "string" && r.provider.length <= 64) || r.messageCount > 2147483647 ||
      COUNTS.some(k => !Number.isSafeInteger(r[k]) || r[k] < 0)) fail();
    const grain = JSON.stringify([r.date, r.model]);
    if (grains.has(grain)) fail();
    grains.add(grain);
    return { date: r.date, agent: "cursor", model: r.model, provider: r.provider,
      tokensIn: r.tokensIn, tokensOut: r.tokensOut, tokensCacheRead: r.tokensCacheRead,
      tokensCacheWrite: r.tokensCacheWrite, tokensReasoning: r.tokensReasoning,
      messageCount: r.messageCount, costMicros: r.costMicros };
  });
  return { accountId: v.accountId, since: v.since, until: v.until, fetchedAt: v.fetchedAt, coveredDates: [...dates].sort(), rows };
}

export function readCursorAccount(options: CollectOptions): CursorAccountSnapshot | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(boundedRead(snapshotPath()).toString("utf8")); }
  catch { throw new Error("Could not read Cursor account snapshot. Run `kibble cursor sync`."); }
  const snapshot = validateCursorAccount(parsed);
  const coveredDates = snapshot.coveredDates.filter(d => d >= options.since && d <= options.until);
  if (!coveredDates.length) return undefined;
  const dates = new Set(coveredDates);
  return { ...snapshot, since: coveredDates[0]!, until: coveredDates.at(-1)!, coveredDates,
    rows: snapshot.rows.filter(r => dates.has(r.date)) };
}

function identity(path: string): { accountId: string; fingerprint: string } {
  try {
    const bytes = boundedRead(path);
    const value = JSON.parse(bytes.toString("utf8"));
    const ids = Object.keys(value.accounts ?? {});
    if (ids.length !== 1 || ids[0] !== value.activeAccountId) throw new Error();
    const userId = value.accounts[ids[0]!]?.userId;
    if (typeof userId !== "string" || !userId.length) throw new Error();
    return { accountId: digest(`kibble:cursor-account:v1:${userId}`), fingerprint: digest(bytes) };
  } catch { throw new Error("Cursor account sync requires exactly one active tokscale account. Check `tokscale cursor accounts`."); }
}

function assertSingleCache(directory: string): void {
  const csv = readdirSync(directory).filter(name => name.toLowerCase().endsWith(".csv"));
  if (csv.length !== 1 || csv[0] !== "usage.csv") throw new Error("Cursor cache contains additional account exports. Isolate the active account in tokscale before syncing; no files were removed.");
}

/** Dates only: cloud agent ids, automation ids and other CSV columns stay local. */
export function cursorExportDates(csv: string): string[] {
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (!lines.shift()?.replace(/^\uFEFF/, "").startsWith("Date,")) throw new Error("Unsupported Cursor usage export.");
  const dates = new Set<string>();
  for (const line of lines) {
    const raw = /^"([^"]+)"(?:,|$)|^([^,]+)(?:,|$)/.exec(line);
    const timestamp = raw?.[1] ?? raw?.[2];
    if (!timestamp || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
      throw new Error("Unsupported Cursor usage export date.");
    }
    dates.add(new Date(timestamp).toISOString().slice(0, 10));
  }
  // The export does not disclose its billing-window start. Its oldest day may
  // be partial, and absent days are not evidence of zero account usage.
  return [...dates].sort().slice(1);
}

export async function cursorAccountSync(): Promise<void> {
  const directory = join(homedir(), ".config", "tokscale");
  const credentials = join(directory, "cursor-credentials.json");
  // This explicit command grants account access; ordinary push never logs in.
  try { statSync(credentials); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not access Cursor account credentials.");
    await runTokscale(["cursor", "login"]);
  }
  const before = identity(credentials);
  let synced: { synced?: boolean };
  try { synced = JSON.parse(await runTokscale(["cursor", "sync", "--json"])); }
  catch { throw new Error("Cursor account sync failed. Check the desktop Cursor login and retry."); }
  if (synced.synced !== true) throw new Error("Cursor account sync did not download usage. Existing snapshot retained.");
  const fetchedAt = new Date().toISOString();
  const current = identity(credentials);
  if (before.accountId !== current.accountId) throw new Error("Cursor account changed during sync. Existing snapshot retained.");
  const cache = join(directory, "cursor-cache", "usage.csv");
  assertSingleCache(dirname(cache));
  const bytes = boundedRead(cache);
  const earliest = new Date(Date.parse(fetchedAt.slice(0, 10)) - 366 * 86400000).toISOString().slice(0, 10);
  const coveredDates = cursorExportDates(bytes.toString("utf8")).filter(d => d < fetchedAt.slice(0, 10) && d >= earliest);
  if (!coveredDates.length) throw new Error("Cursor export has no complete observed day. Existing snapshot retained.");
  const since = coveredDates[0]!;
  const until = coveredDates.at(-1)!;
  // Cursor's account cache ignores TOKSCALE_CONFIG_DIR, while scanner settings
  // honor it. Isolate UTC bucketing without changing the user's own settings.
  const settings = mkdtempSync(join(tmpdir(), "kibble-cursor-utc-"));
  let result;
  try {
    writeFileSync(join(settings, "settings.json"), JSON.stringify({ scanner: { bucketTimezone: "UTC" } }), { mode: 0o600 });
    result = await new TokscaleCliSource("cursor", { TZ: "UTC", TOKSCALE_CONFIG_DIR: settings }).collect({ since, until });
  } finally { rmSync(settings, { recursive: true, force: true }); }
  assertSingleCache(dirname(cache));
  if (digest(boundedRead(cache)) !== digest(bytes) || identity(credentials).fingerprint !== current.fingerprint) {
    throw new Error("Cursor cache or account changed while reading. Retry `kibble cursor sync`.");
  }
  const dates = new Set(coveredDates);
  const snapshot = validateCursorAccount({ accountId: current.accountId, since, until, fetchedAt, coveredDates,
    rows: result.daily.filter(r => dates.has(r.date)) });
  // Every observed CSV day must survive the pinned parser; a silent empty parse
  // cannot become an authoritative zero that hides existing local usage.
  if (coveredDates.some(d => !snapshot.rows.some(r => r.date === d))) throw new Error("Cursor export and parser coverage disagree.");
  const path = snapshotPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(snapshot) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  saveConfig({ ...loadConfig(), cursorAccountUsage: true });
  console.log(`Synced Cursor account usage: ${snapshot.rows.length} rows across ${coveredDates.length} observed days. Nothing uploaded.`);
  console.log("Future pushes include this account snapshot separately from device activity. Run `kibble cursor sync` again to refresh it.");
}

export function cursorAccountDisable(): void {
  saveConfig({ ...loadConfig(), cursorAccountUsage: false });
  console.log("Cursor account snapshot uploads disabled. Local snapshot and tokscale credentials retained.");
}
