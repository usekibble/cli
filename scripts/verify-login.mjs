import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "../dist/commands/login.js";
import { usage } from "../dist/commands/usage.js";
import { loadConfig, saveConfig } from "../dist/config.js";
import { sameServerOrigin } from "../dist/server.js";
import { readUpdateState, writeUpdateState } from "../dist/update-state.js";

assert.equal(
  sameServerOrigin("https://EXAMPLE.test:443/old", "https://example.test/new"),
  true,
);
assert.equal(sameServerOrigin("https://example.test", "http://example.test"), false);
assert.equal(sameServerOrigin("https://example.test", "https://other.test"), false);

const root = mkdtempSync(join(tmpdir(), "kibble-login-check-"));
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
process.env.XDG_CONFIG_HOME = root;
console.log = () => {};

async function verifyLogin(destination, linked, reporting = false) {
  saveConfig({
    server: "https://old.example/base",
    linkToken: "old-link-credential",
    email: "old@example.test",
    organizationName: "Old organization",
    lastPushedThrough: "2026-09-04",
    capabilityDigest: "old-capability-digest",
    capabilityDigestAt: "2026-09-05T00:00:00Z",
  });

  let linkRequest;
  let requestedScope;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/api/auth/device/code") {
      requestedScope = JSON.parse(init.body).scope;
      return Response.json({
        device_code: "fixture-device-code",
        user_code: "ABCD1234",
        verification_uri: `${destination}/device`,
        expires_in: 60,
        interval: 1,
      });
    }
    if (url.pathname === "/api/auth/device/token") {
      return Response.json({ access_token: "fixture-session" });
    }
    assert.equal(url.pathname, "/api/cli/link");
    linkRequest = { url, init, body: JSON.parse(init.body) };
    return Response.json({
      linkToken: "new-link-credential",
      deviceName: "fixture device",
      renewed: linked.renewed,
      email: linked.email,
      organizationName: linked.organizationName,
      teamName: null,
      autoCollect: false,
      reportingAccess: linkRequest.body.reporting === true,
    });
  };

  await login({ server: destination, browser: false, reporting });
  return { request: linkRequest, config: loadConfig(), requestedScope };
}

try {
  const same = await verifyLogin("https://OLD.example:443/other", {
    renewed: true,
    email: "old@example.test",
    organizationName: "Old organization",
  });
  assert.equal(same.request.body.reporting, undefined);
  assert.equal(same.config.reportingAccess, false);
  assert.equal(same.requestedScope, "usage.write");
  assert.equal(same.request.body.previousToken, "old-link-credential");
  assert.equal(same.request.init.redirect, "error");
  assert.equal(same.config.lastPushedThrough, undefined);
  assert.equal(same.config.capabilityDigest, undefined);
  assert.equal(same.config.capabilityDigestAt, undefined);
  assert.equal(readUpdateState().enabled, undefined, "noninteractive login must not enable CLI updates");

  writeUpdateState({ enabled: false });

  const changedIdentity = await verifyLogin("https://old.example/new-base", {
    renewed: true,
    email: "new@example.test",
    organizationName: "New organization",
  });
  assert.equal(changedIdentity.request.body.previousToken, "old-link-credential");
  assert.equal(changedIdentity.config.email, "new@example.test");
  assert.equal(changedIdentity.config.lastPushedThrough, undefined);

  const changedOrigin = await verifyLogin("https://new.example", {
    renewed: false,
    email: "old@example.test",
    organizationName: "Old organization",
  });
  assert.equal("previousToken" in changedOrigin.request.body, false);
  assert.equal(changedOrigin.request.init.redirect, "error");
  assert.equal(changedOrigin.config.lastPushedThrough, undefined);
  assert.equal(changedOrigin.config.capabilityDigest, undefined);
  assert.equal(changedOrigin.config.capabilityDigestAt, undefined);
  assert.equal(readUpdateState().enabled, false, "relinking must preserve the machine's update preference");

  const reporting = await verifyLogin("https://new.example", {
    renewed: true, email: "owner@example.test", organizationName: "Reporting fixture",
  }, true);
  assert.equal(reporting.request.body.reporting, true);
  assert.equal(reporting.config.reportingAccess, true);
  assert.equal(reporting.requestedScope, "usage.write usage.read.reporting");

  let reads = 0;
  globalThis.fetch = async (input, init) => {
    reads++;
    assert.equal(new URL(input).origin, "https://new.example");
    assert.equal(init.redirect, "error");
    return Response.json({});
  };
  await assert.rejects(usage({ server: "https://other.example", json: true }), /another server/);
  assert.equal(reads, 0, "foreign usage destination must not receive a request");
  await usage({ server: "https://NEW.example:443/path", json: true });
  assert.equal(reads, 1, "normalized same-origin usage remains available");
  // An older server can silently ignore new query parameters. Never present its
  // personal result as a successful team/org report or a scope catalog.
  await assert.rejects(usage({ scope: "team", json: true }));
  await assert.rejects(usage({ scope: "org", json: true }));
  await assert.rejects(usage({ listScopes: true, json: true }));
  const beforeInvalid = reads;
  await assert.rejects(usage({ scope: "self", team: "Engineering", json: true }));
  await assert.rejects(usage({ listScopes: true, scope: "org", json: true }));
  assert.equal(reads, beforeInvalid, "invalid scope combinations never send a request");
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get("scope"), "team");
    assert.equal(url.searchParams.get("team"), "Engineering & Platform");
    assert.equal(url.searchParams.get("range"), "7d");
    return Response.json({ scope: { type: "team", teams: [{ id: "allowed-id", name: "Engineering & Platform" }] } });
  };
  await usage({ scope: "team", team: "Engineering & Platform", range: "week", json: true });
  globalThis.fetch = async () => Response.json({ scope: { type: "team", teams: [{ id: "wrong", name: "Other" }] } });
  await assert.rejects(usage({ scope: "team", team: "Engineering", json: true }), /requested reporting scope/);
} finally {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  rmSync(root, { recursive: true, force: true });
}

console.log("OK  login keeps credentials on-origin and resets sync state");
