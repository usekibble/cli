import { spawn } from "node:child_process";
import { loadConfig, saveConfig } from "../config.js";
import { installId } from "../device.js";
import { enforcePolicy, installed, removeSchedule } from "./schedule.js";

/**
 * `kibble login` -- OAuth 2.0 device authorization grant (RFC 8628).
 *
 * Why not a loopback redirect, the usual CLI dance? Because this collector also
 * runs over SSH and inside CI containers, where the browser that can complete a
 * Google sign-in is on a different machine from the one holding the code. The
 * device grant is the flow designed for exactly that gap: this process only
 * ever holds an opaque code and polls; the human approves in whatever browser
 * they happen to have.
 *
 * Nothing here reads a log file, and nothing here sees a password. The command
 * ends with one credential on disk: a link token that can push counts for one
 * member, and do nothing else.
 */

/** Public, constant. The device grant's client_id is not a secret (RFC 8628 s5.6). */
const CLIENT_ID = "kibble-cli";
/**
 * Nothing here waits on the network forever. A connection that is accepted and
 * then never answered would otherwise hang `kibble login` with no way out but
 * Ctrl-C, and hang the scheduled push into the next hour (see push.ts).
 */
const REQUEST_TIMEOUT_MS = 30_000;
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

interface LinkResponse {
  linkToken: string;
  deviceName: string;
  /** This machine was already linked; its token was rotated, not duplicated. */
  renewed: boolean;
  email: string;
  organizationName: string;
  /** Null until someone assigns them to a team in the dashboard. */
  teamName: string | null;
  /** Org policy: keep the background push scheduled on this machine. */
  autoCollect: boolean;
  /** Org policy: report skill, command and MCP server names. Absent on older servers. */
  collectCapabilities?: boolean;
}

interface OAuthError {
  error?: string;
  error_description?: string;
  detail?: string;
  message?: string;
}

export interface LoginOptions {
  server?: string;
  /** A label for this machine, e.g. "work laptop". Optional; nothing is inferred. */
  device?: string;
  /**
   * Commander turns `--no-browser` into `browser: false`; it defaults to true.
   * Set false to print the URL and launch nothing.
   */
  browser?: boolean;
}

export async function login(opts: LoginOptions): Promise<void> {
  const config = loadConfig();
  const server = opts.server ?? config.server;

  const grant = await requestDeviceCode(server);

  console.log("");
  console.log(`  Open   ${grant.verification_uri}`);
  console.log(`  Code   ${formatUserCode(grant.user_code)}`);
  console.log("");
  console.log("  Approve the request there, then come back. Ctrl-C to cancel.");
  console.log("");

  if (opts.browser !== false && !isHeadless()) {
    openBrowser(grant.verification_uri_complete ?? grant.verification_uri);
  }

  const token = await pollForToken(server, grant);
  const linked = await exchangeForLinkToken(
    server,
    token.access_token,
    opts.device,
    config.linkToken,
  );

  const next = {
    ...config,
    server,
    linkToken: linked.linkToken,
    deviceName: linked.deviceName,
    email: linked.email,
    organizationName: linked.organizationName,
    teamName: linked.teamName,
    autoCollect: linked.autoCollect,
    capabilities: linked.collectCapabilities ?? config.capabilities ?? true,
  };
  saveConfig(next);

  console.log(
    `${linked.renewed ? "Re-linked" : "Linked"} ${linked.email} to ${linked.organizationName}` +
      `${linked.teamName ? ` / ${linked.teamName}` : " (no team yet)"}` +
      ` as "${linked.deviceName}".`,
  );

  // The organization's call, made once in Settings: with automatic collection
  // on, the schedule goes in here and nobody has to remember a second command.
  if (linked.autoCollect) {
    const already = installed();
    enforcePolicy(next, true, console.log);
    if (already) console.log("Automatic collection is required by your organization and already scheduled.");
    console.log("Run `kibble push` to send today's usage now; `kibble schedule status` shows the background job.");
  } else {
    console.log("Run `kibble push` to send today's usage, or `kibble schedule install` to push every hour.");
  }
}

/**
 * Forget the token here and revoke it there. Revocation is best-effort: if
 * the server is unreachable the local credential is still gone, and the
 * device can be unlinked from My usage in the dashboard.
 */
