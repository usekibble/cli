import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configPath, loadConfig, saveConfig, type KibbleConfig } from "../config.js";

/**
 * `kibble schedule` -- run `kibble push` every hour without a human at the
 * keyboard.
 *
 * The collector has no daemon on purpose: a resident process that watches
 * transcript directories is exactly the shape of thing a "never surveillance"
 * tool should not be. Instead the OS scheduler that is already on the machine
 * runs the same one-shot `kibble push` a person would type, and the push is
 * idempotent so an hourly cadence just keeps the day current.
 *
 *   macOS    a LaunchAgent, StartInterval 3600, RunAtLoad (so also at login)
 *   Linux    two crontab lines tagged with a marker comment: hourly and @reboot
 *            (the hourly line runs at a minute picked at random on install, so
 *            a fleet of machines does not all hit the server at :00)
 *   Windows  two Scheduled Tasks: /SC HOURLY and /SC ONLOGON
 *
 * Each of these records the absolute node binary and the absolute entry
 * script, so the job survives a shell with no PATH. Output goes to
 * `~/.config/kibble/push.log`.
 *
 * When the organization has turned on automatic collection (Settings, owner
 * or admin), the schedule is not optional: `kibble login` installs it, every
 * push re-checks it, and `uninstall` refuses while the policy holds. The
 * policy decides *when* counts are sent; it never widens *what* is sent.
 */

const LABEL = "com.usekibble.push";
const BOOT_LABEL = "com.usekibble.push.boot";

/**
 * Labels this CLI registered under before the product moved to usekibble.com.
 *
 * A machine that installed the schedule under the old reverse-DNS name keeps
 * that LaunchAgent or scheduled task across an upgrade, and nothing in the new
 * name matches it: `uninstall` would leave it behind, and the laptop would go
 * on pushing every hour with no command that stops it. Ingest is idempotent so
 * a duplicate never corrupted a number, but a background job the person cannot
 * turn off is not a thing to ship. Both install and uninstall sweep these
 * first, so the rename heals itself on the next push.
 *
 * Linux needs no entry here: the crontab lines are found by `CRON_MARKER`,
 * which never carried the domain.
 */
const LEGACY_LABELS = ["dev.getkibble.push", "dev.getkibble.push.boot"] as const;
const CRON_MARKER = "# kibble: hourly push (managed by `kibble schedule`)";
const INTERVAL_SECONDS = 3600;

export const POLICY_MESSAGE =
  "Your organization requires automatic collection, so the schedule stays. An owner or admin can turn it off under Settings.";

export interface ScheduleOptions {
  server?: string;
}

/** Where the scheduled push writes. Next to config.json, not in $TMPDIR. */
export function logPath(): string {
  return join(dirname(configPath()), "push.log");
}

