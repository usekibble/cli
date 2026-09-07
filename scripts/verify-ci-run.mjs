// Consequential boundaries: lost or duplicated usage, false zero spend, leaked
// output and a successful CI exit after an agent failure. No model API calls.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { ciUploadConfig, uploadCiReceipt } from "../dist/commands/ci.js";
import { ciReceiptSchema } from "../dist/ci-receipt.js";
import { CiJsonLines, CiStreamCollector } from "../dist/sources/ci-stream.js";
import { captureCiRun, ciInvocation } from "../dist/commands/run.js";
import { launchCommand } from "../dist/updates.js";
import { collectCiTranscripts } from "../dist/sources/ci-transcripts.js";
import { ciCollect } from "../dist/commands/ci-collect.js";

const secret = "synthetic-private-content-must-never-leave";
const codexFinal = {
  type: "turn.completed", usage: { input_tokens: 15869, cached_input_tokens: 11520,
    cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
};
const model = { inputTokens: 4465, outputTokens: 58, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.004755 };
const claudeFinal = { type: "result", subtype: "success", is_error: false,
  total_cost_usd: 0.004755, modelUsage: { "claude-haiku-4-5-20251001": model },
  usage: { input_tokens: 3562, output_tokens: 49, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  result: secret, session_id: secret,
};
const clone = (value) => structuredClone(value);

{
  const collector = new CiStreamCollector("codex");
  assert.equal(collector.snapshot().tokens, null);
  collector.read({ type: "thread.started", thread_id: secret });
  collector.read({ type: "item.started", item: { type: "command_execution", id: "tool-1", command: secret } });
  collector.read({ type: "item.completed", item: { type: "command_execution", id: "tool-1", exit_code: 7, aggregated_output: secret } });
  collector.read(codexFinal); collector.read(codexFinal);
  const result = collector.snapshot();
  assert.deepEqual(result.tokens, { input: 4349, cacheRead: 11520, cacheWrite: 0, output: 5, reasoning: 0 });
  assert.equal(result.costMicros, null, "missing Codex price must not become zero");
  assert.equal(result.usageStatus, "complete");
  assert.deepEqual(result.activity, { toolCalls: 1, toolErrors: 1 });
  assert.equal(JSON.stringify(result).includes(secret), false);
  collector.read({ type: "turn.started" });
  collector.read({ type: "turn.failed", error: { message: secret } });
  assert.equal(collector.snapshot().usageStatus, "partial");
  assert.equal(collector.snapshot().tokens.input, 4349);
}
{
  const collector = new CiStreamCollector("claude-code");
  const assistant = { type: "assistant", message: { usage: { input_tokens: 999999, output_tokens: 4 },
    content: [{ type: "tool_use", id: "tool-1", input: secret }, { type: "text", text: secret }] } };
  collector.read(assistant); collector.read(assistant);
  assert.equal(collector.snapshot().tokens, null, "preliminary assistant tokens are not a receipt");
  collector.read(claudeFinal); collector.read(claudeFinal);
  let result = collector.snapshot();
  assert.equal(result.tokens.input, 4465, "use modelUsage, not the main-agent usage object");
  assert.equal(result.tokens.output, 58);
  assert.equal(result.costMicros, 4755);
  assert.equal(result.activity.toolCalls, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
  const cumulative = clone(claudeFinal);
  cumulative.modelUsage["claude-haiku-4-5-20251001"].inputTokens = 5000;
  cumulative.modelUsage["other-model"] = { ...model, inputTokens: 10, outputTokens: 2 };
  cumulative.total_cost_usd = 0.01;
  collector.read(cumulative);
  result = collector.snapshot();
  assert.equal(result.tokens.input, 5010, "replace cumulative results and include every model");
  assert.equal(result.tokens.output, 60);
  assert.equal(result.costMicros, 10000);
  collector.read(claudeFinal);
  assert.equal(collector.snapshot().usageStatus, "partial", "counter resets cannot silently undercount a run");
  assert.equal(collector.snapshot().tokens.input, 5010);
}
{
  for (const value of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1, null, "100"]) {
    const collector = new CiStreamCollector("codex");
    collector.read({ ...codexFinal, usage: { ...codexFinal.usage, input_tokens: value } });
    assert.equal(collector.snapshot().usageStatus, "unavailable");
  }
  const zero = new CiStreamCollector("codex");
  zero.read({ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } });
  assert.equal(zero.snapshot().usageStatus, "complete", "explicit successful zero usage differs from missing usage");
  const fallback = new CiStreamCollector("claude-code");
  fallback.read({ ...claudeFinal, modelUsage: undefined });
  assert.equal(fallback.snapshot().usageStatus, "partial");
  assert.equal(fallback.snapshot().tokens.input, 3562);
  const failed = new CiStreamCollector("claude-code");
  failed.read({ ...claudeFinal, is_error: true, subtype: "error_during_execution" });
  assert.equal(failed.snapshot().agentResult, "failed");
  assert.equal(failed.snapshot().costMicros, 4755, "failed runs still incur spend");
  const crash = new CiStreamCollector("claude-code");
  crash.read({ ...claudeFinal, is_error: true, subtype: "error_during_execution", modelUsage: {
    "claude-haiku-4-5-20251001": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 },
  }, total_cost_usd: 0 });
  assert.equal(crash.snapshot().tokens, null, "a zeroed error receipt cannot prove a free run");
}
{
  const collector = new CiStreamCollector("codex");
  const lines = new CiJsonLines(collector, 300);
  lines.write(Buffer.from(`${secret}\n`));
  lines.write(Buffer.from("x".repeat(1000)));
  const tail = Buffer.from(`\n${JSON.stringify(codexFinal)}`);
  for (let i = 0; i < tail.length; i += 3) lines.write(tail.subarray(i, i + 3));
  lines.end();
  assert.equal(collector.snapshot().tokens.input, 4349, "resume parsing after an oversized record, including an unterminated last line");
  assert.equal(collector.snapshot().usageStatus, "partial");
  assert.deepEqual(collector.snapshot().issues, ["invalid_json", "oversized_record"]);
}

