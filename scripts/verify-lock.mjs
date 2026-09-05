import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquire, lockPath } from "../dist/lock.js";

const root = mkdtempSync(join(tmpdir(), "kibble-lock-check-"));
const originalConfigHome = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = root;
const lockModule = new URL("../dist/lock.js", import.meta.url).href;
const children = [];

function ownerPath() {
  const markers = readdirSync(lockPath()).filter(
    (name) => name.startsWith("owner-") && name.endsWith(".json"),
  );
  assert.equal(markers.length, 1);
  return join(lockPath(), markers[0]);
}

function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  assert.equal(typeof child.pid, "number");
  return child.pid;
}

function writeOwner(pid, startedAt, token) {
  mkdirSync(lockPath(), { recursive: true });
  writeFileSync(join(lockPath(), `owner-${token}.json`), JSON.stringify({ pid, startedAt, token }));
}

const childSource = `
  const { existsSync, writeFileSync } = await import("node:fs");
  const { acquire } = await import(process.env.KIBBLE_LOCK_MODULE);
  if (process.env.KIBBLE_LOCK_OBSERVED) {
    const kill = process.kill;
    process.kill = (pid, signal) => {
      if (pid !== Number(process.env.KIBBLE_STALE_PID)) return kill(pid, signal);
      writeFileSync(process.env.KIBBLE_LOCK_OBSERVED, "");
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(process.env.KIBBLE_LOCK_RECLAIM)) Atomics.wait(wait, 0, 0, 10);
      const err = new Error("fixture owner is dead");
      err.code = "ESRCH";
      throw err;
    };
  }
  process.send({ ready: true });
  process.on("message", (message) => {
    if (message === "go") {
      const lock = acquire();
      process.send({ acquired: "release" in lock, busy: "busy" in lock ? lock.busy : undefined });
      if ("release" in lock) {
        process.on("message", (next) => {
          if (next === "release") { lock.release(); process.exit(0); }
        });
      } else process.exit(0);
    }
  });
`;

function contender(index, stalePid) {
  return spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: root,
      KIBBLE_LOCK_MODULE: lockModule,
      KIBBLE_LOCK_OBSERVED: join(root, `observed-${index}`),
      KIBBLE_LOCK_RECLAIM: join(root, "reclaim-now"),
      KIBBLE_STALE_PID: String(stalePid),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

function message(child, predicate) {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => reject(new Error("lock contender timed out")), 5_000);
    const onMessage = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("message", onMessage);
      resolveMessage(value);
    };
    const onError = (err) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      reject(err);
    };
    child.on("message", onMessage);
    child.on("error", onError);
  });
}

function exited(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveExit() : reject(new Error(`child exited ${code}`)));
  });
}

function waitForFiles(paths) {
  return new Promise((resolveWait, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      if (paths.every(existsSync)) return resolveWait();
      if (Date.now() >= deadline) return reject(new Error("lock observations timed out"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

try {
  const live = acquire();
  assert("release" in live);
  const blocked = acquire();
  assert("busy" in blocked, "a live owner must exclude another push");

  const liveOwner = JSON.parse(readFileSync(ownerPath(), "utf8"));
  writeFileSync(ownerPath(), JSON.stringify({ ...liveOwner, startedAt: Date.now() - 3 * 60 * 60 * 1000 }));
  assert("busy" in acquire(), "age alone must not evict a live process");
  live.release();
  assert.equal(existsSync(lockPath()), false);

  const old = acquire();
  assert("release" in old);
  const oldOwner = JSON.parse(readFileSync(ownerPath(), "utf8"));
  writeFileSync(ownerPath(), JSON.stringify({ ...oldOwner, pid: deadPid() }));
  const replacement = acquire();
  assert("release" in replacement, "a dead owner must be reclaimed");
  old.release();
  assert.equal(existsSync(lockPath()), true, "an old release must preserve its replacement");
  assert("busy" in acquire(), "the replacement must still exclude another push");
  replacement.release();

  writeFileSync(lockPath(), "");
  assert("busy" in acquire(), "a freshly visible legacy file must be treated as publication in progress");
  const past = new Date(Date.now() - 60_000);
  utimesSync(lockPath(), past, past);
  const recoveredPublication = acquire();
  assert("release" in recoveredPublication, "an abandoned unpublished legacy file must heal");
  recoveredPublication.release();

  writeFileSync(lockPath(), JSON.stringify({ pid: deadPid(), startedAt: Date.now() - 60_000 }));
  const upgraded = acquire();
  assert("release" in upgraded, "a dead legacy file lock must be reclaimed during upgrade");
  upgraded.release();

  const stalePid = deadPid();
  writeOwner(stalePid, Date.now() - 60_000, "stale-owner");
  children.push(contender(0, stalePid), contender(1, stalePid));
  const exits = children.map(exited);
  await Promise.all(children.map((child) => message(child, (value) => value?.ready)));
  const outcomes = children.map((child) => message(child, (value) => "acquired" in (value ?? {})));
  children.forEach((child) => child.send("go"));
  await waitForFiles([join(root, "observed-0"), join(root, "observed-1")]);
  writeFileSync(join(root, "reclaim-now"), "");
  const results = await Promise.all(outcomes);
  assert.equal(results.filter((result) => result.acquired).length, 1, "exactly one stale reclaimer must win");
  assert.equal(results.filter((result) => !result.acquired).length, 1);
  const winner = children[results.findIndex((result) => result.acquired)];
  winner.send("release");
  await Promise.all(exits);
  assert.equal(existsSync(lockPath()), false);
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  rmSync(root, { recursive: true, force: true });
}

console.log("OK  push lock publication, ownership, stale recovery and contention");