function plistPathFor(label: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function plistPath(): string {
  return plistPathFor(LABEL);
}

/** Remove any schedule still registered under a name we no longer use. */
function sweepLegacy(): void {
  for (const label of LEGACY_LABELS) {
    if (process.platform === "darwin") {
      spawnSync("launchctl", ["bootout", `${launchdDomain()}/${label}`], { stdio: "ignore" });
      const path = plistPathFor(label);
      if (existsSync(path)) unlinkSync(path);
    } else if (process.platform === "win32") {
      spawnSync("schtasks", ["/Delete", "/F", "/TN", label], { stdio: "ignore" });
    }
  }
}

/**
 * The exact command the scheduler will run. `process.argv[1]` is the entry
 * script for both the `kibble` bin and `node dist/index.js`; under `tsx` it is
 * the TypeScript source, which node cannot run on its own, so refuse.
 */
function pushCommand(): { node: string; script: string; args: string[] } {
  const script = resolve(process.argv[1] ?? "");
  if (!script || !existsSync(script)) {
    throw new Error("could not locate the kibble entry script to schedule");
  }
  if (/\.tsx?$/.test(script)) {
    throw new Error(
      "refusing to schedule the TypeScript source -- build first (`pnpm build`) and run `node dist/index.js schedule install`, or install the published CLI",
    );
  }
  return { node: process.execPath, script, args: ["push", "--quiet"] };
}

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

/* -------------------------------------------------------------------------- */

/** Whether the background push is registered with this machine's scheduler. */
export function installed(): boolean {
  switch (process.platform) {
    case "darwin":
      return existsSync(plistPath());
    case "linux":
      return readCrontab().some((l) => l === CRON_MARKER);
    case "win32":
      return spawnSync("schtasks", ["/Query", "/TN", LABEL], { stdio: "ignore" }).status === 0;
    default:
      return false;
  }
}

/** Register the hourly and at-startup push. Returns the command it registered. */
function register(): { cmd: ReturnType<typeof pushCommand>; log: string } {
  const cmd = pushCommand();
  const log = logPath();
  mkdirSync(dirname(log), { recursive: true });
  // Before adding the new one, so an upgraded machine ends with one schedule.
  sweepLegacy();

  switch (process.platform) {
    case "darwin":
      installLaunchd(cmd, log);
      break;
    case "linux":
      installCron(cmd, log);
      break;
    case "win32":
      installSchtasks(cmd, log);
      break;
    default:
      throw new Error(`no scheduler support for platform "${process.platform}"`);
  }
  return { cmd, log };
}

/**
 * Bring this machine in line with the organization's policy. Called after
 * `kibble login` and after every `kibble push`, with the `autoCollect` flag the
 * server just returned.
 *
 * Policy on and nothing scheduled: install, and say so. Policy off: leave
 * whatever the person chose alone, in both directions. Installing can fail
 * (running from `tsx`, an exotic platform); that is reported, never fatal,
 * because the push that just succeeded is still a success.
 */
export function enforcePolicy(
  config: KibbleConfig,
  autoCollect: boolean | undefined,
  say: (line: string) => void,
): void {
  if (autoCollect === undefined) return;
  if (config.autoCollect !== autoCollect) saveConfig({ ...config, autoCollect });
  if (!autoCollect || installed()) return;
  try {
    register();
    say("Your organization requires automatic collection: scheduled `kibble push` hourly and at startup.");
  } catch (err) {
    say(`Your organization requires automatic collection, but scheduling failed: ${(err as Error).message}`);
  }
}

export async function scheduleInstall(_opts: ScheduleOptions): Promise<void> {
  const config = loadConfig();
  if (!config.linkToken) {
    throw new Error("Not linked. Run `kibble login` first, then `kibble schedule install`.");
  }

  const { cmd, log } = register();

  console.log(`Scheduled \`kibble push\` every hour and at startup.`);
  console.log(`  runs     ${cmd.node} ${cmd.script} ${cmd.args.join(" ")}`);
  console.log(`  log      ${log}`);
  if (config.autoCollect) {
    console.log("Required by your organization; an owner or admin can change that under Settings.");
  } else {
    console.log(`Remove it with \`kibble schedule uninstall\`.`);
  }
}

export async function scheduleUninstall(opts: { force?: boolean } = {}): Promise<void> {
  // The policy is the organization's, so the collector honours it even when
  // the person typing has root. `--force` exists for a machine that has left
  // the organization but still holds a stale config.
  if (loadConfig().autoCollect && !opts.force) {
    throw new Error(POLICY_MESSAGE);
  }
  console.log(removeSchedule() ? "Removed the background push." : "No background push was scheduled.");
}

/** Take the job out of the scheduler. Returns whether there was one. */
export function removeSchedule(): boolean {
  let removed = false;
  // "Uninstall" has to mean every schedule this CLI ever registered, not only
  // the one the current version knows how to name.
  sweepLegacy();
  switch (process.platform) {
    case "darwin":
      removed = uninstallLaunchd();
      break;
    case "linux":
      removed = uninstallCron();
      break;
    case "win32":
      removed = uninstallSchtasks();
      break;
    default:
      return false;
  }
  return removed;
}

export async function scheduleStatus(): Promise<void> {
  const config = loadConfig();
  const yes = installed();
  const where =
    process.platform === "darwin"
      ? plistPath()
      : process.platform === "linux"
        ? "crontab (hourly and @reboot)"
        : process.platform === "win32"
          ? `Task Scheduler (${LABEL}, ${BOOT_LABEL})`
          : "";
  console.log(`scheduled ${yes ? "yes" : "no -- run 'kibble schedule install'"}`);
  if (yes) console.log(`where     ${where}`);
  console.log(
    `policy    ${config.autoCollect === undefined ? "unknown -- run 'kibble login'" : config.autoCollect ? "required by your organization" : "optional"}`,
  );
  console.log(`log       ${logPath()}`);
  const log = logPath();
  if (existsSync(log)) {
    const lines = readFileSync(log, "utf8").trimEnd().split("\n");
    const last = lines[lines.length - 1];
    if (last) console.log(`last      ${last}`);
  }
}

/* ------------------------------- macOS ------------------------------------ */

function installLaunchd(cmd: ReturnType<typeof pushCommand>, log: string): void {
  const path = plistPath();
  const argv = [cmd.node, cmd.script, ...cmd.args];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>StartInterval</key>
  <integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(dirname(cmd.node))}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
  mkdirSync(dirname(path), { recursive: true });
  // Unload any previous copy first so a changed node path takes effect.
  spawnSync("launchctl", ["bootout", `${launchdDomain()}/${LABEL}`], { stdio: "ignore" });
  writeFileSync(path, plist, { mode: 0o644 });
  const res = spawnSync("launchctl", ["bootstrap", launchdDomain(), path], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`launchctl bootstrap failed: ${(res.stderr || res.stdout).trim()}`);
  }
}

