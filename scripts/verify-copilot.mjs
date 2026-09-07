/** Consequential Copilot regressions, run by the existing collector verify gate.
 * Fixtures use GitHub's published session-events schema. They establish parser
 * behavior, not live end-to-end accuracy on an authenticated Copilot install.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotSource, copilotUsageVisitor } from "../dist/sources/copilot.js";
import { copilotInventory } from "../dist/sources/capabilities.js";
import { scanLocal } from "../dist/sources/local.js";
import { readPlans } from "../dist/sources/plans.js";
import { RepoCollector } from "../dist/sources/repos.js";

export async function verifyCopilot() {
  const home = mkdtempSync(join(tmpdir(), "kibble-copilot-check-"));
  const root = join(home, "relocated-copilot");
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sessionDir = join(root, "session-state", sessionId);
  const first = "2026-09-05";
  const second = "2026-09-06";
  let sequence = 0;
  const event = (type, data, day = second) => ({
    id: `fixture-${++sequence}`, type, timestamp: `${day}T12:00:00Z`, data,
  });
  const metric = (inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, count, reasoningTokens = 0) => ({
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens },
    requests: { count, cost: 99999 }, totalNanoAiu: 99999,
  });
  const checkpoint = (metrics, day) => event("session.shutdown", {
    modelMetrics: metrics, codeChanges: { linesAdded: day === first ? 2 : 3, linesRemoved: 1, filesModified: ["PRIVATE_PATH"] },
  }, day);
  const start = event("session.start", {
    sessionId, copilotVersion: "1.0.83", producer: "copilot-cli",
    context: { repository: "private-owner/widget", cwd: home, branch: "main" },
  }, first);
  const one = checkpoint({ "claude-sonnet-4": metric(1000, 200, 300, 100, 2, 50) }, first);
  const two = checkpoint({
    "claude-sonnet-4": metric(1500, 300, 450, 150, 3, 75),
    "gpt-5": metric(200, 40, 0, 0, 1),
  }, second);
  const records = [
    start, one,
    event("user.message", { content: "PRIVATE_PROMPT" }),
    event("assistant.turn_start", { turnId: "turn-1" }),
    event("tool.execution_start", { toolCallId: "tool-1", toolName: "read", mcpServerName: "docs", arguments: { path: "PRIVATE_PATH" } }),
    event("tool.execution_complete", { toolCallId: "tool-1", success: false, result: { content: "PRIVATE_OUTPUT" } }),
    event("skill.invoked", { name: "fixture-skill", trigger: "agent-invoked", path: "PRIVATE_PATH", content: "12345678" }),
    event("assistant.message", { turnId: "turn-1", messageId: "message-1", content: "PRIVATE_REPLY" }),
    event("assistant.turn_end", { turnId: "turn-1" }),
    two, two,
    { ...two, id: "subagent-shutdown", agentId: "subagent" },
    checkpoint({ "claude-sonnet-4": metric(1000, 200, 300, 100, 2, 50) }, second),
    { ...two, id: "same-totals-new-event" },
  ];
  const save = (path, text) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  const price = (r) => r.tokensIn * 2 + r.tokensOut * 3 + r.tokensCacheRead + r.tokensCacheWrite * 4;
  try {
    save(join(sessionDir, "events.jsonl"), records.map(JSON.stringify).join("\n") + '\nnull\n{"partial":');
    // Workspace artifacts are not transcript sources, even with a JSONL suffix.
    save(join(sessionDir, "files", "artifact.jsonl"), [start, one].map(JSON.stringify).join("\n"));
    const source = new CopilotSource({ home, copilotHome: root, priceOf: price });
    const all = await source.collect({ since: first, until: second });
    assert.equal(all.daily.length, 3);
    assert.equal(all.daily.reduce((n, r) => n + r.costMicros, 0), 4270, "cached input, repeated shutdowns and subagent totals must not double charge");
    assert.deepEqual(all.sessions, [{ sessionId, agent: "copilot", date: first, messageCount: 4, costMicros: 4270 }]);
    assert.deepEqual(await source.collect({ since: first, until: second }), all, "repeated collection must be idempotent");
    const narrowed = await source.collect({ since: second, until: second });
    assert.equal(narrowed.daily.reduce((n, r) => n + r.costMicros, 0), 1770, "prior-day checkpoint must still be subtracted");
    assert.equal(narrowed.daily.reduce((n, r) => n + r.tokensReasoning, 0), 25, "reasoning is a subset of output, not extra spend");

    const skillDir = join(root, "skills", "directory-alias");
    save(join(skillDir, "SKILL.md"), "---\nname: fixture-skill\ndescription: fixture only\n---\nPRIVATE_SKILL_BODY");
    symlinkSync(skillDir, join(root, "skills", "other-alias"), process.platform === "win32" ? "junction" : "dir");
    mkdirSync(join(root, "skills", "not-a-skill"));
    const inventory = copilotInventory(home, [], root, {});
    assert.deepEqual([...inventory.skills.keys()], ["fixture-skill"], "frontmatter identity and symlink aliases must not duplicate installed skills");

    const local = scanLocal({ home, copilotHome: root, vscodeUserDataDirs: [], since: first, until: second, priceOf: (_model, r) => r.input_tokens * 2 + r.output_tokens * 3 + r.cache_read_input_tokens + r.cache_creation_input_tokens * 4 });
    const repos = local.repos.filter((r) => r.agent === "copilot");
    assert.equal(repos.reduce((n, r) => n + r.costMicros, 0), 4270);
    assert.equal(repos.reduce((n, r) => n + r.humanTurns, 0), 1);
    assert.equal(repos.reduce((n, r) => n + r.toolErrors, 0), 1);
    assert.equal(repos.reduce((n, r) => n + r.linesAdded, 0), 3);
    assert.equal(local.capabilities.find((r) => r.agent === "copilot" && r.name === "docs")?.invocations, 1);
    const skill = local.capabilities.find((r) => r.agent === "copilot" && r.name === "fixture-skill");
    assert.equal(skill?.invocations, 1);
    assert.equal(skill?.installed, true);
    assert.equal(skill?.attributedTokens, 0, "Copilot provides no downstream skill attribution");
    assert(!JSON.stringify({ all, local }).includes("PRIVATE_"), "private neighboring fields must not leave the collector");
    assert(!JSON.stringify({ all, local }).includes(home), "paths must stay local");

    const collector = new RepoCollector({ since: first, until: second });
    const visitor = collector.copilot();
    visitor.startFile();
    for (const r of [start, one, event("assistant.turn_start", { turnId: "mixed" }), event("session.context_changed", { repository: "owner/another", cwd: home }), two]) visitor.record(r);
    assert.equal(collector.finish().reduce((n, r) => n + r.tokensIn, 0), 600, "mixed-repo checkpoint interval must stay unattributed");

    const resumed = new RepoCollector({ since: first, until: second });
    const resumedVisitor = resumed.copilot();
    resumedVisitor.startFile();
    for (const r of [start, one, event("session.resume", { context: { repository: "owner/resumed", cwd: home } }), two]) resumedVisitor.record(r);
    assert.equal(resumed.finish().find((r) => r.repo === "resumed")?.tokensIn, 500, "resume context must own subsequent checkpoint deltas");

    // Throwing getters make accidental private-field reads fail immediately.
    const guarded = { modelMetrics: { "gpt-5": metric(10, 2, 0, 0, 1) } };
    for (const field of ["content", "prompt", "arguments", "tokenDetails", "agentMetrics"]) {
      Object.defineProperty(guarded, field, { get() { throw new Error(`private field read: ${field}`); } });
    }
    const emitted = [];
    const usageVisitor = copilotUsageVisitor((r) => emitted.push(r));
    usageVisitor.startFile();
    usageVisitor.record(start);
    usageVisitor.record(event("session.shutdown", guarded));
    assert.equal(emitted.length, 1);

    const env = { COPILOT_HOME: root };
    assert.deepEqual(readPlans({ home, env }), [], "session presence does not establish a billing plan");
    save(join(root, "config.json"), '// state\n{ "loggedInUsers": [{ "login": "PRIVATE_USER", "token": "PRIVATE_TOKEN" }], /* no verified tier */ "planTier": "max", }');
    assert.deepEqual(readPlans({ home, env }), [{ agent: "copilot", mode: "subscription" }]);
    assert.deepEqual(readPlans({ home, env: { ...env, COPILOT_PROVIDER_BASE_URL: "http://localhost:9999", COPILOT_PROVIDER_TYPE: "azure" } }), [{ agent: "copilot", mode: "cloud" }]);
    console.log("OK  Copilot fixtures: cache accounting, resume, idempotency, repo attribution, inventory and privacy");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
