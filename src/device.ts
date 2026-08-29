import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath } from "./config.js";

/**
 * The collector's install id: a random UUID minted the first time it is
 * needed and kept in its own file, next to (not inside) config.json.
 *
 * It exists so that logging in twice on one laptop yields one device on the
 * dashboard, not two. It is deliberately NOT a fingerprint: nothing here reads
 * a serial number, a MAC address, a hostname or a machine id. It is a number
 * this machine picked at random, and deleting the file makes this machine a
 * new device as far as Kibble can tell. `kibble logout` leaves it alone so
 * that logging back in reclaims the same row and its history.
 */
export function devicePath(): string {
  return join(dirname(configPath()), "device.json");
}

export function installId(): string {
  const path = devicePath();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { installId?: unknown };
    if (typeof parsed.installId === "string" && parsed.installId.length > 0) {
      return parsed.installId;
    }
  } catch {
    // Missing or unreadable: mint one below.
  }
  const id = randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ installId: id }, null, 2) + "\n", { mode: 0o600 });
  return id;
}
