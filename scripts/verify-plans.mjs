import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudePlan, codexPlan } from "../dist/sources/plans.js";

const root = fs.mkdtempSync(join(tmpdir(), "kibble-plan-check-"));
const claudeDir = join(root, ".claude");
fs.mkdirSync(claudeDir);

const subscription = {
  agent: "claude-code",
  mode: "subscription",
  tier: "max",
  multiplier: 20,
};
const api = { agent: "claude-code", mode: "api" };
const approvedKey = "synthetic-approved-abcdefghijklmnopqrst";
const rejectedKey = "synthetic-rejected-qrstabcdefghijklmnop";
const unapprovedKey = "synthetic-new-key-ponmlkjihgfedcbazyxw";
const fingerprint = (key) => key.trim().slice(-20);

function idToken(plan) {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: plan } }),
  ).toString("base64url");
  return `synthetic.${payload}.signature`;
}

function writeGlobal(extra = {}) {
  fs.writeFileSync(
    join(root, ".claude.json"),
    JSON.stringify({
      oauthAccount: {
        organizationType: "claude_max",
        organizationRateLimitTier: "default_claude_max_20x",
      },
      customApiKeyResponses: {
        approved: [fingerprint(approvedKey)],
        rejected: [fingerprint(rejectedKey)],
      },
      ...extra,
    }),
  );
}

function writeSettings(settings = {}) {
  fs.writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(settings));
}

try {
  writeGlobal();
  writeSettings();
  assert.deepEqual(claudePlan(root, {}), subscription);
  assert.deepEqual(
    claudePlan(root, { ANTHROPIC_API_KEY: approvedKey }),
    api,
    "an approved API key must take precedence over saved Max metadata",
  );
  assert.deepEqual(
    claudePlan(root, { ANTHROPIC_API_KEY: rejectedKey }),
    subscription,
    "a rejected interactive API key must leave the saved subscription active",
  );
  assert.deepEqual(
    claudePlan(root, { ANTHROPIC_API_KEY: unapprovedKey }),
    subscription,
    "an unapproved interactive API key must not be treated as active",
  );
  assert.deepEqual(
    claudePlan(root, { ANTHROPIC_AUTH_TOKEN: "synthetic-bearer" }),
    api,
    "a bearer token must take precedence over saved Max metadata",
  );

  writeGlobal({ env: { ANTHROPIC_AUTH_TOKEN: "synthetic-global-bearer" } });
  assert.deepEqual(
    claudePlan(root, {}),
    api,
    "a bearer token in the legacy global env block must override saved Max metadata",
  );
  writeGlobal();

  writeSettings({ env: { ANTHROPIC_API_KEY: approvedKey } });
  assert.deepEqual(
    claudePlan(root, { ANTHROPIC_API_KEY: rejectedKey }),
    api,
    "the user settings env block must override the launch environment",
  );
  writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: "synthetic-settings-bearer" } });
  assert.deepEqual(
    claudePlan(root, {}),
    api,
    "a bearer token in the settings env block must override saved Max metadata",
  );

  const helperMarker = join(root, "helper-ran");
  writeSettings({ apiKeyHelper: `touch ${helperMarker}` });
  assert.deepEqual(claudePlan(root, {}), api);
  assert.equal(fs.existsSync(helperMarker), false, "plan detection must never execute apiKeyHelper");

  writeSettings({ env: { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_AUTH_TOKEN: "synthetic" } });
  assert.deepEqual(
    claudePlan(root, {}),
    { agent: "claude-code", mode: "cloud" },
    "cloud provider selection must remain the highest-precedence mode",
  );

  writeSettings();
  writeGlobal({ primaryApiKey: "synthetic-saved-console-key" });
  assert.deepEqual(
    claudePlan(root, {}),
    api,
    "a saved Console key must take precedence over stale subscription metadata",
  );

  const defaultCodexHome = join(root, ".codex");
  const customCodexHome = join(root, "custom-codex-home");
  fs.mkdirSync(defaultCodexHome);
  fs.mkdirSync(customCodexHome);
  fs.writeFileSync(
    join(defaultCodexHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: idToken("plus") } }),
  );
  fs.writeFileSync(join(customCodexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey" }));

  assert.deepEqual(
    codexPlan(root, { CODEX_HOME: customCodexHome }),
    { agent: "codex", mode: "api" },
    "CODEX_HOME auth must win over conflicting auth in the default home",
  );
  assert.deepEqual(
    codexPlan(root, {}),
    { agent: "codex", mode: "subscription", tier: "plus" },
    "the default Codex home must remain the fallback when CODEX_HOME is unset",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("OK  Agent plan detection follows credential precedence and the effective Codex home");
