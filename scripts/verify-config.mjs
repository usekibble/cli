import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, loadConfig, saveConfig } from "../dist/config.js";

const root = fs.mkdtempSync(join(tmpdir(), "kibble-config-check-"));
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const realRead = fs.readFileSync;
const realWrite = fs.writeFileSync;
const realFsync = fs.fsyncSync;
const realRename = fs.renameSync;
process.env.XDG_CONFIG_HOME = root;

const original = {
  server: "https://fixture.example",
  linkToken: "synthetic-original-credential",
  capabilities: true,
};
const replacement = {
  server: "https://replacement.example",
  linkToken: "synthetic-replacement-credential",
  autoCollect: true,
};

function restoreFs() {
  fs.readFileSync = realRead;
  fs.writeFileSync = realWrite;
  fs.fsyncSync = realFsync;
  fs.renameSync = realRename;
  syncBuiltinESMExports();
}

function onlyLiveConfigRemains() {
  assert.deepEqual(fs.readdirSync(dirname(configPath())), ["config.json"]);
}

function thrown(fn, pattern) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof Error, "expected operation to throw");
  assert.match(caught.message, pattern);
  return caught;
}

try {
  assert.deepEqual(loadConfig(), { server: "https://app.usekibble.com" });
  saveConfig(original);
  assert.deepEqual(loadConfig(), original);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
  }

  let duringWrite;
  fs.writeFileSync = (path, data, options) => {
    realWrite(path, data, options);
    duringWrite = loadConfig();
  };
  syncBuiltinESMExports();
  saveConfig(replacement);
  restoreFs();
  assert.deepEqual(duringWrite, original, "readers must see the old complete config during a write");
  assert.deepEqual(loadConfig(), replacement);
  onlyLiveConfigRemains();

  saveConfig(original);
  fs.writeFileSync = (path, data, options) => {
    realWrite(path, data, options);
    throw new Error("synthetic write interruption");
  };
  syncBuiltinESMExports();
  assert.throws(() => saveConfig(replacement), /synthetic write interruption/);
  restoreFs();
  assert.deepEqual(loadConfig(), original, "a write failure must preserve the previous config");
  onlyLiveConfigRemains();

  fs.fsyncSync = () => {
    throw new Error("synthetic flush interruption");
  };
  syncBuiltinESMExports();
  assert.throws(() => saveConfig(replacement), /synthetic flush interruption/);
  restoreFs();
  assert.deepEqual(loadConfig(), original, "a flush failure must preserve the previous config");
  onlyLiveConfigRemains();

  fs.renameSync = () => {
    throw new Error("synthetic rename interruption");
  };
  syncBuiltinESMExports();
  assert.throws(() => saveConfig(replacement), /synthetic rename interruption/);
  restoreFs();
  assert.deepEqual(loadConfig(), original, "a rename failure must preserve the previous config");
  onlyLiveConfigRemains();

  assert.throws(
    () => saveConfig({ server: 42 }),
    /field "server" must be a string/,
  );
  assert.deepEqual(loadConfig(), original, "invalid save input must preserve the previous config");
  onlyLiveConfigRemains();

  realWrite(configPath(), '{"linkToken":"synthetic-secret-value"');
  const malformed = thrown(() => loadConfig(), /not valid JSON/);
  assert.equal(malformed.message.includes("synthetic-secret-value"), false);

  realWrite(configPath(), JSON.stringify({ server: "https://fixture.example", capabilities: "yes" }));
  assert.throws(() => loadConfig(), /field "capabilities" must be a boolean/);

  fs.readFileSync = (path, options) => {
    if (path !== configPath()) return realRead(path, options);
    const error = new Error("synthetic-secret-value");
    error.code = "EACCES";
    throw error;
  };
  syncBuiltinESMExports();
  const unreadable = thrown(() => loadConfig(), /Could not read Kibble config.*EACCES/);
  assert.equal(unreadable.message.includes("synthetic-secret-value"), false);
} finally {
  restoreFs();
  if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfigHome;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("OK  config writes atomically and reports existing invalid files");
