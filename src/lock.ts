import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath } from "./config.js";

/**
 * One push at a time on this machine.
 *
 * launchd will not start a job that is still running, but cron and Task
 * Scheduler will: a push that hangs, on a slow disk or a connection that never
 * answers, would otherwise be joined by a fresh one every hour until the box
 * runs out of something. The scan also reads the same files those copies are
 * reading, so overlapping runs are pure waste even when they finish.
 *
 * The lock is a file holding the pid that took it and when. A dead pid or an
 * age past `MAX_RUN_MS` means the holder died without releasing, and the lock
 * is taken from it: a stale file must never be able to stop a machine
 * reporting forever.
 */

/** Longer than any honest push, short enough that a crash heals within a day. */
const MAX_RUN_MS = 2 * 60 * 60 * 1000;

interface Held {
  pid: number;
  startedAt: number;
}

export function lockPath(): string {
  return join(dirname(configPath()), "push.lock");
}

/** Whether the process that took the lock is still there to finish the job. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 tests for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists and belongs to somebody else. Still running.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function held(path: string): Held | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Held>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number") return null;
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    // Missing, truncated, or garbage: nothing worth waiting for.
    return null;
  }
}

/**
 * Take the lock, or report who has it.
 *
 * Returns a release function on success. On failure returns the age in
 * milliseconds of the run that holds it, so the caller can say something
 * useful instead of just declining.
 */
export function acquire(): { release: () => void } | { busy: number } {
  const path = lockPath();
  mkdirSync(dirname(path), { recursive: true });
  const mine: Held = { pid: process.pid, startedAt: Date.now() };
  const body = JSON.stringify(mine);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // `wx` fails if the file exists, which is the whole mechanism.
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      return { release: () => rmSync(path, { force: true }) };
    } catch {
      const current = held(path);
      if (current && alive(current.pid) && Date.now() - current.startedAt < MAX_RUN_MS) {
        return { busy: Date.now() - current.startedAt };
      }
      // Nobody is coming back for it. Clear it and try once more; if another
      // process wins that race, the second attempt reports it as busy.
      rmSync(path, { force: true });
    }
  }
  return { busy: 0 };
}