assert.deepEqual(ciInvocation(["codex", "exec", "--model", "test-model", "-"]).args,
  ["exec", "--ephemeral", "--json", "--model", "test-model", "-"]);
for (const command of [["codex", "exec", "resume"], ["claude", "--resume=uuid"],
  ["claude", "--input-format", "stream-json"], ["claude", "--output-format=json"], ["bash", "-c", secret]]) {
  assert.throws(() => ciInvocation(command));
}
assert.equal(launchCommand(["run", "--receipt", "receipt.json", "--", "codex", "exec", "--config-home", "/child"]), "run");

const root = mkdtempSync(join(tmpdir(), "kibble-ci-run-check-"));
const invocation = (script, agent = "codex") => ({ agent, executable: process.execPath,
  args: ["--input-type=module", "-e", script] });
try {
  // Persisted sessions must preserve totals across content-block splits,
  // copied files and artifact retries, without exposing native identities.
  const stamp = "2026-09-05T12:00:00.000Z";
  const writeLines = (path, records) => writeFileSync(path, records.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const directory = (name) => { const path = join(root, name); fs.mkdirSync(path); return path; };
  const knownPricing = { async prefetch() {}, knownCostMicros(_ref, usage) {
    return usage.input + 2 * usage.output + 3 * usage.cacheRead + 4 * usage.cacheWrite;
  } };
  const unknownPricing = { async prefetch() {}, knownCostMicros() { return null; } };
  const collect = (agent, sessionsDir, pricing = knownPricing) => collectCiTranscripts({ agent, sessionsDir, pricing });
  const claudeRecord = (id, input, output, cacheRead, cacheWrite) => ({
    type: "assistant", sessionId: secret, timestamp: stamp, requestId: id, cwd: `/${secret}`,
    message: { id, model: "fixture-model", usage: { input_tokens: input, output_tokens: output,
      cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
    content: [{ type: "text", text: secret }, { type: "tool_use", id: `tool-${id}`, input: { path: secret } }] },
  });
  const claudeDir = directory("claude-transcripts");
  const mainResponse = claudeRecord("main-response", 100, 10, 20, 30);
  const splitResponse = { ...mainResponse, message: { ...mainResponse.message, content: [{ type: "text", text: secret }] } };
  const childResponse = { ...claudeRecord("child-response", 30, 3, 4, 5), isSidechain: true, agentId: secret };
  const claudeRecords = [claudeRecord("main-response", 0, 0, 0, 0), mainResponse, splitResponse,
    { type: "user", sessionId: secret, timestamp: stamp,
      message: { content: [{ type: "tool_result", tool_use_id: "tool-main-response", is_error: true, content: secret }] } }];
  writeLines(join(claudeDir, `${secret}.jsonl`), claudeRecords);
  fs.mkdirSync(join(claudeDir, "subagents"));
  writeLines(join(claudeDir, "subagents", "child.jsonl"), [childResponse]);
  fs.copyFileSync(join(claudeDir, `${secret}.jsonl`), join(claudeDir, "copied.jsonl"));
  const claudeReceipts = await collect("claude-code", claudeDir);
  assert.equal(claudeReceipts.length, 1, "subagent records with the same session belong to one receipt");
  const claudeReceipt = claudeReceipts[0];
  assert.deepEqual(claudeReceipt.tokens, { input: 130, output: 13, cacheRead: 24, cacheWrite: 35, reasoning: null });
  assert.equal(claudeReceipt.costMicros, 368, "price the deduplicated parent and subagent token buckets");
  assert.deepEqual(claudeReceipt.activity, { toolCalls: 2, toolErrors: 1 });
  assert.equal(claudeReceipt.outcome, "unknown", "saved tokens do not establish a process exit status");
  assert.equal(claudeReceipt.costBasis, "list_price_estimate");
  assert.equal(JSON.stringify(claudeReceipt).includes(secret), false, "content, paths and raw session ids stay local");
  assert.equal(ciReceiptSchema.safeParse(claudeReceipt).success, true);
  const unpricedClaude = (await collect("claude-code", claudeDir, unknownPricing))[0];
  assert.equal(unpricedClaude.costMicros, null);
  assert.equal(unpricedClaude.models[0].costMicros, null);
  assert.equal(unpricedClaude.runId, claudeReceipt.runId);
  assert.equal(unpricedClaude.revision, claudeReceipt.revision, "pricing availability cannot create another usage revision");
  const movedClaude = join(root, "moved-claude");
  fs.renameSync(claudeDir, movedClaude);
  assert.deepEqual(await collect("claude-code", movedClaude), claudeReceipts, "moving an artifact preserves run identity and revision");
  const copiedClaude = join(root, "copied-claude");
  fs.cpSync(movedClaude, copiedClaude, { recursive: true });
  assert.deepEqual(await collect("claude-code", copiedClaude), claudeReceipts, "copying an artifact preserves run identity and revision");
  // Exercise the real PricingContext through the collector. Stub only its
  // external native lookup, so malformed usage passed to pricing cannot hide
  // behind a permissive injected calculator and no pricing network is needed.
  const pricingLoader = join(root, "pricing-loader.mjs");
  writeFileSync(pricingLoader, `export async function resolve(specifier, context, nextResolve) {
    if (specifier === '@tokscale/core') return { url: 'fixture:ci-pricing', shortCircuit: true };
    return nextResolve(specifier, context);
  }
  export async function load(url, context, nextLoad) {
    if (url === 'fixture:ci-pricing') return { format: 'module', shortCircuit: true,
      source: 'export async function lookupPricing() { return { pricing: { inputCostPerToken: 0.000001, outputCostPerToken: 0.000002, cacheReadInputTokenCost: 0.000003, cacheCreationInputTokenCost: 0.000004 } }; }' };
    return nextLoad(url, context);
  }`);
  const pricingRunner = join(root, "pricing-runner.mjs");
  writeFileSync(pricingRunner, `import { register } from 'node:module';
    register('./pricing-loader.mjs', import.meta.url);
    const { collectCiTranscripts } = await import(${JSON.stringify(new URL("../dist/sources/ci-transcripts.js", import.meta.url).href)});
    console.log(JSON.stringify(await collectCiTranscripts({ agent: 'claude-code', sessionsDir: ${JSON.stringify(copiedClaude)} })));`);
  const nativePriced = spawnSync(process.execPath, [pricingRunner], { encoding: "utf8", timeout: 10000 });
  assert.equal(nativePriced.status, 0, nativePriced.stderr);
  assert.equal(JSON.parse(nativePriced.stdout)[0].costMicros, 368, "real knownCostMicros accepts the collector's observed Claude usage");
  fs.appendFileSync(join(movedClaude, `${secret}.jsonl`), JSON.stringify(claudeRecord("next-response", 1, 2, 3, 4)) + "\n");
  const appendedClaude = (await collect("claude-code", movedClaude))[0];
  assert.equal(appendedClaude.runId, claudeReceipt.runId);
  assert.ok(appendedClaude.revision > claudeReceipt.revision);
  assert.deepEqual(appendedClaude.tokens, { input: 131, output: 15, cacheRead: 27, cacheWrite: 39, reasoning: null });

  // Claude can persist a positive preliminary output count before its final
  // count for the same API response. Count only the increase, including when
  // an older copied prefix is encountered after the final record.
  const growingClaudeDir = directory("growing-claude");
  const preliminaryResponse = claudeRecord("growing-response", 10, 2, 0, 0);
  const finalResponse = claudeRecord("growing-response", 10, 5, 0, 0);
  writeLines(join(growingClaudeDir, "a-current.jsonl"), [preliminaryResponse, finalResponse]);
  writeLines(join(growingClaudeDir, "z-stale-copy.jsonl"), [preliminaryResponse]);
  const growingReceipt = (await collect("claude-code", growingClaudeDir))[0];
  assert.deepEqual(growingReceipt.tokens, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: null },
    "positive repeated response counts accumulate only their monotonic increase");
  assert.equal(growingReceipt.costMicros, 20);
  assert.equal(growingReceipt.activity.toolCalls, 1, "response updates and copied prefixes do not duplicate tools");
  fs.appendFileSync(join(growingClaudeDir, "a-current.jsonl"), JSON.stringify(claudeRecord("another-response", 7, 3, 0, 0)) + "\n");
  const grownReceipt = (await collect("claude-code", growingClaudeDir))[0];
  assert.deepEqual(grownReceipt.tokens, { input: 17, output: 8, cacheRead: 0, cacheWrite: 0, reasoning: null });
  assert.equal(grownReceipt.costMicros, 33);
  assert.equal(grownReceipt.runId, growingReceipt.runId);
  assert.ok(grownReceipt.revision > growingReceipt.revision);
  const conflictingClaudeDir = directory("conflicting-claude");
  writeLines(join(conflictingClaudeDir, "conflict.jsonl"), [finalResponse, claudeRecord("growing-response", 9, 6, 0, 0)]);
  await assert.rejects(() => collect("claude-code", conflictingClaudeDir), /collection failed/,
    "incomparable buckets for one response must not fabricate a summed estimate");
  writeLines(join(conflictingClaudeDir, "conflict.jsonl"), [finalResponse,
    { ...finalResponse, message: { ...finalResponse.message, model: "other-model" } }]);
  await assert.rejects(() => collect("claude-code", conflictingClaudeDir), /collection failed/,
    "one response cannot silently change its price model");

  const native = (type, payload) => ({ type, timestamp: stamp, payload });
  const codexUsage = (input, cached, output, reasoning) => ({ input_tokens: input, cached_input_tokens: cached,
    output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
  const tokenRecord = (last, total) => native("event_msg", { type: "token_count", info: { last_token_usage: last, total_token_usage: total } });
  const firstTokens = codexUsage(100, 20, 10, 2);
  const secondTokens = codexUsage(50, 10, 5, 1);
  const secondTotal = codexUsage(150, 30, 15, 3);
  const codexRecords = [native("session_meta", { id: secret, timestamp: stamp, cwd: `/${secret}` }),
    native("turn_context", { model: "model-a" }), tokenRecord(firstTokens, firstTokens), tokenRecord(firstTokens, firstTokens),
    native("turn_context", { model: "model-b" }), tokenRecord(secondTokens, secondTotal),
    native("event_msg", { type: "exec_command_end", call_id: secret, exit_code: 1, command: secret, output: secret })];
  const codexDir = directory("codex-transcripts");
  writeLines(join(codexDir, "session.jsonl"), codexRecords);
  writeLines(join(codexDir, "copied.jsonl"), codexRecords);
  const codexReceipt = (await collect("codex", codexDir))[0];
  assert.deepEqual(codexReceipt.tokens, { input: 120, output: 15, cacheRead: 30, cacheWrite: 0, reasoning: 3 });
  assert.equal(codexReceipt.costMicros, 240);
  assert.deepEqual(codexReceipt.models.map((row) => [row.model, row.input, row.costMicros]), [["model-a", 80, 160], ["model-b", 40, 80]]);
  assert.deepEqual(codexReceipt.activity, { toolCalls: 1, toolErrors: 1 });
  assert.equal(JSON.stringify(codexReceipt).includes(secret), false);
  const provisionalDir = directory("provisional-codex");
  const provisionalPath = join(provisionalDir, "session.jsonl");
  writeLines(provisionalPath, [native("session_meta", { id: "provisional-session", timestamp: stamp }), ...codexRecords]);
  const actualReceipts = await collect("codex", provisionalDir);
  assert.equal(actualReceipts.length, 1, "a provisional header preceding the actual session cannot create a phantom run");
  assert.deepEqual(actualReceipts[0], codexReceipt, "the actual session keeps its identity, totals and model prices");
  writeLines(provisionalPath, [native("session_meta", { id: "provisional-session", timestamp: stamp })]);
  await assert.rejects(() => collect("codex", provisionalDir), /No supported CI sessions/,
    "a header alone cannot establish a run or a free usage receipt");
  fs.appendFileSync(provisionalPath, JSON.stringify(native("turn_context", { model: "model-a" })) + "\n");
  const attempted = await collect("codex", provisionalDir);
  assert.equal(attempted.length, 1, "a context record establishes an attempted session even without usage");
  assert.equal(attempted[0].usageStatus, "unavailable");
  assert.equal(attempted[0].tokens, null);
  assert.equal(attempted[0].costMicros, null);
  fs.appendFileSync(join(codexDir, "session.jsonl"), JSON.stringify(tokenRecord(codexUsage(25, 5, 2, 0), codexUsage(175, 35, 17, 3))) + "\n");
  const appendedCodex = (await collect("codex", codexDir))[0];
  assert.equal(appendedCodex.runId, codexReceipt.runId);
  assert.ok(appendedCodex.revision > codexReceipt.revision);
  assert.deepEqual(appendedCodex.tokens, { input: 140, output: 17, cacheRead: 35, cacheWrite: 0, reasoning: 3 });

  const invalidDir = directory("invalid-transcripts");
  await assert.rejects(() => collect("codex", join(root, "absent-directory")), /Cannot scan CI sessions/);
  await assert.rejects(() => collect("codex", invalidDir), /No CI transcript files/);
  const invalidFile = join(invalidDir, "invalid.jsonl");
  writeFileSync(invalidFile, "{not-json}\n");
  await assert.rejects(() => collect("codex", invalidDir), /collection failed/);
  writeFileSync(invalidFile, JSON.stringify({ type: "irrelevant", content: "x".repeat(8 * 1024 * 1024) }) + "\n");
  await assert.rejects(() => collect("codex", invalidDir), /collection failed/);
  writeLines(invalidFile, [native("session_meta", { timestamp: stamp }), tokenRecord(firstTokens, firstTokens)]);
  await assert.rejects(() => collect("codex", invalidDir), /collection failed/);
  writeLines(invalidFile, [{ type: "session_meta", payload: { id: secret } }, tokenRecord(firstTokens, firstTokens)]);
  await assert.rejects(() => collect("codex", invalidDir), /collection failed/);
  writeLines(invalidFile, [{ ...mainResponse, timestamp: undefined }]);
  await assert.rejects(() => collect("claude-code", invalidDir), /collection failed/);
  writeLines(invalidFile, [mainResponse, { ...childResponse, sessionId: undefined }]);
  await assert.rejects(() => collect("claude-code", invalidDir), /collection failed/, "a malformed response cannot be silently omitted beside valid usage");
  for (const malformed of [[], "invalid-usage", 100]) {
    writeLines(invalidFile, [mainResponse, { ...childResponse, message: { ...childResponse.message, usage: malformed } }]);
    await assert.rejects(() => collect("claude-code", invalidDir), /collection failed/, "malformed Claude usage cannot disappear beside valid usage");
    for (const info of [malformed, { last_token_usage: malformed, total_token_usage: firstTokens }, { last_token_usage: firstTokens, total_token_usage: malformed }]) {
      writeLines(invalidFile, [native("session_meta", { id: secret, timestamp: stamp }), tokenRecord(firstTokens, firstTokens),
        native("event_msg", { type: "token_count", info })]);
      await assert.rejects(() => collect("codex", invalidDir), /collection failed/, "malformed Codex usage cannot disappear beside valid usage");
    }
  }
  await assert.rejects(() => collect("codex", invalidFile), /Cannot scan CI sessions/);
  fs.rmSync(invalidFile);
  const linkedDir = join(root, "linked-transcripts");
  fs.symlinkSync(codexDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => collect("codex", linkedDir), /Cannot scan CI sessions/);
  fs.symlinkSync(codexDir, join(invalidDir, "nested-link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => collect("codex", invalidDir), /Cannot scan CI sessions/);
  fs.rmSync(join(invalidDir, "nested-link"));
  if (process.platform !== "win32") {
    assert.equal(spawnSync("mkfifo", [invalidFile]).status, 0);
    await assert.rejects(() => collect("codex", invalidDir), /Cannot scan CI sessions/);
    fs.rmSync(invalidFile);
  }

  // No model context means an unknown price and requires no pricing lookup.
  // This exercises the command without a token, without a model/network call.
  const localDir = directory("local-transcripts");
  writeLines(join(localDir, "local.jsonl"), [native("session_meta", { id: secret, timestamp: stamp }), tokenRecord(firstTokens, firstTokens)]);
  const localOutput = join(root, "local-receipts");
  const originalToken = process.env.KIBBLE_CI_TOKEN;
  try {
    delete process.env.KIBBLE_CI_TOKEN;
    await ciCollect({ agent: "codex", sessionsDir: localDir, receiptsDir: localOutput });
    const receiptFiles = readdirSync(localOutput);
    assert.equal(receiptFiles.length, 1);
    assert.match(receiptFiles[0], /^[a-f0-9-]+\.json$/);
    const localReceiptPath = join(localOutput, receiptFiles[0]);
    const originalReceipt = readFileSync(localReceiptPath, "utf8");
    const localReceipt = JSON.parse(originalReceipt);
    assert.equal(localReceipt.tokens.input, 80);
    assert.equal(localReceipt.costMicros, null);
    assert.equal(originalReceipt.includes(secret), false);
    if (process.platform !== "win32") assert.equal(statSync(localReceiptPath).mode & 0o777, 0o600);
    const localCli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const collected = spawnSync(process.execPath, [localCli, "ci", "collect", "--agent", "codex", "--sessions-dir", localDir, "--receipts-dir", localOutput],
      { encoding: "utf8", env: { ...process.env, CI: "1" }, timeout: 10000 });
    assert.equal(collected.status, 0, collected.stderr);
    assert.equal((collected.stdout + collected.stderr).includes(secret), false);
    assert.match(collected.stdout, /Receipt saved locally/);
    assert.equal(readFileSync(localReceiptPath, "utf8"), originalReceipt, "recollection preserves the saved receipt bytes");
    fs.appendFileSync(join(localDir, "local.jsonl"), JSON.stringify(tokenRecord(secondTokens, secondTotal)) + "\n");
    await ciCollect({ agent: "codex", sessionsDir: localDir, receiptsDir: localOutput });
    const advancedReceipt = readFileSync(localReceiptPath, "utf8");
    assert.equal(JSON.parse(advancedReceipt).tokens.input, 120);
    assert.ok(JSON.parse(advancedReceipt).revision > localReceipt.revision);
    writeLines(join(localDir, "local.jsonl"), [native("session_meta", { id: secret, timestamp: stamp }), tokenRecord(firstTokens, firstTokens)]);
    await assert.rejects(() => ciCollect({ agent: "codex", sessionsDir: localDir, receiptsDir: localOutput }), /regressed or conflicts/);
    assert.equal(readFileSync(localReceiptPath, "utf8"), advancedReceipt, "truncated session logs cannot replace an earlier full receipt");
  } finally {
    if (originalToken === undefined) delete process.env.KIBBLE_CI_TOKEN; else process.env.KIBBLE_CI_TOKEN = originalToken;
  }

  const path = join(root, "success.json");
  const script = `process.stderr.write(${JSON.stringify(secret)}); process.stdout.write(${JSON.stringify(JSON.stringify(codexFinal))});`;
  const privacyRunner = join(root, "privacy.mjs");
  writeFileSync(privacyRunner, `import { captureCiRun } from ${JSON.stringify(new URL("../dist/commands/run.js", import.meta.url).href)};
const result = await captureCiRun(${JSON.stringify(invocation(script))}, ${JSON.stringify(path)});
process.exitCode = result.exitCode;`);
  const success = spawnSync(process.execPath, [privacyRunner], { encoding: "utf8", timeout: 10000 });
  assert.equal(success.status, 0, success.stderr);
  assert.equal((success.stdout + success.stderr).includes(secret), false, "agent stderr must not leak into CI logs");
  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(stored.outcome, "succeeded");
  assert.equal(stored.tokens.input, 4349);
  assert.equal(JSON.stringify(stored).includes(secret), false);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  await assert.rejects(() => captureCiRun(invocation("process.exit(99)"), path), /new file/);
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(stored, null, 2)}\n`, "a retry cannot overwrite another execution");

  const failure = await captureCiRun(invocation("process.exit(7)"), join(root, "failure.json"));
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.receipt.tokens, null);
  assert.equal(failure.receipt.costMicros, null);
  const unavailable = await captureCiRun(invocation("process.exit(0)"), join(root, "empty.json"));
  assert.equal(unavailable.exitCode, 1, "an empty successful process is not successful collection");
  const errorResult = { ...claudeFinal, is_error: true, subtype: "error_during_execution" };
  const semanticJson = await captureCiRun(invocation(`process.stdout.write(${JSON.stringify(JSON.stringify(errorResult))})`, "claude-code"), join(root, "semantic-json.json"));
  assert.equal(semanticJson.receipt.process.exitCode, 0);
  assert.equal(semanticJson.receipt.outcome, "failed");
  assert.equal(semanticJson.receipt.costMicros, 4755);
  assert.equal(semanticJson.exitCode, 1, "Claude's structured error cannot turn CI green");
  const missing = await captureCiRun({ ...invocation(""), executable: join(root, "does-not-exist") }, join(root, "missing.json"));
  assert.equal(missing.receipt.outcome, "launch_failed");
  assert.equal(missing.receipt.process.exitCode, null, "a spawn error is not an OS process exit code");
  assert.equal(ciReceiptSchema.safeParse(missing.receipt).success, true, "launch failures must remain uploadable");
  assert.equal(missing.exitCode, 1);

  const failedWritePath = join(root, "write-failed.json");
  const realRename = fs.renameSync;
  const realError = console.error;
  let diagnostic = "";
  try {
    fs.renameSync = (from, to) => {
      if (to === failedWritePath) throw new Error(secret);
      return realRename(from, to);
    };
    syncBuiltinESMExports();
    console.error = (message) => { diagnostic += message; };
    const result = await captureCiRun(invocation(script), failedWritePath);
    assert.equal(result.exitCode, 1, "failed receipt persistence must fail the wrapper");
    assert.equal(result.saved, false);
    assert.equal(JSON.parse(readFileSync(failedWritePath, "utf8")).outcome, "running", "a failed replacement retains the last complete checkpoint");
    assert.equal(diagnostic.includes(secret), false, "filesystem diagnostics cannot expose raw errors");
  } finally {
    fs.renameSync = realRename;
    syncBuiltinESMExports();
    console.error = realError;
  }

  // Invoke the actual command parser. Agent arguments after -- must stay with
  // the agent, including flags which resemble Kibble's global options.
  const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const help = spawnSync(process.execPath, [cli, "run", "--help"], { encoding: "utf8", env: { ...process.env, CI: "1" } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--receipt/);
  const absent = spawnSync(process.execPath, [cli, "run", "--receipt", join(root, "cli.json"), "--", join(root, "codex"), "exec", "--config-home", "/child"],
    { encoding: "utf8", env: { ...process.env, CI: "1" } });
  assert.equal(absent.status, 1);
  assert.equal(JSON.parse(readFileSync(join(root, "cli.json"), "utf8")).outcome, "launch_failed", absent.stderr);
  assert.equal((absent.stdout + absent.stderr).includes("/child"), false);

  if (process.platform !== "win32") {
    const runner = join(root, "runner.mjs");
    const signalPath = join(root, "signal.json");
    const childScript = `process.on('SIGTERM', () => process.exit(0)); console.log(JSON.stringify(${JSON.stringify(codexFinal)})); setInterval(() => {}, 1000);`;
    writeFileSync(runner, `import { captureCiRun } from ${JSON.stringify(new URL("../dist/commands/run.js", import.meta.url).href)};
const result = await captureCiRun(${JSON.stringify(invocation(childScript))}, ${JSON.stringify(signalPath)});
process.exitCode = result.exitCode;`);
    const runnerProcess = spawn(process.execPath, [runner], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    runnerProcess.stdout.on("data", (chunk) => { output += chunk; });
    runnerProcess.stderr.on("data", (chunk) => { output += chunk; });
    const done = new Promise((resolve, reject) => {
      runnerProcess.once("error", reject);
      runnerProcess.once("close", (code) => resolve(code));
    });
    const deadline = Date.now() + 10000;
    try {
      for (;;) {
        try { if (JSON.parse(readFileSync(signalPath, "utf8")).tokens) break; } catch { /* Initial write may still be pending. */ }
        assert.ok(Date.now() < deadline, "timed out waiting for the live receipt checkpoint");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      runnerProcess.kill("SIGTERM");
      assert.equal(await done, 143, output);
      const receipt = JSON.parse(readFileSync(signalPath, "utf8"));
      assert.equal(receipt.outcome, "interrupted");
      assert.equal(receipt.process.forwardedSignal, "SIGTERM");
      assert.equal(receipt.usageStatus, "partial");
      assert.equal(receipt.tokens.input, 4349, "interruption retains the last observed totals");
    } finally { runnerProcess.kill("SIGKILL"); }
  }
  assert.equal(readdirSync(root).some((file) => file.endsWith(".tmp")), false);
  const previousToken = process.env.KIBBLE_CI_TOKEN;
  const credential = `kci_${"x".repeat(43)}`;
  let calls = 0;
  let mode = "retry";
  let leaked = false;
  const receiver = createServer(async (request, response) => {
    calls++;
    if (request.url === "/redirected") leaked = true;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(request.headers.authorization, `Bearer ${credential}`);
    assert.equal(JSON.stringify(body).includes(secret), false);
    if (mode === "redirect") { response.writeHead(307, { Location: "/redirected" }); response.end(secret); return; }
    if (mode === "refuse") { response.writeHead(401); response.end(secret); return; }
    if (mode === "retry" && calls === 1) { response.writeHead(503); response.end(secret); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ runId: mode === "wrong" ? "not-this-run" : body.runId, revision: body.revision, status: "accepted" }));
  });
  try {
    process.env.KIBBLE_CI_TOKEN = credential;
    await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${receiver.address().port}`;
    const config = ciUploadConfig(origin);
    assert.throws(() => ciUploadConfig("http://external.example"), /HTTPS/);
    assert.throws(() => ciUploadConfig("https://user:password@example.com"), /HTTPS/);
    await assert.rejects(() => uploadCiReceipt({ ...stored, prompt: secret }, config), /Invalid CI receipt/);
    assert.equal(calls, 0, "invalid content must be rejected before network access");
    assert.equal((await uploadCiReceipt(stored, config)).status, "accepted");
    assert.equal(calls, 2, "transient failures retry the same receipt");
    mode = "refuse";
    const before = calls;
    await assert.rejects(() => uploadCiReceipt(stored, config), (error) => /HTTP 401/.test(error.message) && !error.message.includes(secret));
    assert.equal(calls, before + 1, "credential failures are not retried");
    mode = "wrong";
    await assert.rejects(() => uploadCiReceipt(stored, config), /did not acknowledge/);
    mode = "redirect";
    await assert.rejects(() => uploadCiReceipt(stored, config), /unavailable after retries/);
    assert.equal(leaked, false, "credentials cannot follow a redirect");
    mode = "accept";
    const uploaded = spawn(process.execPath, [cli, "ci", "upload", path, "--server", origin], {
      env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    uploaded.stdout.on("data", (chunk) => { log += chunk; });
    uploaded.stderr.on("data", (chunk) => { log += chunk; });
    const code = await new Promise((resolve, reject) => { uploaded.once("error", reject); uploaded.once("close", resolve); });
    assert.equal(code, 0, log);
    assert.equal(log.includes(credential), false);
    assert.match(log, /accepted/);
  } finally {
    if (previousToken === undefined) delete process.env.KIBBLE_CI_TOKEN; else process.env.KIBBLE_CI_TOKEN = previousToken;
    await new Promise((resolve) => receiver.close(resolve));
  }
} finally { rmSync(root, { recursive: true, force: true }); }

console.log("OK  CI run receipts preserve accounting, failures and privacy without persisted agent sessions");
