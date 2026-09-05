import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(os.tmpdir(), "kibble-schedule-"));
const configHome = join(root, "custom config");
const originalArgv = process.argv;
const originalPlatform = process.platform;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalHomedir = os.homedir;
const originalSpawnSync = childProcess.spawnSync;
const originalExecFileSync = childProcess.execFileSync;
const originalFsyncSync = fs.fsyncSync;
let crontab = "";
let crontabWrites = 0;
let launchdRegistered = false;
let bootstrapAttempts = 0;
let bootstrapFailures = 0;
let taskCreates = 0;
const tasks = new Map();

function xml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function taskXml(task) {
  const args = task.command.replace(/^cmd\s+/i, "");
  const trigger =
    task.schedule === "HOURLY"
      ? "<CalendarTrigger><Repetition><Interval>PT1H</Interval></Repetition></CalendarTrigger>"
      : "<LogonTrigger><Enabled>true</Enabled></LogonTrigger>";
  return `<Task><Triggers>${trigger}</Triggers><Actions><Exec><Command>cmd.exe</Command><Arguments>${xml(args)}</Arguments></Exec></Actions></Task>`;
}

function resetScheduler() {
  crontab = "";
  crontabWrites = 0;
  launchdRegistered = false;
  bootstrapAttempts = 0;
  bootstrapFailures = 0;
  taskCreates = 0;
  tasks.clear();
  rmSync(join(root, "Library"), { recursive: true, force: true });
}

function registrationCount(platform) {
  if (platform === "darwin") return bootstrapAttempts;
  if (platform === "linux") return crontabWrites;
  return taskCreates;
}

function registrationText(platform) {
  if (platform === "darwin") {
    return readFileSync(
      join(root, "Library", "LaunchAgents", "com.usekibble.push.plist"),
      "utf8",
    );
  }
  if (platform === "linux") return crontab;
  return [...tasks.values()].map((task) => task.command).join("\n");
}

function makeRegistrationStale(platform) {
  if (platform === "darwin") {
    const path = join(root, "Library", "LaunchAgents", "com.usekibble.push.plist");
    writeFileSync(path, readFileSync(path, "utf8").replace("--config-home", "--old-config-home"));
    return;
  }
  if (platform === "linux") {
    crontab = crontab.replace(/'--config-home' '[^']+' /g, "");
    return;
  }
  for (const task of tasks.values()) {
    task.command = task.command.replace(/ "--config-home" "[^"]+"/, "");
  }
}

