// Broken activation could stop collection; an unwanted install executes code
// without consent. Exercise the production updater with local npm tarballs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { acquire } from "../dist/lock.js";
import { loadConfig, saveConfig } from "../dist/config.js";
import { askForUpdates, offerAutomaticUpdates } from "../dist/update-consent.js";
import { launcherPath, readUpdateState, updateHome, writeUpdateState } from "../dist/update-state.js";
import { checkForUpdate, findNpm, launchCommand, prepareManagedRuntime, rollbackUpdate } from "../dist/updates.js";

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), "kibble-update-check-"));
const originalHome = process.env.XDG_CONFIG_HOME;
const originalCI = process.env.CI;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
process.env.XDG_CONFIG_HOME = join(root, "config with spaces");
delete process.env.CI;
console.log = () => {};
console.error = () => {};
const npm = findNpm();
const launcher = fileURLToPath(new URL("../dist/index.js", import.meta.url));
let requests = 0;
let release;
let tarball;

async function fixture(version, healthy = true, workingLauncher = true) {
  const directory = join(root, `fixture-${version}`);
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "@usekibble/cli", version, type: "module", engines: { node: ">=20" },
    files: ["dist"],
    // Installing this package must never execute this script.
    scripts: { postinstall: "node -e \"process.exit(99)\"" },
  }));
  copyFileSync(launcher, join(directory, "dist/index.js"));
  if (!workingLauncher) writeFileSync(join(directory, "dist/index.js"), "this is not valid JavaScript;\n");
  writeFileSync(join(directory, "dist/health.js"), `process.exit(${healthy ? 0 : 1});\n`);
  writeFileSync(join(directory, "dist/cli.js"), `console.log("collector ${version}");\n`);
  const packed = await run(process.execPath, [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
    cwd: directory, timeout: 30_000,
  });
  const bytes = readFileSync(join(directory, JSON.parse(packed.stdout)[0].filename));
  return {
    directory, bytes,
    release: {
      name: "@usekibble/cli", version, engines: { node: ">=20" },
      dist: {
        tarball: `https://registry.npmjs.org/@usekibble/cli/-/cli-${version}.tgz`,
        integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      },
    },
  };
}

function publish(candidate) { release = structuredClone(candidate.release); tarball = candidate.bytes; }
globalThis.fetch = async (url) => {
  requests++;
  if (url === "https://registry.npmjs.org/@usekibble%2fcli/auto") return Response.json(release);
  assert.equal(url, release.dist.tarball, "the updater must download only the approved tarball");
  return new Response(tarball);
};

