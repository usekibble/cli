import { execFile } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gt, prerelease, satisfies, valid } from "semver";
import { acquire } from "./lock.js";
import { loadConfig } from "./config.js";
import { installed, preserveSchedule, scheduleInstall } from "./commands/schedule.js";
import { updateText as t } from "./update-messages.js";
import {
  atomicWrite, launcherPath, readUpdateState, updateHome, writeUpdateState,
  type Runtime, type UpdateState,
} from "./update-state.js";

const execute = promisify(execFile);
const PACKAGE = "@usekibble/cli";
const REGISTRY = "https://registry.npmjs.org";
const DAY = 86_400_000;
const INSTALL_TIMEOUT = 180_000;

interface Release {
  name: string;
  version: string;
  engines: { node: string };
  dist: { tarball: string; integrity: string };
}

function packageInfo(root: string): { name: string; version: string; engines?: { node?: string } } {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

export function runningPackageRoot(): string {
  const entry = realpathSync(process.argv[1]!);
  if (isManagedEntry()) {
    const active = readUpdateState().active;
    if (!active) throw new Error(t("noRuntime"));
    return active.root;
  }
  return dirname(dirname(entry));
}

function isManagedEntry(): boolean {
  return existsSync(launcherPath()) && realpathSync(process.argv[1]!) === realpathSync(launcherPath());
}

/** Resolve npm's JS entry once, so scheduled jobs need neither a shell nor nvm. */
export function findNpm(): string {
  const candidates = [
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  for (const base of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    candidates.push(join(base, "node_modules/npm/bin/npm-cli.js"));
    try {
      const entry = realpathSync(join(base, "npm"));
      if (entry.endsWith("npm-cli.js")) candidates.push(entry);
    } catch { /* Not every PATH entry contains npm. */ }
  }
  const found = candidates.find(existsSync);
  if (!found) throw new Error(t("npmMissing"));
  return realpathSync(found);
}

async function npm(npmPath: string, args: string[], cwd: string): Promise<string> {
  try {
    const result = await execute(process.execPath, [npmPath, ...args], {
      cwd, timeout: INSTALL_TIMEOUT, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` },
    });
    return result.stdout;
  } catch (error) {
    // npm errors can echo registry credentials or environment configuration.
    if (/\bEBADENGINE\b/.test(String((error as { stderr?: string }).stderr ?? ""))) {
      throw new Error(t("newerNode"));
    }
    throw new Error(t("installFailed"));
  }
}

/** No lifecycle scripts run. Both native parsers ship prebuilt optional packages. */
async function installTarball(npmPath: string, tarball: string, directory: string): Promise<string> {
  writeFileSync(join(directory, "package.json"), '{"private":true}\n', { mode: 0o600 });
  await npm(npmPath, [
    "install", tarball, "--prefix", directory, "--ignore-scripts", "--engine-strict",
    "--include=optional", "--omit=dev", "--no-audit", "--no-fund", "--no-progress",
    "--global=false", "--workspaces=false", `--registry=${REGISTRY}`,
    `--@usekibble:registry=${REGISTRY}`, `--@tokscale:registry=${REGISTRY}`,
  ], directory);
  return join(directory, "node_modules", "@usekibble", "cli");
}

/** This checks startup and native loading, without opening any transcripts. */
export async function checkRuntime(runtime: Runtime): Promise<void> {
  const info = packageInfo(runtime.root);
  if (info.name !== PACKAGE || info.version !== runtime.version || !valid(info.version) ||
    !info.engines?.node || !satisfies(process.versions.node, info.engines.node)) {
    throw new Error(t("incompatible"));
  }
  try {
    // Probe the entry users and schedulers actually execute, as well as native
    // loading. A working parser alone cannot prove the bundled launcher works.
    for (const [entry, ...args] of [["dist/index.js", "--version"], ["dist/health.js"]]) {
      await execute(process.execPath, [join(runtime.root, entry!), ...args], {
        cwd: runtime.root, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
        windowsHide: true, env: { ...process.env, CI: "1" },
      });
    }
  } catch { throw new Error(t("healthFailed")); }
}

async function fetchBytes(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(t("downloadFailed", { status: response.status }));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(t("downloadLimit"));
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

async function approvedRelease(): Promise<Release> {
  const raw = await fetchBytes(`${REGISTRY}/@usekibble%2fcli/auto`, 1024 * 1024);
  let release: Release;
  try { release = JSON.parse(raw.toString("utf8")); }
  catch { throw new Error(t("invalidRelease")); }
  if (!release || release.name !== PACKAGE || typeof release.version !== "string" ||
    !valid(release.version) || prerelease(release.version) ||
    typeof release.engines?.node !== "string" || typeof release.dist?.tarball !== "string" ||
    typeof release.dist.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(release.dist.integrity)) {
    throw new Error(t("invalidRelease"));
  }
  const tarball = new URL(release.dist.tarball);
  if (tarball.origin !== REGISTRY || tarball.username || tarball.password ||
    !tarball.pathname.startsWith("/@usekibble/cli/-/")) {
    throw new Error(t("invalidLocation"));
  }
  if (!satisfies(process.versions.node, release.engines.node)) {
    throw new Error(t("newerNode"));
  }
  return release;
}

// Narrow I/O seam for offline recovery fixtures. Production always uses npm and
// the public registry above; there is no remote command or configurable URL.
export interface UpdateIO {
  release(): Promise<Release>;
  install(release: Release, npmPath: string, directory: string): Promise<string>;
  check(runtime: Runtime): Promise<void>;
}
const productionIO: UpdateIO = {
  release: approvedRelease,
  async install(release, npmPath, directory) {
    const bytes = await fetchBytes(release.dist.tarball, 32 * 1024 * 1024);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (integrity !== release.dist.integrity) throw new Error(t("integrityFailed"));
    const tarball = join(directory, "release.tgz");
    writeFileSync(tarball, bytes, { mode: 0o600 });
    return installTarball(npmPath, tarball, directory);
  },
  check: checkRuntime,
};

function updateLock() {
  const lock = acquire(join(updateHome(), "update.lock"));
  if ("busy" in lock) throw new Error(t("busy"));
  return lock;
}

/** Prepare our already-installed release before moving the scheduler at all. */
export async function prepareManagedRuntime(root = runningPackageRoot()): Promise<void> {
  const state = readUpdateState();
  if (state.active) return;
  const npmPath = findNpm();
  const info = packageInfo(root);
  if (info.name !== PACKAGE || !valid(info.version) || !existsSync(join(root, "dist/health.js"))) {
    throw new Error(t("buildFirst"));
  }
  // The global install stays untouched. npm pack owns the published file list.
  const directory = mkdtempSync(join(updateHome(), "runtime-"));
  let activated = false;
  try {
    const packed = JSON.parse(await npm(npmPath, [
      "pack", "--ignore-scripts", "--json", "--pack-destination", directory,
    ], root)) as { filename: string }[];
    const filename = packed[0]?.filename;
    if (!filename || !/^[A-Za-z0-9_.-]+\.tgz$/.test(filename)) throw new Error(t("invalidFilename"));
    const installedRoot = await installTarball(npmPath, join(directory, filename), directory);
    const runtime = { root: installedRoot, version: info.version };
    await checkRuntime(runtime);
    atomicWrite(launcherPath(), readFileSync(join(root, "dist/index.js"), "utf8"));
    writeUpdateState({ ...state, active: runtime, npm: npmPath });
    activated = true;
  } finally {
    if (!activated) rmSync(directory, { recursive: true, force: true });
  }
}

export async function setupUpdates(enabled?: boolean, prepare = prepareManagedRuntime): Promise<void> {
  const lock = updateLock();
  try {
    const before = readUpdateState();
    const restore = preserveSchedule();
    await prepare();
    writeUpdateState({ ...readUpdateState(), enabled: enabled ?? before.enabled, npm: findNpm(), error: undefined });
    const config = loadConfig();
    if (config.linkToken && (restore || config.autoCollect) && !installed()) {
      try { await scheduleInstall(); }
      catch (error) {
        // Restore both the expected command and its registration. Otherwise the
        // next push would attempt to repair a half-finished migration itself.
        writeUpdateState(before);
        restore?.();
        throw error;
      }
    }
  } finally { lock.release(); }
}

export async function enableUpdates(): Promise<void> {
  await setupUpdates(true);
  console.log(t("enabled"));
}

export function disableUpdates(): void {
  const lock = updateLock();
  try { writeUpdateState({ ...readUpdateState(), enabled: false }); }
  finally { lock.release(); }
  console.log(t("disabled"));
}

export async function rollbackUpdate(): Promise<void> {
  const lock = updateLock();
  try {
    const state = readUpdateState();
    if (!state.previous) throw new Error(t("noPrevious"));
    await checkRuntime(state.previous);
    writeUpdateState({ ...state, active: state.previous, previous: state.active, enabled: false, error: undefined });
  } finally { lock.release(); }
  console.log(t("rolledBack"));
}

/** Immutable runtime directories let an already-running push finish unchanged. */
export async function checkForUpdate(manual = false, io: UpdateIO = productionIO): Promise<void> {
  const before = readUpdateState();
  if (!manual && (!before.enabled || process.env.CI || (before.nextCheckAt ?? 0) > Date.now())) return;
  const held = acquire(join(updateHome(), "update.lock"));
  if ("busy" in held) {
    if (manual) throw new Error(t("busy"));
    return;
  }
  let directory: string | undefined;
  let activated = false;
  try {
    let state = readUpdateState();
    if (!manual && (!state.enabled || (state.nextCheckAt ?? 0) > Date.now())) return;
    if (!state.active) throw new Error(t("prepareFirst"));
    state = { ...state, checkedAt: Date.now(), nextCheckAt: Date.now() + DAY + randomInt(0, 6 * 3_600_000), error: undefined };
    // Persist before networking, so outages do not cause hourly registry loops.
    writeUpdateState(state);
    state.npm = state.npm && existsSync(state.npm) ? state.npm : findNpm();
    const release = await io.release();
    if (!gt(release.version, state.active!.version)) return;
    directory = mkdtempSync(join(updateHome(), "runtime-"));
    const root = await io.install(release, state.npm!, directory);
    const candidate = { root, version: release.version };
    await io.check(candidate);
    writeUpdateState({ ...state, active: candidate, previous: state.active });
    activated = true;
  } catch (error) {
    // Only our bounded operational errors are persisted, never subprocess output.
    const detail = error instanceof Error ? error.message : t("updateFailed");
    writeUpdateState({ ...readUpdateState(), error: detail });
    if (manual) throw error;
    console.error(`${new Date().toISOString()}  ${t("deferred")}`);
  } finally {
    if (directory && !activated) rmSync(directory, { recursive: true, force: true });
    held.release();
  }
}

export function updateStatus(): void {
  const state = readUpdateState();
  console.log(`${t("status")}  ${t(state.enabled === undefined ? "unset" : state.enabled ? "on" : "off")}`);
  console.log(`${t("current")}  ${state.active?.version ?? packageInfo(runningPackageRoot()).version}`);
  console.log(`${t("previous")}  ${state.previous?.version ?? t("unknown")}`);
  console.log(`${t("checked")}  ${state.checkedAt ? new Date(state.checkedAt).toISOString() : t("unknown")}`);
  console.log(`${t("error")}  ${state.error ?? t("unknown")}`);
}

// Parse only leading global options here. Commander owns each command's flags.
// In particular, a server URL or label containing "update" is never a command.
export function launchCommand(args: string[]): string | undefined {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "--config-home" || arg.startsWith("--config-home=")) {
      const value = arg === "--config-home" ? args[++index] : arg.slice("--config-home=".length);
      if (!value || !isAbsolute(value)) throw new Error(t("absoluteConfig"));
      process.env.XDG_CONFIG_HOME = value;
      index++;
    } else {
      if (args.slice(index + 1).some((value) => value === "--config-home" || value.startsWith("--config-home="))) {
        throw new Error(t("leadingConfig"));
      }
      return arg;
    }
  }
  return undefined;
}

export async function launch(): Promise<void> {
  const args = process.argv.slice(2);
  const command = launchCommand(args);
  if (command === "update") {
    const tail = args.slice(args.indexOf("update") + 1);
    if (tail.length > 1) throw new Error(t("help"));
    switch (tail[0]) {
      case "enable": return enableUpdates();
      case "disable": return disableUpdates();
      case "status": return updateStatus();
      case "rollback": return rollbackUpdate();
      case "--help": case "-h": console.log(t("help")); return;
      case undefined: {
        await setupUpdates();
        await checkForUpdate(true);
        console.log(t("updated"));
        return;
      }
      default: throw new Error(t("help"));
    }
  }
  // Source checkouts and CI use exactly their installed code. An explicit pin
  // lets company-managed deployments do the same without changing local consent.
  const source = /\.tsx?$/.test(process.argv[1] ?? "");
  if ((source || process.env.CI || process.env.KIBBLE_NO_UPDATE === "1") && !isManagedEntry()) {
    await import(pathToFileURL(join(runningPackageRoot(), source ? "src/cli.ts" : "dist/cli.js")).href);
    return;
  }
  // The immutable bootstrap also keeps recovery commands available if a newer
  // updater breaks. Normal invocations load the active release's updater first,
  // so automatic updates can improve the updater itself as well as collection.
  const selected = readUpdateState().active;
  if (selected) {
    const entry = join(selected.root, "dist/index.js");
    if (realpathSync(process.argv[1]!) !== realpathSync(entry)) {
      process.argv[1] = entry;
      await import(pathToFileURL(entry).href);
      return;
    }
  }
  // Read-only commands, login, and dry runs neither install software nor wait
  // for the registry. Scheduled and manual pushes share this pre-collection step.
  const informational = args.some((arg) => ["--help", "-h", "--version", "-V"].includes(arg));
  if (command === "push" && !informational && !args.includes("--dry-run") && process.env.KIBBLE_NO_UPDATE !== "1") await checkForUpdate();
  const originalRoot = runningPackageRoot();
  const active = readUpdateState().active;
  const root = active?.root ?? originalRoot;
  const extension = /\.tsx?$/.test(process.argv[1] ?? "") && !active ? "ts" : "js";
  await import(pathToFileURL(resolve(root, extension === "ts" ? "src/cli.ts" : "dist/cli.js")).href);
}