process.env.XDG_CONFIG_HOME = configHome;
const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
process.argv = [process.execPath, cli];
os.homedir = () => root;
// Simulated POSIX schedulers still use the host filesystem. Windows cannot
// fsync directories; preserve real file syncing while emulating that operation.
if (originalPlatform === "win32") {
  fs.fsyncSync = (fd) => {
    if (!fs.fstatSync(fd).isDirectory()) originalFsyncSync(fd);
  };
}
childProcess.spawnSync = (command, args = []) => {
  if (command === "launchctl") {
    if (args[0] === "print") {
      return { status: launchdRegistered ? 0 : 113, stdout: "", stderr: "" };
    }
    if (args[0] === "bootout") {
      if (args[1]?.endsWith("/com.usekibble.push")) launchdRegistered = false;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "bootstrap") {
      bootstrapAttempts += 1;
      if (bootstrapFailures > 0) {
        bootstrapFailures -= 1;
        return { status: 5, stdout: "", stderr: "injected bootstrap failure" };
      }
      launchdRegistered = true;
      return { status: 0, stdout: "", stderr: "" };
    }
  }
  if (command === "crontab") {
    return { status: 0, stdout: crontab, stderr: "" };
  }
  if (command === "schtasks") {
    const name = args[args.indexOf("/TN") + 1];
    if (args[0] === "/Delete") {
      const removed = tasks.delete(name);
      return { status: removed ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args[0] === "/Create") {
      taskCreates += 1;
      const document = readFileSync(args[args.indexOf("/XML") + 1], "utf8");
      const argumentsText = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(document)[1]
        .replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
      tasks.set(name, {
        schedule: document.includes("<LogonTrigger>") ? "ONLOGON" : "HOURLY",
        command: `cmd ${argumentsText}`,
      });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "/Query") {
      const task = tasks.get(name);
      return task
        ? { status: 0, stdout: args.includes("/XML") ? taskXml(task) : "", stderr: "" }
        : { status: 1, stdout: "", stderr: "not found" };
    }
  }
  return { status: 0, stdout: "", stderr: "" };
};
childProcess.execFileSync = (command, args, options) => {
  assert.equal(command, "crontab");
  assert.deepEqual(args, ["-"]);
  crontab = options.input;
  crontabWrites += 1;
};
syncBuiltinESMExports();

try {
  const { saveConfig } = await import("../dist/config.js");
  const { atomicWrite, launcherPath, readUpdateState, writeUpdateState } = await import("../dist/update-state.js");
  const { setupUpdates } = await import("../dist/updates.js");
  const { enforcePolicy, installed, scheduleInstall } = await import("../dist/commands/schedule.js");
  const config = {
    server: "https://fixture.example",
    linkToken: "synthetic",
    autoCollect: false,
  };
  saveConfig(config);

  const originalLog = console.log;
  console.log = () => {};
  try {
    for (const platform of ["darwin", "linux", "win32"]) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      resetScheduler();
      await scheduleInstall();

      const registration = registrationText(platform);

      assert.match(registration, /--config-home/, `${platform} must pin the config home`);
      assert.ok(
        registration.includes(configHome),
        `${platform} must preserve a custom config home containing spaces`,
      );
      assert.ok(
        registration.includes("push") && registration.includes("--quiet"),
        `${platform} must keep the scheduled push arguments`,
      );
      assert.equal(installed(), true, `${platform} must recognize a healthy registration`);

      const healthyCount = registrationCount(platform);
      const healthyMessages = [];
      enforcePolicy(config, true, (line) => healthyMessages.push(line));
      assert.equal(
        registrationCount(platform),
        healthyCount,
        `${platform} must leave a healthy registration alone`,
      );
      assert.deepEqual(healthyMessages, []);

      makeRegistrationStale(platform);
      assert.equal(installed(), false, `${platform} must reject an old command without the config pin`);
      const migrationMessages = [];
      enforcePolicy(config, true, (line) => migrationMessages.push(line));
      assert.equal(installed(), true, `${platform} must repair an old registration`);
      assert.ok(
        registrationCount(platform) > healthyCount,
        `${platform} must re-register the current command`,
      );
      assert.equal(migrationMessages.length, 1);
      assert.match(registrationText(platform), /--config-home/);
    }

    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    resetScheduler();
    bootstrapFailures = 1;
    const failedMessages = [];
    enforcePolicy(config, true, (line) => failedMessages.push(line));
    const plist = join(root, "Library", "LaunchAgents", "com.usekibble.push.plist");
    assert.equal(bootstrapAttempts, 1);
    assert.equal(launchdRegistered, false);
    assert.equal(existsSync(plist), false, "failed bootstrap must remove its newly written plist");
    assert.equal(installed(), false, "a failed bootstrap must not count as installed");
    assert.equal(failedMessages.length, 1);
    assert.match(failedMessages[0], /injected bootstrap failure/);

    const retryMessages = [];
    enforcePolicy(config, true, (line) => retryMessages.push(line));
    assert.equal(bootstrapAttempts, 2, "the next policy check must retry bootstrap");
    assert.equal(installed(), true, "the retry must leave a healthy LaunchAgent");
    assert.equal(retryMessages.length, 1);

    const builtEntry = process.argv[1];
    process.argv = [process.execPath, fileURLToPath(new URL("../src/index.ts", import.meta.url))];
    assert.equal(installed(), false, "checking a source invocation must not throw");
    const sourceMessages = [];
    enforcePolicy(config, true, (line) => sourceMessages.push(line));
    assert.equal(sourceMessages.length, 1);
    assert.match(sourceMessages[0], /scheduling failed: refusing to schedule the TypeScript source/);
    process.argv = [process.execPath, builtEntry];

    // Opting in moves each scheduler to the stable launcher, retaining the
    // same config home and push arguments even when updates are later disabled.
    atomicWrite(launcherPath(), "// fixture launcher\n");
    writeUpdateState({ enabled: false, active: { root: join(root, "runtime"), version: "0.4.0" } });
    for (const platform of ["darwin", "linux", "win32"]) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      resetScheduler();
      await scheduleInstall();
      assert(registrationText(platform).includes(launcherPath()), `${platform} must run the managed launcher`);
      assert.equal(installed(), true);
    }
    writeUpdateState({});

    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    resetScheduler();
    await scheduleInstall();
    const oldRegistration = registrationText("darwin");
    bootstrapFailures = 1;
    await assert.rejects(setupUpdates(true, async () => {
      writeUpdateState({ active: { root: join(root, "candidate"), version: "0.4.0" } });
    }), /injected bootstrap failure/);
    assert.equal(readUpdateState().active, undefined, "failed migration must restore the original runtime selection");
    assert.equal(installed(), true, "failed migration must restore the previous scheduled command");
    assert.equal(registrationText("darwin"), oldRegistration);
  } finally {
    console.log = originalLog;
  }

  childProcess.spawnSync = originalSpawnSync;
  childProcess.execFileSync = originalExecFileSync;
  fs.fsyncSync = originalFsyncSync;
  syncBuiltinESMExports();

  const env = { ...process.env };
  delete env.XDG_CONFIG_HOME;
  const result = originalSpawnSync(
    process.execPath,
    [cli, "--config-home", configHome, "whoami"],
    { encoding: "utf8", env },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(join(configHome, "kibble", "config.json")));
  assert.match(result.stdout, /linked\s+yes/);

  const help = originalSpawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /config-home/);
  console.log("OK  schedules preserve config, repair stale jobs, and retry failed launchd bootstrap");
} finally {
  process.argv = originalArgv;
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  os.homedir = originalHomedir;
  childProcess.spawnSync = originalSpawnSync;
  childProcess.execFileSync = originalExecFileSync;
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
}