try {
  saveConfig({ server: "https://fixture.test", linkToken: "fixture-token", lastPushedThrough: "2026-09-05" });
  const savedConfig = loadConfig();

  // Readline must require an actual submitted answer, including for the default.
  for (const [inputText, expected] of [["\n", true], ["yes\n", true], ["n\n", false], ["", undefined], ["y", undefined], ["maybe\nn\n", false]]) {
    const input = new PassThrough();
    const answer = askForUpdates(input, new PassThrough());
    input.end(inputText);
    assert.equal(await answer, expected);
  }
  const terminalInput = new PassThrough();
  const terminalOutput = new PassThrough();
  terminalInput.isTTY = terminalOutput.isTTY = true;
  const interrupted = askForUpdates(terminalInput, terminalOutput);
  terminalInput.write("\u0003");
  assert.equal(await interrupted, undefined, "Ctrl-C cannot enable updates");
  terminalInput.end();
  terminalOutput.end();

  let asks = 0;
  let enables = 0;
  const interaction = {
    terminal: false,
    ask: async () => { asks++; return true; },
    enable: async () => { enables++; writeUpdateState({ enabled: true }); },
  };
  await offerAutomaticUpdates(undefined, interaction);
  assert.equal(asks, 0, "headless login must never prompt");
  assert.equal(readUpdateState().enabled, undefined);
  await offerAutomaticUpdates(true, interaction);
  assert.equal(enables, 1, "an explicit login flag authorizes headless setup");
  await offerAutomaticUpdates(undefined, { ...interaction, terminal: true });
  assert.equal(asks, 0, "a saved acceptance must not be asked again");
  writeUpdateState({});
  await offerAutomaticUpdates(undefined, { ...interaction, terminal: true, ask: async () => false });
  assert.equal(readUpdateState().enabled, false);
  await offerAutomaticUpdates(undefined, { ...interaction, terminal: true });
  assert.equal(asks, 0, "a saved refusal must not be asked again");
  writeUpdateState({});
  await offerAutomaticUpdates(undefined, { ...interaction, terminal: true, ask: async () => undefined });
  assert.equal(readUpdateState().enabled, undefined, "interruption cannot grant consent");
  await offerAutomaticUpdates(true, { ...interaction, enable: async () => { throw new Error("offline"); } });
  assert.deepEqual(loadConfig(), savedConfig, "setup failure must preserve successful login");

  assert.equal(launchCommand(["--config-home", process.env.XDG_CONFIG_HOME, "push", "--quiet"]), "push");
  await checkForUpdate();
  assert.equal(requests, 0, "no update request is permitted without consent");

  const initial = await fixture("0.4.0");
  const next = await fixture("0.5.0");
  const broken = await fixture("0.6.0", false);
  const brokenLauncher = await fixture("0.7.0", true, false);
  await prepareManagedRuntime(initial.directory);
  const baseline = readUpdateState().active;
  assert.equal(baseline.version, "0.4.0");
  assert(existsSync(launcherPath()), "setup must provide a standalone launcher");
  assert.notEqual(baseline.root, initial.directory, "the baseline must survive removal of the global package");
  writeUpdateState({ ...readUpdateState(), enabled: true });

  // Help must not download or activate executable code. Exercise the bundled
  // launcher with consent enabled and a due check, including managed dispatch.
  // The fixture collector only prints its version, so the real-push control
  // cannot read this machine's transcripts or upload anything.
  const trap = join(root, "trap-fetch.mjs");
  const requested = join(root, "update-requested");
  writeFileSync(trap, `import { writeFileSync } from "node:fs";
globalThis.fetch = async () => {
  writeFileSync(process.env.KIBBLE_UPDATE_TEST_REQUEST, "requested");
  throw new Error("fixture network unavailable");
};\n`);
  const launchEnv = { ...process.env, KIBBLE_UPDATE_TEST_REQUEST: requested };
  delete launchEnv.CI;
  delete launchEnv.KIBBLE_NO_UPDATE;
  const dueState = readUpdateState();
  const filesBeforeHelp = readdirSync(updateHome()).sort();
  for (const entry of [join(initial.directory, "dist/index.js"), launcherPath()]) {
    for (const args of [["push", "--help"], ["push", "-h"], ["--version"], ["-V"], ["push", "--version"], ["push", "-V"]]) {
      await run(process.execPath, ["--import", pathToFileURL(trap).href, entry, ...args], {
        env: launchEnv, timeout: 10_000,
      });
      assert.equal(existsSync(requested), false, `${args.join(" ")} must not contact the registry`);
      assert.deepEqual(readUpdateState(), dueState, `${args.join(" ")} must not change update state`);
      assert.deepEqual(readdirSync(updateHome()).sort(), filesBeforeHelp, "help must not stage an installation");
    }
  }
  await run(process.execPath, ["--import", pathToFileURL(trap).href, launcherPath(), "push"], {
    env: launchEnv, timeout: 10_000,
  });
  assert.equal(existsSync(requested), true, "an ordinary due push must still check for updates");
  assert(readUpdateState().nextCheckAt > Date.now(), "a failed update must defer the next attempt");
  writeUpdateState(dueState);
  publish(next);

  process.env.CI = "true";
  await checkForUpdate();
  assert.equal(requests, 0, "CI must remain pinned without an explicit update command");
  delete process.env.CI;
  const updateLock = acquire(join(updateHome(), "update.lock"));
  assert("release" in updateLock);
  await checkForUpdate();
  assert.equal(requests, 0, "overlapping updates must not start another install");
  updateLock.release();

  // The tarball is verified before npm or any package code can execute.
  release.dist.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
  await assert.rejects(checkForUpdate(true), /integrity/);
  assert.deepEqual(readUpdateState().active, baseline);
  const failedRequestCount = requests;
  await checkForUpdate();
  assert.equal(requests, failedRequestCount, "failed daily checks must back off");
  assert(readUpdateState().error);
  publish(next);
  release.engines.node = ">=999";
  await assert.rejects(checkForUpdate(true), /Node.js/);
  assert.deepEqual(readUpdateState().active, baseline);
  publish(next);
  release.dist.tarball = "https://other.example/cli.tgz";
  await assert.rejects(checkForUpdate(true), /download location/);
  publish(next);
  release.version = "0.5.0-beta.1";
  await assert.rejects(checkForUpdate(true), /metadata/);
  publish(broken);
  await assert.rejects(checkForUpdate(true), /native parser check/);
  publish(brokenLauncher);
  await assert.rejects(checkForUpdate(true), /startup/,
    "a healthy parser must not hide a broken CLI launcher");
  assert.deepEqual(readUpdateState().active, baseline);
  assert.equal(readdirSync(updateHome()).filter((name) => name.startsWith("runtime-")).length, 1,
    "failed candidates must be removed without touching the active runtime");

  // An interrupted install is represented by a thrown I/O failure after writes.
  await assert.rejects(checkForUpdate(true, {
    release: async () => next.release,
    install: async (_release, _npm, directory) => {
      writeFileSync(join(directory, "partial-install"), "partial");
      throw new Error("interrupted install");
    },
    check: async () => { assert.fail("partial installations cannot be probed or activated"); },
  }), /interrupted/);
  assert.deepEqual(readUpdateState().active, baseline);

  // Activating beside a running push does not modify its executable or lock.
  const pushLock = acquire();
  assert("release" in pushLock);
  const oldCode = readFileSync(join(baseline.root, "dist/cli.js"), "utf8");
  publish(next);
  await checkForUpdate(true);
  assert.equal(readUpdateState().active.version, "0.5.0");
  assert.deepEqual(readUpdateState().previous, baseline);
  assert.equal(readUpdateState().error, undefined);
  assert.equal(readFileSync(join(baseline.root, "dist/cli.js"), "utf8"), oldCode);
  assert("busy" in acquire(), "activation must not release another push's lock");
  pushLock.release();
  assert.deepEqual(loadConfig(), savedConfig);

  // Both the npm entry and the copied scheduler entry must launch the new code.
  for (const entry of [launcher, launcherPath()]) {
    const result = await run(process.execPath, [entry, "--config-home", process.env.XDG_CONFIG_HOME, "--version"], {
      env: { ...process.env, XDG_CONFIG_HOME: join(root, "wrong config") }, timeout: 10_000,
    });
    assert.equal(result.stdout.trim(), "collector 0.5.0");
  }
  for (const pin of [{ CI: "1" }, { KIBBLE_NO_UPDATE: "1" }]) {
    const result = await run(process.execPath, [join(initial.directory, "dist/index.js"), "--version"], {
      env: { ...process.env, ...pin }, timeout: 10_000,
    });
    assert.equal(result.stdout.trim(), "collector 0.4.0", "pinned invocations must use their installed version");
  }
  await rollbackUpdate();
  assert.deepEqual(readUpdateState().active, baseline);
  assert.equal(readUpdateState().enabled, false, "rollback pins the working version");
  assert.deepEqual(loadConfig(), savedConfig, "rollback must preserve credentials and recovery state");
  const restored = await run(process.execPath, [launcherPath(), "--version"], { env: process.env, timeout: 10_000 });
  assert.equal(restored.stdout.trim(), "collector 0.4.0");
} finally {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  if (originalHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalHome;
  if (originalCI === undefined) delete process.env.CI;
  else process.env.CI = originalCI;
  rmSync(root, { recursive: true, force: true });
}
console.log("OK  CLI updates require consent, stage verified packages, preserve collection and roll back safely");
