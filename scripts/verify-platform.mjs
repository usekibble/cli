// Real scheduler operations belong on a disposable GitHub runner. This script
// uses the production commands and always removes the fixture registration.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.env.GITHUB_ACTIONS, "true", "verify:platform requires a disposable GitHub Actions runner; it changes OS schedules");
const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "kibble-platform-"));
const configHome = join(root, "config with spaces");
const directory = join(configHome, "kibble");
mkdirSync(directory, { recursive: true });
const fixture = { server: "http://127.0.0.1:9", linkToken: "ci-fixture-not-real", deviceName: "ci-fixture", autoCollect: false };
writeFileSync(join(directory, "config.json"), JSON.stringify(fixture), { mode: 0o600 });
const env = { ...process.env, XDG_CONFIG_HOME: configHome, LC_ALL: "C", LANG: "C" };
delete env.KIBBLE_NO_UPDATE;

function command(file, args, options = {}) {
  return spawnSync(file, args, { env, encoding: "utf8", timeout: 240_000, maxBuffer: 4 * 1024 * 1024, ...options });
}
function success(file, args, options) {
  const result = command(file, args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  return result.stdout;
}
function kibble(...args) { return success(process.execPath, [cli, ...args]); }

let scheduleAttempted = false;
try {
  const expectedVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(kibble("--version").trim(), expectedVersion);
  assert.match(kibble("whoami"), /linked\s+yes/);
  assert.match(kibble("push", "--dry-run"), /No usage found|Dry run/);
  kibble("update", "enable");
  kibble("update", "disable");
  const state = JSON.parse(readFileSync(join(directory, "updates/state.json"), "utf8"));
  assert.equal(state.enabled, false);
  assert.equal(state.active.version, expectedVersion);
  const launcher = join(directory, "updates/launcher.mjs");
  assert.equal(success(process.execPath, [launcher, "--version"]).trim(), expectedVersion);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "config.json"), "utf8")), fixture,
    "managed installation must preserve credentials and collection policy");
  console.log(`OK  packaged installation and native parsers on ${process.platform} / ${process.version}`);

  scheduleAttempted = true;
  kibble("schedule", "install");
  assert.match(kibble("schedule", "status"), /scheduled\s+yes/);
  let registration;
  if (process.platform === "win32") {
    registration = success("schtasks", ["/Query", "/TN", "com.usekibble.push", "/XML"]);
    assert.match(registration, /PT1H/);
    const boot = success("schtasks", ["/Query", "/TN", "com.usekibble.push.boot", "/XML"]);
    assert.match(boot, /LogonTrigger/);
  } else if (process.platform === "darwin") {
    registration = success("launchctl", ["print", `gui/${process.getuid()}/com.usekibble.push`]);
  } else if (process.platform === "linux") {
    registration = success("crontab", ["-l"]);
    assert.match(registration, /@reboot/);
  } else { assert.fail(`unsupported platform: ${process.platform}`); }
  assert(registration.includes("launcher.mjs"), "the scheduler must use the stable launcher");
  assert(registration.includes("--config-home"), "the scheduler must pin the configuration home");
  assert(registration.includes(configHome), "the scheduler must preserve paths containing spaces");
  if (process.platform === "win32") {
    success("schtasks", ["/Run", "/TN", "com.usekibble.push"]);
    const log = join(directory, "push.log");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (!existsSync(log) || !readFileSync(log, "utf8").includes("No usage found"))) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.match(existsSync(log) ? readFileSync(log, "utf8") : "", /No usage found/,
      "Task Scheduler must execute the managed launcher and write its log");
  }
  console.log(`OK  real ${process.platform} scheduler registration`);
} finally {
  try {
    if (scheduleAttempted) {
      kibble("schedule", "uninstall", "--force");
      assert.match(kibble("schedule", "status"), /scheduled\s+no/);
      if (process.platform === "win32") {
        for (const name of ["com.usekibble.push", "com.usekibble.push.boot"]) {
          assert.notEqual(command("schtasks", ["/Query", "/TN", name]).status, 0, `${name} survived uninstall`);
        }
      } else if (process.platform === "darwin") {
        assert.notEqual(command("launchctl", ["print", `gui/${process.getuid()}/com.usekibble.push`]).status, 0);
      } else if (process.platform === "linux") {
        assert(!command("crontab", ["-l"]).stdout.includes("kibble"));
      }
      console.log(`OK  real ${process.platform} scheduler removal`);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
