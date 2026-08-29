import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
   * The organization's policy, echoed by the server at link time and on every
   * push: while true this machine keeps `kibble push` scheduled in the
   * background and starting at boot, and `kibble schedule uninstall` refuses.
   * Owners and admins set it in the dashboard; nothing here can override it.
   */
  autoCollect?: boolean;
}

export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "kibble", "config.json");
}

export function loadConfig(): KibbleConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as KibbleConfig;
  } catch {
    return { server: "https://app.usekibble.com" };
  }
}

export function saveConfig(config: KibbleConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  // 0600: the link token is a credential.
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