function uninstallLaunchd(): boolean {
  const path = plistPath();
  spawnSync("launchctl", ["bootout", `${launchdDomain()}/${LABEL}`], { stdio: "ignore" });
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/* ------------------------------- Linux ------------------------------------ */

function readCrontab(): string[] {
  const res = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  // "no crontab for <user>" exits 1; that is an empty table, not an error.
  if (res.status !== 0) return [];
  return res.stdout.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
}

function writeCrontab(lines: string[]): void {
  execFileSync("crontab", ["-"], { input: lines.join("\n") + "\n" });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Drop our marker and the schedule lines under it. Older installs wrote one
 * line, current ones write two (hourly and @reboot); both end where the next
 * line stops mentioning our entry script.
 */
function withoutOurs(lines: string[]): { rest: string[]; had: boolean } {
  const rest: string[] = [];
  let had = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === CRON_MARKER) {
      had = true;
      while (i + 1 < lines.length && /(^0 \* \* \* \* |^@reboot ).*push.*--quiet/.test(lines[i + 1]!)) i++;
      continue;
    }
    rest.push(lines[i]!);
  }
  return { rest, had };
}

function installCron(cmd: ReturnType<typeof pushCommand>, log: string): void {
  const { rest } = withoutOurs(readCrontab());
  const command = [cmd.node, cmd.script, ...cmd.args].map(shellQuote).join(" ");
  const redirect = `>> ${shellQuote(log)} 2>&1`;
  // Hourly, plus once when the machine comes up so a laptop that sleeps
  // through the top of the hour still reports. The minute is random per
  // install: launchd and schtasks already count from install time, cron
  // would otherwise make every Linux box push in the same second.
  const minute = Math.floor(Math.random() * 60);
  rest.push(
    CRON_MARKER,
    `${minute} * * * * ${command} ${redirect}`,
    `@reboot ${command} ${redirect}`,
  );
  writeCrontab(rest);
}

function uninstallCron(): boolean {
  const { rest, had } = withoutOurs(readCrontab());
  if (had) writeCrontab(rest);
  return had;
}

/* ------------------------------ Windows ----------------------------------- */

function installSchtasks(cmd: ReturnType<typeof pushCommand>, log: string): void {
  const inner = [cmd.node, cmd.script, ...cmd.args].map((a) => `"${a}"`).join(" ");
  const tr = `cmd /c ${inner} >> "${log}" 2>&1`;
  // Two tasks: one hourly, one when the person logs on. A per-user ONLOGON
  // task needs no elevation, unlike ONSTART.
  for (const [name, schedule] of [
    [LABEL, "HOURLY"],
    [BOOT_LABEL, "ONLOGON"],
  ] as const) {
    const res = spawnSync(
      "schtasks",
      ["/Create", "/F", "/SC", schedule, "/TN", name, "/TR", tr],
      { encoding: "utf8" },
    );
    if (res.status !== 0) {
      throw new Error(`schtasks /Create failed: ${(res.stderr || res.stdout).trim()}`);
    }
  }
}

function uninstallSchtasks(): boolean {
  const res = spawnSync("schtasks", ["/Delete", "/F", "/TN", LABEL], { stdio: "ignore" });
  spawnSync("schtasks", ["/Delete", "/F", "/TN", BOOT_LABEL], { stdio: "ignore" });
  return res.status === 0;
}