export async function logout(): Promise<void> {
  const config = loadConfig();
  saveConfig({
    server: config.server,
    capabilities: config.capabilities,
  });
  console.log("Forgot the link token on this machine.");
  // A scheduled push with no token would only fail every hour. The policy
  // ended with the membership, so this ignores it.
  if (removeSchedule()) console.log("Removed the background push.");

  if (!config.linkToken) return;
  try {
    const res = await fetch(new URL("/api/cli/link", config.server), {
      method: "DELETE",
      headers: { authorization: `Bearer ${config.linkToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      console.log(`Revoked "${config.deviceName ?? "this device"}" on the server.`);
      return;
    }
  } catch {
    // fall through
  }
  console.log(
    "Could not reach the server to revoke it -- unlink this device from My usage in the dashboard.",
  );
}

/* -------------------------------------------------------------------------- */

async function requestDeviceCode(server: string): Promise<DeviceCodeResponse> {
  const res = await fetch(new URL("/api/auth/device/code", server), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "usage.write" }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(
      `could not start sign-in at ${server}: ${await describe(res)}`,
    );
  }
  return (await res.json()) as DeviceCodeResponse;
}

/**
 * Poll until the person approves, denies, or the code expires.
 *
 * `slow_down` is the server telling us we are too eager; RFC 8628 s3.5 says to
 * add five seconds and keep going, permanently, not just for the next request.
 */
async function pollForToken(
  server: string,
  grant: DeviceCodeResponse,
): Promise<TokenResponse> {
  const deadline = Date.now() + grant.expires_in * 1000;
  let intervalMs = Math.max(grant.interval, 1) * 1000;

  for (;;) {
    await sleep(intervalMs);

    if (Date.now() > deadline) {
      throw new Error("the code expired before it was approved -- run `kibble login` again");
    }

    let res: Response;
    try {
      res = await fetch(new URL("/api/auth/device/token", server), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: GRANT_TYPE,
          device_code: grant.device_code,
          client_id: CLIENT_ID,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // A dropped connection or a slow answer costs one interval, not the
      // sign-in: the code is still good until `expires_in` runs out.
      continue;
    }

    if (res.ok) return (await res.json()) as TokenResponse;

    const body = (await res.json().catch(() => ({}))) as OAuthError;
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5000;
        continue;
      case "access_denied":
        throw new Error("the request was denied in the browser");
      case "expired_token":
        throw new Error("the code expired before it was approved -- run `kibble login` again");
      default:
        throw new Error(
          `sign-in failed: ${body.error_description ?? body.error ?? res.status}`,
        );
    }
  }
}

/**
 * Trade the browser session for the collector's own credential.
 *
 * Two separate secrets on purpose: the session expires like a browser session,
 * while the link token is what `kibble push` uses from cron at six in the
 * morning. The session is discarded here and never written to disk.
 */
async function exchangeForLinkToken(
  server: string,
  accessToken: string,
  deviceName?: string,
  previousToken?: string,
): Promise<LinkResponse> {
  // Everything the server learns about this machine is in this body: a random
  // install id this machine minted for itself, a platform word, a label only
  // if the person typed one, and the token it already holds so a re-login
  // renews the same device. Not the hostname, not the username, not a
  // hardware id.
  const res = await fetch(new URL("/api/cli/link", server), {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      installId: installId(),
      platform: platformWord(),
      ...(deviceName?.trim() ? { name: deviceName.trim() } : {}),
      ...(previousToken ? { previousToken } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`could not link this machine: ${await describe(res)}`);
  }
  return (await res.json()) as LinkResponse;
}

/* -------------------------------------------------------------------------- */

/** `KXQ49TRM` reads as `KXQ4-9TRM`; the server strips the dash back off. */
function formatUserCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function platformWord(): "macos" | "linux" | "windows" | "other" {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "other";
  }
}

/** Over SSH or in CI there is no browser to open, and trying prints noise. */
function isHeadless(): boolean {
  if (process.env.CI) return true;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return true;
  return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is already on screen; failing to launch a browser is not fatal.
  }
}

async function describe(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as OAuthError;
    const detail = body.error_description ?? body.detail ?? body.message ?? body.error;
    if (detail) return `${res.status} ${detail}`;
  } catch {
    // Not JSON -- fall through to the raw body.
  }
  return `${res.status} ${text.slice(0, 200)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
