import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { configPath } from "./config.js";
import { updateText } from "./update-messages.js";

/**
 * One push at a time on this machine.
 *
 * A complete, nonempty lock directory is prepared under a private random name
 * and then renamed atomically to the public path. Its token is also part of the
 * owner filename. Release and stale recovery can therefore remove only their
 * exact owner's marker, and a delayed operation cannot remove a replacement.
 *
 * We only reclaim a lock whose process is dead. Age alone cannot prove that a
 * process has stopped using the protected resource, so an old but live push
 * stays the owner. An incomplete file from the legacy publisher gets a short
 * grace period before removal.
 */

const OWNER_PREFIX = "owner-";
const OWNER_SUFFIX = ".json";
const PUBLICATION_GRACE_MS = 30_000;
const MAX_ATTEMPTS = 8;

interface Held {
  pid: number;
  startedAt: number;
  token?: string;
}

interface Observation {
  held: Held | null;
  age: number;
  directory: boolean;
  marker?: string;
  raw?: string;
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

function markerName(token: string): string {
  return `${OWNER_PREFIX}${token}${OWNER_SUFFIX}`;
}

function parseHeld(raw: string, marker?: string): Held | null {
  try {
    const parsed = JSON.parse(raw) as Partial<Held>;
    if (!Number.isInteger(parsed.pid) || !Number.isFinite(parsed.startedAt)) return null;
    if (parsed.token !== undefined && typeof parsed.token !== "string") return null;
    if (marker && (!parsed.token || markerName(parsed.token) !== marker)) return null;
    return { pid: parsed.pid!, startedAt: parsed.startedAt!, token: parsed.token };
  } catch {
    return null;
  }
}

function observe(path: string): Observation | null {
  try {
    const stat = lstatSync(path);
    const directory = stat.isDirectory();
    let marker: string | undefined;
    let raw: string | undefined;

    if (directory) {
      const markers = readdirSync(path).filter(
        (name) => name.startsWith(OWNER_PREFIX) && name.endsWith(OWNER_SUFFIX),
      );
      if (markers.length === 1) {
        const found = markers[0]!;
        marker = found;
        try {
          raw = readFileSync(join(path, found), "utf8");
        } catch {
          // The exact marker may have been removed by another reclaimer.
        }
      }
    } else {
      // Kibble versions before the directory lock published this regular file.
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        // The legacy file may have been removed by another reclaimer.
      }
    }

    const held = raw === undefined ? null : parseHeld(raw, marker);
    const age = held
      ? Math.max(0, Date.now() - held.startedAt)
      : Math.max(0, Date.now() - stat.mtimeMs);
    return { held, age, directory, marker, raw };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Remove exactly the stale state that was observed.
 *
 * Only the contender that unlinks the observed token-named marker may remove
 * the directory. A second contender retains the old marker name, so after a
 * replacement arrives its unlink gets ENOENT instead of touching the new owner.
 */
function reclaim(path: string, stale: Observation): boolean {
  try {
    if (stale.directory) {
      if (stale.marker) {
        unlinkSync(join(path, stale.marker));
      } else {
        // Only empty abandoned publication state can be removed without an
        // owner marker. rmdir refuses both an active lock and unknown content.
        rmdirSync(path);
        return true;
      }
      rmdirSync(path);
      return true;
    }

    // A new owner is a directory, which unlink cannot remove. The raw check
    // also avoids deleting a different legacy owner's file during an upgrade.
    if (stale.raw !== undefined && readFileSync(path, "utf8") !== stale.raw) return false;
    unlinkSync(path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "ENOENT" ||
      code === "ENOTEMPTY" ||
      code === "EEXIST" ||
      code === "EISDIR" ||
      code === "EPERM"
    ) {
      return false;
    }
    throw err;
  }
}

function removePrepared(path: string, marker: string): void {
  try {
    unlinkSync(join(path, marker));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    rmdirSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function publish(prepared: string, path: string): void {
  if (process.platform !== "win32") {
    renameSync(prepared, path);
    return;
  }
  // Windows rename can replace an existing regular file with a directory. That
  // would overwrite a legacy collector's live lock. Directory.Move uses a move
  // without replacement, atomically refusing every existing destination.
  // The script is constant; paths are environment data, never PowerShell code.
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const moved = spawnSync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference = 'Stop'; [System.IO.Directory]::Move($env:KIBBLE_LOCK_FROM, $env:KIBBLE_LOCK_TO)",
  ], {
    env: { ...process.env, KIBBLE_LOCK_FROM: prepared, KIBBLE_LOCK_TO: path },
    stdio: "ignore", windowsHide: true, timeout: 30_000,
  });
  if (moved.status !== 0) throw new Error(updateText("lockPublicationFailed"));
}

/**
 * Take the lock, or report who has it.
 *
 * Returns a release function on success. On failure returns the age in
 * milliseconds of the run that holds it, so the caller can say something
 * useful instead of just declining.
 */
export function acquire(path = lockPath()): { release: () => void } | { busy: number } {
  mkdirSync(dirname(path), { recursive: true });

  const mine: Required<Held> = {
    pid: process.pid,
    startedAt: Date.now(),
    token: randomUUID(),
  };
  const marker = markerName(mine.token);
  const prepared = `${path}.${mine.token}.pending`;
  mkdirSync(prepared, { mode: 0o700 });

  try {
    writeFileSync(join(prepared, marker), JSON.stringify(mine), { flag: "wx", mode: 0o600 });
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        // The source is already complete and nonempty. Existing nonempty lock
        // directories refuse replacement on every supported platform.
        publish(prepared, path);
      } catch (err) {
        const current = observe(path);
        if (!current) throw err;
        if (current.held && alive(current.held.pid)) return { busy: current.age };
        if (!current.held && current.age < PUBLICATION_GRACE_MS) {
          return { busy: current.age };
        }
        reclaim(path, current);
        continue;
      }

      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try {
            // The unique marker is the ownership check and the mutation. There
            // is no read-then-unlink window against another owner's filename.
            unlinkSync(join(path, marker));
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
            throw err;
          }
          try {
            rmdirSync(path);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
          }
        },
      };
    }

    return { busy: observe(path)?.age ?? 0 };
  } finally {
    removePrepared(prepared, marker);
  }
}
