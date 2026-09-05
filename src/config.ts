import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface KibbleConfig {
  /** Kibble server base URL. */
  server: string;
  /**
   * Per-device token minted by `kibble login`, after the device grant proves
   * who you are. Identity is the token: it names this machine's link to one
   * member, and `kibble logout` revokes exactly this one.
   */
  linkToken?: string;
  /** What the server calls this machine. Shown on the member's own page only. */
  deviceName?: string;
  /** Echoed back by the server at link time, for `kibble whoami`. */
  email?: string;
  organizationName?: string;
  /** Null while nobody has assigned this person to a team yet. */
  teamName?: string | null;
  /**
   * The organization's capability-reporting policy (skill, command and MCP
   * server names, never contents), echoed by the server at link time and on
   * every push. Owners set it in Settings; nothing here overrides it. Unknown
   * until the first link, and treated as on until then, which is the default.
   */
  capabilities?: boolean;
  /**
   * The last UTC day a push landed for, so a machine that was offline reports
   * what it missed instead of the fixed yesterday..today window. Advanced only
   * after the server has accepted the rows, and never moved backwards.
   */
  lastPushedThrough?: string;
  /**
   * Fingerprint of the installed-but-never-fired capability rows, and when they
   * were last sent. Those rows are most of the payload and change only when
   * somebody installs or removes a skill, so an unchanged set is sent a few
   * times a day rather than every hour. See `push.ts`.
   */
  capabilityDigest?: string;
  capabilityDigestAt?: string;
  /**
   * The organization's policy, echoed by the server at link time and on every
   * push: while true this machine keeps `kibble push` scheduled in the
   * background and starting at boot, and `kibble schedule uninstall` refuses.
   * Owners and admins set it in the dashboard; nothing here can override it.
   */
  autoCollect?: boolean;
}

const DEFAULT_CONFIG: KibbleConfig = { server: "https://app.usekibble.com" };

export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "kibble", "config.json");
}

function invalid(path: string, detail: string): Error {
  return new Error(`Invalid Kibble config at ${path}: ${detail}.`);
}

function validateConfig(value: unknown, path: string): KibbleConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(path, "expected a JSON object");
  }
  const config = value as Record<string, unknown>;
  if (typeof config.server !== "string") {
    throw invalid(path, 'field "server" must be a string');
  }
  try {
    const server = new URL(config.server);
    if (server.protocol !== "http:" && server.protocol !== "https:") throw new Error();
  } catch {
    throw invalid(path, 'field "server" must be an HTTP or HTTPS URL');
  }

  for (const field of [
    "linkToken",
    "deviceName",
    "email",
    "organizationName",
    "lastPushedThrough",
    "capabilityDigest",
    "capabilityDigestAt",
  ]) {
    if (config[field] !== undefined && typeof config[field] !== "string") {
      throw invalid(path, `field "${field}" must be a string`);
    }
  }
  if (
    config.teamName !== undefined &&
    config.teamName !== null &&
    typeof config.teamName !== "string"
  ) {
    throw invalid(path, 'field "teamName" must be a string or null');
  }
  for (const field of ["capabilities", "autoCollect"]) {
    if (config[field] !== undefined && typeof config[field] !== "boolean") {
      throw invalid(path, `field "${field}" must be a boolean`);
    }
  }

  return value as KibbleConfig;
}

export function loadConfig(): KibbleConfig {
  const path = configPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw new Error(`Could not read Kibble config at ${path} (${code ?? "read failed"}).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSON parser messages can echo file content, including the link token.
    throw new Error(`Kibble config at ${path} is not valid JSON.`);
  }
  return validateConfig(parsed, path);
}

function flushFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function flushDirectory(path: string): void {
  // Windows does not expose directory handles through fs.open. The atomic
  // rename is still used there; POSIX also flushes the containing directory.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function saveConfig(config: KibbleConfig): void {
  const path = configPath();
  validateConfig(config, path);
  const body = JSON.stringify(config, null, 2) + "\n";
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.config.${process.pid}.${randomUUID()}.tmp`);

  let published = false;
  try {
    // The credential is private before it becomes visible at the live path.
    writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
    flushFile(temporary);
    renameSync(temporary, path);
    published = true;
    flushDirectory(directory);
  } finally {
    if (!published) {
      try {
        unlinkSync(temporary);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }
}
