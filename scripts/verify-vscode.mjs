/** Lost/duplicated spend, wrong provider, and private-content regressions.
 * Expected counts are independent fixture constants, not another collector.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { VsCodeCopilotSource, scanVsCode, replayVsCode, vsCodeDataDirs } from "../dist/sources/vscode.js";
import { mergeCollections } from "../dist/sources/index.js";
import { scanLocal } from "../dist/sources/local.js";
import { CapabilityCollector } from "../dist/sources/capabilities.js";
import { vsCodeCapabilityInventory, vsCodeCapabilityInvocations } from "../dist/sources/vscode-capabilities.js";
import initSqlJs from "sql.js";
import { verifyVsCodeTranscripts } from "./verify-vscode-transcripts.mjs";

export async function verifyVsCode() {
  await verifyVsCodeTranscripts();
  const home = mkdtempSync(join(tmpdir(), "kibble-vscode-check-"));
  const root = join(home, "Code");
  const dir = join(root, "User/workspaceStorage/workspace/chatSessions");
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const date = "2026-09-07";
  const range = { since: date, until: date };
  const options = { home, userDataDirs: [root], ...range };
  const make = (requestId, timestamp, promptTokens, completionTokens) => ({
    requestId, timestamp: Date.parse(timestamp), modelId: "copilot/auto",
    agent: { extensionId: { value: "GitHub.copilot-chat" } },
    promptTokens, completionTokens, modelState: { value: 1 }, elapsedMs: 20,
    result: { metadata: { resolvedModel: "gpt-5", toolCallRounds: [{ modelId: "gpt-5", response: "PRIVATE_REPLY" }], renderedUserMessage: "PRIVATE_PROMPT" } },
    message: { text: "PRIVATE_PROMPT" },
    response: [{ kind: "toolInvocationSerialized", toolCallId: "tool-1", toolId: "mcp_read", source: { type: "mcp", serverLabel: "docs", instructions: "PRIVATE_INSTRUCTIONS" }, resultDetails: { output: "PRIVATE_OUTPUT" } }],
  });
  const first = make("request-1", `${date}T00:00:01Z`, 100, 20);
  const second = make("request-2", `${date}T23:59:59Z`, 200, 30);
  const before = make("request-before", "2026-09-06T23:59:59Z", 900, 900);
  const initial = { sessionId, requests: [before, first] };
  const write = (path, value) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, value); };
  const log = (entries) => entries.map(JSON.stringify).join("\n") + "\n";
  const file = join(dir, `${sessionId}.jsonl`);
  const priceOf = (_model, u) => (u.input_tokens ?? 0) * 2 + (u.output_tokens ?? 0) * 3 + (u.cache_read_input_tokens ?? 0);
  try {
    // A folder URI is consumed locally, never sent. The directory need not be
    // a Git checkout to demonstrate the name-only boundary.
    const repo = join(home, "sample-repo"); mkdirSync(repo);
    write(join(dir, "../workspace.json"), JSON.stringify({ folder: pathToFileURL(repo).href }));
    const operations = [
      { kind: 0, v: initial },
      { kind: 2, k: ["requests"], v: [second] },
      { kind: 1, k: ["requests", 1, "promptTokens"], v: 110 },
      { kind: 1, k: ["requests", 1, "message", "text"], v: "PRIVATE_UPDATE" },
      { kind: 2, k: ["requests", 1, "response"], v: [first.response[0]] },
    ];
    write(file, log(operations) + '{"kind":');
    // A legacy JSON copy next to the JSONL is not an extra session.
    write(join(dir, `${sessionId}.json`), JSON.stringify(initial));
    const source = new VsCodeCopilotSource({ ...options, priceOf });
    const got = await source.collect(range);
    assert.equal(got.daily.length, 1);
    assert.equal(got.daily[0].tokensIn, 310);
    assert.equal(got.daily[0].tokensOut, 50);
    assert.equal(got.daily[0].costMicros, 770);
    assert.equal(got.daily[0].messageCount, 2);
    assert.equal(got.sessions.length, 1);
    assert.deepEqual(await source.collect(range), got, "repeated collection changes spend");
    const local = scanLocal({ home, copilotHome: join(home, ".copilot"), vscodeUserDataDirs: [root], ...range, priceOf });
    assert.equal(local.repos[0]?.costMicros, 770);
    assert.equal(local.repos[0]?.humanTurns, 2);
    assert.equal(local.repos[0]?.toolCalls, 2, "a tool snapshot was counted twice");
    assert.equal(local.capabilities.find((c) => c.name === "docs")?.invocations, 2);
    assert(!JSON.stringify({ got, local }).includes("PRIVATE_"));
    assert(!JSON.stringify({ got, local }).includes(home));

    // Copilot CLI and editor rows share one ingest grain: neither can replace
    // the other. This calls the production merge used by the default source.
    const merged = mergeCollections(got, { daily: [{ ...got.daily[0], tokensIn: 5, tokensOut: 0, messageCount: 1, costMicros: 10 }], sessions: [] });
    assert.equal(merged.daily.length, 1);
    assert.equal(merged.daily[0].tokensIn, 315);
    assert.equal(merged.daily[0].costMicros, 780);

    // Native whole-turn totals take priority over the last-call widget, and
    // cached tokens are removed from the inclusive input before pricing.
    const multi = { ...second, modelTotals: [
      { model: "gpt-5", inputTokens: 1000, cachedTokens: 400, outputTokens: 100 },
      { model: "claude-sonnet-4", inputTokens: 500, cachedTokens: 0, outputTokens: 50 },
    ] };
    write(file, log([{ kind: 0, v: { sessionId, requests: [multi] } }]));
    const totals = await source.collect(range);
    assert.equal(totals.daily.reduce((n, r) => n + r.tokensIn, 0), 1100);
    assert.equal(totals.daily.reduce((n, r) => n + r.tokensCacheRead, 0), 400);
    assert.equal(totals.daily.reduce((n, r) => n + r.tokensOut, 0), 150);
    const assigned = { ...multi, result: { metadata: { resolvedModel: "gpt-5", toolCallRounds: [
      { id: "gpt-round", modelId: "gpt-5", toolCalls: [{ id: "tool-1", name: "mcp_read" }] },
      { id: "claude-round", modelId: "claude-sonnet-4", toolCalls: [] },
    ] } } };
    write(file, log([{ kind: 0, v: { sessionId, requests: [assigned] } }]));
    const modelRows = scanLocal({ home, vscodeUserDataDirs: [root], ...range, priceOf }).modelActivity;
    assert.equal(modelRows.length, 0,
      "whole-turn totals do not establish complete per-model call counts for efficiency ratios");

    for (const modelTotals of [
      [{ model: "gpt-5", inputTokens: 100, outputTokens: 20 }, { model: "claude-sonnet-4", inputTokens: -1, outputTokens: 5 }],
      [{ model: "gpt-5", inputTokens: 100, outputTokens: 20 }, { model: "gpt-5", inputTokens: 100, outputTokens: 20 }],
    ]) {
      write(file, log([{ kind: 0, v: { sessionId, requests: [{ ...second, modelTotals }] } }]));
      await assert.rejects(() => source.collect(range), /VS Code/, "invalid whole-turn totals silently produced wrong spend");
    }

    // Splice/truncate, delete, and migration copies must not resurrect turns.
    const old = join(root, "User/globalStorage/emptyWindowChatSessions", `${sessionId}.jsonl`);
    write(old, log([{ kind: 0, v: { sessionId, requests: [first, second] } }]));
    utimesSync(old, new Date("2026-09-06T00:00:00Z"), new Date("2026-09-06T00:00:00Z"));
    write(file, log([
      { kind: 0, v: { sessionId, requests: [first, second] } },
      { kind: 2, k: ["requests"], i: 1, v: [] },
      { kind: 3, k: ["requests", 0, "completionTokens"] },
      { kind: 1, k: ["requests", 0, "completionTokens"], v: 25 },
    ]));
    assert.equal((await source.collect(range)).daily[0].tokensOut, 25);

    const foreign = { ...second, requestId: "foreign", modelId: "anthropic/claude-sonnet-4" };
    const delegated = { ...second, requestId: "delegated", result: { metadata: { claudeSessionId: "separate-source" } } };
    write(file, log([{ kind: 0, v: { sessionId, requests: [foreign, delegated] } }]));
    assert.equal((await source.collect(range)).daily.length, 0, "non-Copilot/delegated provider was counted twice");

    const legacy = { ...first, result: { metadata: { resolvedModel: "gpt-5", toolCallRounds: [{}, {}, {}] } } };
    write(file, log([{ kind: 0, v: { sessionId, requests: [legacy] } }]));
    assert.equal(scanVsCode(options).requests[0].lastCallOnly, true);
    assert.equal(scanVsCode(options).requests[0].usages[0].tokensIn, 100, "last-call input must not be multiplied by loop length");
    assert.equal(scanLocal({ home, vscodeUserDataDirs: [root], ...range, priceOf }).modelActivity.length, 0,
      "last-call widget produced authoritative model-efficiency denominators");

    const cumulativeOutput = { ...first, completionTokens: 70, result: { metadata: {
      resolvedModel: "gpt-5", outputTokens: 30,
      toolCallRounds: [{ modelId: "gpt-5" }, { modelId: "gpt-5" }],
    } } };
    write(file, log([{ kind: 0, v: { sessionId, requests: [cumulativeOutput] } }]));
    assert.equal(scanVsCode(options).requests[0].usages[0].tokensOut, 70, "known single-model cumulative output was dropped");
    assert.equal(scanVsCode(options).requests[0].lastCallOnly, true, "output evidence claimed complete input coverage");
    const mixedOutput = structuredClone(cumulativeOutput);
    mixedOutput.result.metadata.toolCallRounds[0].modelId = "claude-sonnet-4";
    write(file, log([{ kind: 0, v: { sessionId, requests: [mixedOutput] } }]));
    assert.equal(scanVsCode(options).requests[0].usages[0].tokensOut, 30, "mixed-model output was assigned entirely to the final model");

    // Consequential activity boundaries: a finished-looking card is not proof
    // of success, and model tool requests without a rendered card still count.
    // These fields follow VS Code 1.135.0's serialized interfaces, not tool
    // result messages or arguments. General toolMetadata/hasError are omitted
    // by LanguageModelToolResult.toJSON and must never fabricate skill events.
    const activity = { ...first, isSystemInitiated: true,
      message: { text: "PRIVATE_PROMPT", parts: [
        { kind: "prompt", name: "review", text: "PRIVATE_PROMPT", uri: "PRIVATE_PATH" },
        { kind: "slash", slashCommand: { command: "explain", detail: "PRIVATE_DESCRIPTION" } },
      ] },
      variableData: { variables: [
        { kind: "generic", name: "design", value: { $mid: "agentHostCompletion", kind: "skill" }, _meta: { uri: "PRIVATE_PATH" } },
        { kind: "generic", name: "fix", value: { $mid: "agentHostCompletion", kind: "command" } },
        { kind: "generic", name: "must-not-count", value: { $mid: "unrelated", kind: "skill" } },
      ] },
      result: { metadata: { resolvedModel: "gpt-5", toolCallRounds: [
        { id: "round-a", modelId: "gpt-5", toolInputRetry: 0, thinking: { tokens: 9, text: "PRIVATE_THINKING" },
          compaction: { type: "compaction", id: "compact-a", encrypted_content: "PRIVATE_COMPACTION" },
          toolCalls: [
            { id: "pass", name: "run_in_terminal", arguments: "PRIVATE_ARGUMENTS" },
            { id: "failed", name: "mcp_read", arguments: "PRIVATE_ARGUMENTS" },
            { id: "denied", name: "write_file", arguments: "PRIVATE_ARGUMENTS" },
            { id: "unknown", name: "run_skill", arguments: "PRIVATE_ARGUMENTS" },
            { id: "hidden", name: "search_tools", arguments: "PRIVATE_ARGUMENTS" },
          ] },
        { id: "round-b", modelId: "gpt-5", toolInputRetry: 1, toolCalls: [] },
      ], summaries: [{ toolCallRoundId: "round-older", outcome: "success", text: "PRIVATE_SUMMARY" }],
        toolCallResults: { unknown: { $mid: 17, content: [{ value: "PRIVATE_OUTPUT" }] } },
      } },
      response: [
        { kind: "toolInvocationSerialized", toolCallId: "pass", toolId: "run_in_terminal", isComplete: true,
          isConfirmed: { type: 1, reason: "PRIVATE_REASON" }, toolSpecificData: { kind: "terminal",
            requestUnsandboxedExecution: true, commandLine: { original: "PRIVATE_COMMAND" },
            terminalCommandOutput: { text: "PRIVATE_OUTPUT" }, terminalCommandState: { exitCode: 0, duration: 10 } } },
        { kind: "toolInvocationSerialized", toolCallId: "failed", toolId: "mcp_read", isComplete: true,
          source: { type: "mcp", serverLabel: "docs" }, resultDetails: { isError: true, input: "PRIVATE_ARGUMENTS", output: "PRIVATE_OUTPUT" } },
        { kind: "toolInvocationSerialized", toolCallId: "denied", toolId: "write_file", isComplete: true, isConfirmed: { type: 0 } },
        { kind: "toolInvocationSerialized", toolCallId: "unknown", toolId: "run_skill", isComplete: true, invocationMessage: "PRIVATE_SKILL_NAME" },
        { kind: "thinking", value: "PRIVATE_THINKING" },
        { value: "PRIVATE_REPLY" },
        { kind: "hook", hookType: "PreToolUse", stopReason: "PRIVATE_HOOK_ERROR" },
        { kind: "hook", hookType: "PostToolUse", systemMessage: "PRIVATE_HOOK_WARNING" },
      ],
    };
    write(file, log([{ kind: 0, v: { sessionId, requests: [activity] } }]));
    const measured = scanVsCode(options).requests[0];
    assert.equal(measured.tools.length, 5, "hidden structured tool request was dropped");
    assert.deepEqual(measured.tools.map((tool) => tool.outcome), ["success", "error", "cancelled", "unknown", "unknown"]);
    assert.equal(measured.tools[0].durationMs, 10);
    assert.equal(measured.tools[1].durationMs, null);
    assert.equal(measured.tools[0].sandboxBypass, true);
    assert.equal(measured.tools[1].model, "gpt-5");
    assert.equal(measured.humanInitiated, false);
    assert.equal(measured.thinkingBlocks, 1);
    assert.equal(measured.textBlocks, 1);
    assert.equal(measured.hookRuns, 2);
    assert.equal(measured.hookErrors, 0, "intentional hook policy block was counted as an execution error");
    assert.equal(measured.compactions, 2);
    assert.equal(measured.toolInputRetries, 1);
    assert.equal(measured.tokensReasoning, 9);
    assert.deepEqual(measured.promptNames, ["review"]);
    assert.deepEqual(measured.explicitCapabilities, [{ kind: "skill", name: "design" }, { kind: "command", name: "fix" }]);
    assert.equal(measured.command, "explain");
    for (const key of ["toolErrors", "toolDurationMs", "tokensIn", "tokensCacheRead", "hookRuns", "linesAdded", "messageCount", "turnMessages", "turnMessagesMax"]) {
      assert(measured.unavailableMetrics.includes(key), `${key} incomplete evidence became a measured zero`);
    }
    assert(!JSON.stringify(replayVsCode([{ kind: 0, v: { sessionId, requests: [activity] } }])).includes("PRIVATE_"));
    assert.deepEqual(scanVsCode(options).requests[0], measured, "activity changes when reread");

    // Saved Cancelled can mean an unfinished request was serialized. Only an
    // explicit legacy cancellation flag or a denied tool proves interruption.
    const noTools = { ...first, response: [], result: { metadata: { resolvedModel: "gpt-5",
      toolCallRounds: [{ modelId: "gpt-5", toolCalls: [] }] } } };
    for (const [label, raw, cancelled, interrupted, unavailable] of [
      ["completed", noTools, false, 0, false],
      ["synthetic cancellation", { ...noTools, modelState: { value: 2 } }, false, 0, true],
      ["state without affirmative flag", { ...noTools, modelState: { value: 2 }, isCanceled: false }, false, 0, true],
      ["explicit cancellation", { ...noTools, modelState: { value: 2 }, isCanceled: true }, true, 1, false],
      ["legacy flag", { ...noTools, isCanceled: true }, true, 1, false],
      ["explicit non-cancellation", { ...noTools, isCanceled: false }, false, 0, false],
    ]) {
      write(file, log([{ kind: 0, v: { sessionId, requests: [raw] } }]));
      const request = scanVsCode(options).requests[0];
      assert.equal(request.cancelled, cancelled, `${label}: request state invented interruption`);
      assert.equal(request.unavailableMetrics.includes("interrupted"), unavailable, `${label}: wrong interruption coverage`);
      const rows = scanLocal({ home, copilotHome: join(home, ".copilot"), vscodeUserDataDirs: [root], ...range, priceOf }).repos;
      assert.equal(rows[0]?.interrupted, interrupted, `${label}: wrong persisted activity count`);
      assert.equal(rows[0]?.unavailableMetrics.includes("interrupted"), unavailable, `${label}: sidecar lost coverage`);
    }
    for (const state of [1, 2]) {
      const denied = { ...noTools, modelState: { value: state }, response: [
        { kind: "toolInvocationSerialized", toolCallId: "denied-control", toolId: "write_file", isConfirmed: false },
      ] };
      write(file, log([{ kind: 0, v: { sessionId, requests: [denied] } }]));
      const request = scanVsCode(options).requests[0];
      assert.equal(request.cancelled, false);
      assert.equal(request.tools[0].outcome, "cancelled", "known tool denial was lost with ambiguous request cancellation");
      const rows = scanLocal({ home, copilotHome: join(home, ".copilot"), vscodeUserDataDirs: [root], ...range, priceOf }).repos;
      assert.equal(rows[0]?.interrupted, 1, "denial must count once without inventing a second request interruption");
      assert.equal(rows[0]?.unavailableMetrics.includes("interrupted"), state === 2);
    }

    // Native IDs have an editor suffix that rendered cards omit. Counting both
    // inflated real subagent runs; stripping all IDs would lose reused calls.
    const launchCard = { kind: "toolInvocationSerialized", toolCallId: "launch", toolId: "runSubagent",
      toolSpecificData: { kind: "subagent", duration: 17, prompt: "PRIVATE_SUBAGENT_PROMPT" },
      resultDetails: { isError: false, output: "PRIVATE_SUBAGENT_OUTPUT" } };
    const nestedCard = { kind: "toolInvocationSerialized", toolCallId: "launch", toolId: "mcp_read",
      subAgentInvocationId: "child-a", source: { type: "mcp", serverLabel: "docs" } };
    const aliases = { ...first, result: { metadata: { resolvedModel: "gpt-5", toolCallRounds: [
      { id: "alias-round", modelId: "gpt-5", toolCalls: [{ id: "launch__vscode-1788776288728", name: "runSubagent" }] },
    ] } }, response: [launchCard, launchCard, nestedCard, nestedCard, { ...nestedCard, subAgentInvocationId: "child-b" }] };
    write(file, log([{ kind: 0, v: { sessionId, requests: [aliases] } }]));
    const aliased = scanVsCode(options).requests[0];
    assert.equal(aliased.tools.length, 3, "native/card alias or nested tool scope duplicated/lost calls");
    assert.equal(aliased.tools.filter((tool) => tool.name === "runSubagent").length, 1);
    assert.equal(aliased.tools[0].outcome, "success");
    assert.equal(aliased.tools[0].durationMs, 17);
    assert.equal(aliased.tools[0].model, "gpt-5");
    const aliasRows = scanLocal({ home, vscodeUserDataDirs: [root], ...range, priceOf });
    assert.equal(aliasRows.repos[0]?.toolCalls, 3, "repo totals did not use deduplicated calls");
    assert.equal(aliasRows.capabilities.find((row) => row.name === "docs")?.invocations, 2,
      "separate subagents sharing a tool ID lost an MCP invocation");
    assert.deepEqual(scanVsCode(options).requests[0], aliased, "alias replay changed counts");

    for (const nativeIds of [["launch__vscode-1", "launch__vscode-2"], ["launch", "launch__vscode-2"]]) {
      const reused = { ...aliases, result: { metadata: { resolvedModel: "gpt-5", toolCallRounds: [
        { id: "reused-round", modelId: "gpt-5", toolCalls: nativeIds.map((id) => ({ id, name: "runSubagent" })) },
      ] } }, response: [launchCard] };
      write(file, log([{ kind: 0, v: { sessionId, requests: [reused] } }]));
      const retained = scanVsCode(options).requests[0];
      assert.equal(retained.tools.length, 2, "reused model IDs collapsed separate native calls");
      assert(retained.tools.every((tool) => tool.outcome === "unknown" && tool.durationMs === null),
        "ambiguous card facts were assigned to an arbitrary native call");
    }
    const unrelated = { ...aliases, result: { metadata: { toolCallRounds: [
      { id: "other-round", toolCalls: [{ id: "launch__vscode-not-a-counter", name: "runSubagent" }] },
    ] } }, response: [launchCard] };
    write(file, log([{ kind: 0, v: { sessionId, requests: [unrelated] } }]));
    assert.equal(scanVsCode(options).requests[0].tools.length, 2, "arbitrary ID prefixes were merged");
    const invalidScope = { ...aliases, response: [{ ...nestedCard, subAgentInvocationId: {} }] };
    write(file, log([{ kind: 0, v: { sessionId, requests: [invalidScope] } }]));
    assert.throws(() => scanVsCode(options), /subagent tool scope/,
      "invalid nested scope was treated as a root-card alias");

    // Existing execution logs can fill missing wall time, but a resolved
    // promise cannot prove semantic success. Session-wide ID collisions must
    // not silently attach another request's or subagent's duration.
    const transcriptFile = join(dir, "../GitHub.copilot-chat/transcripts", `${sessionId}.jsonl`);
    let eventSequence = 0;
    let eventParent = null;
    const event = (type, data, milliseconds) => {
      const id = `event-${++eventSequence}`;
      const record = { id, parentId: eventParent, timestamp: new Date(Date.parse(`${date}T00:00:01Z`) + milliseconds).toISOString(), type, data };
      eventParent = id;
      return record;
    };
    const timingEvents = [event("session.start", { sessionId, version: 1, producer: "copilot-agent" }, 0)];
    for (const [toolCallId, toolName, success, start, end] of [
      ["native", "read_file", true, 10, 30],
      ["nested-unique", "search", false, 40, 70],
      ["launch", "runSubagent", true, 80, 120],
    ]) {
      timingEvents.push(event("tool.execution_start", { toolCallId, toolName, arguments: { secret: "PRIVATE_ARGUMENTS" } }, start));
      timingEvents.push(event("tool.execution_complete", { toolCallId, success, result: { content: "PRIVATE_OUTPUT" } }, end));
    }
    write(transcriptFile, log(timingEvents));
    const timingRequest = { ...first, result: { metadata: { resolvedModel: "gpt-5", toolCallRounds: [
      { id: "timing-round", modelId: "gpt-5", toolCalls: [{ id: "native__vscode-99", name: "read_file" }, { id: "launch__vscode-100", name: "runSubagent" }] },
    ] } }, response: [
      { kind: "toolInvocationSerialized", toolCallId: "native", toolId: "readFile" },
      { kind: "toolInvocationSerialized", toolCallId: "nested-unique", toolId: "search", subAgentInvocationId: "child-a" },
      launchCard,
    ] };
    write(file, log([{ kind: 0, v: { sessionId, requests: [timingRequest] } }]));
    const timedScan = scanVsCode(options);
    const timedRequest = timedScan.requests[0];
    assert.equal(timedRequest.tools.length, 3, "timing logs introduced extra calls");
    assert.equal(timedRequest.tools.find((tool) => tool.name === "readFile").durationMs, 20);
    assert.equal(timedRequest.tools.find((tool) => tool.name === "search").durationMs, 30);
    assert.equal(timedRequest.tools.find((tool) => tool.name === "runSubagent").durationMs, 17, "invocation wall time replaced the more specific saved timer");
    assert.equal(timedRequest.tools.find((tool) => tool.name === "readFile").outcome, "unknown", "resolved promise became semantic success");
    assert.equal(timedRequest.tools.find((tool) => tool.name === "search").outcome, "unknown", "rejected promise invented a failure/cancellation distinction");
    assert(timedRequest.unavailableMetrics.includes("toolErrors"));
    assert(!timedRequest.unavailableMetrics.includes("toolDurationMs"));
    const timedLocal = scanLocal({ home, vscodeUserDataDirs: [root], ...range, priceOf });
    assert.equal(timedLocal.repos[0]?.toolTimed, 3);
    assert.equal(timedLocal.repos[0]?.toolDurationMs, 67);
    assert.equal(timedLocal.repos[0]?.toolCalls, 3);
    assert(!JSON.stringify({ timedScan, timedLocal }).includes("PRIVATE_"));
    assert.deepEqual(scanVsCode(options), timedScan, "timing reread changed observed activity");
    const timingUsage = await source.collect(range);
    const olderReuse = { ...before, result: timingRequest.result, response: [timingRequest.response[0]] };
    write(file, log([{ kind: 0, v: { sessionId, requests: [olderReuse, timingRequest] } }]));
    assert.equal(scanVsCode(options).requests[0].tools.find((tool) => tool.name === "readFile").durationMs, null,
      "ID reuse outside the requested date range attached an ambiguous interval");
    const afterRewind = { ...timingRequest, requestId: "request-after-rewind", timestamp: timingRequest.timestamp + 1000 };
    write(file, log([{ kind: 0, v: { sessionId, requests: [afterRewind] } }]));
    assert.equal(scanVsCode(options).requests[0].tools.find((tool) => tool.name === "readFile").durationMs, null,
      "an interval from a deleted older request attached to a newer reused ID");
    const nestedReuse = { ...timingRequest, response: [...timingRequest.response, { ...timingRequest.response[1], subAgentInvocationId: "child-b" }] };
    write(file, log([{ kind: 0, v: { sessionId, requests: [nestedReuse] } }]));
    assert(scanVsCode(options).requests[0].tools.filter((tool) => tool.name === "search").every((tool) => tool.durationMs === null),
      "one transcript interval was assigned to multiple child-agent calls");
    write(file, log([{ kind: 0, v: { sessionId, requests: [timingRequest] } }]));
    write(transcriptFile, log([...timingEvents, event("tool.execution_start", { toolCallId: "native", toolName: "read_file" }, 130)]));
    assert.equal(scanVsCode(options).requests[0].tools.find((tool) => tool.name === "readFile").durationMs, null,
      "an unfinished reused transcript ID was treated as uniquely paired");
    rmSync(transcriptFile);
    assert.deepEqual(await source.collect(range), timingUsage, "additional timing evidence changed token usage or spend");

    // Missing serialized responses cannot establish zero failures or zero
    // elapsed tool time, even when a model-call round survived separately.
    const noResponse = { ...first, response: undefined };
    write(file, log([{ kind: 0, v: { sessionId, requests: [noResponse] } }]));
    const missing = scanVsCode(options).requests[0];
    for (const key of ["toolCalls", "toolErrors", "interrupted", "toolTimed", "toolDurationMs", "messageCount", "turnMessages", "turnMessagesMax"]) {
      assert(missing.unavailableMetrics.includes(key), `${key} missing response became a measured zero`);
    }

    // Broken capability collection or ignored disablement would misreport skill
    // adoption. The production inventory must use VS Code's roots/settings,
    // not the CLI's broader ancestor walk, and never forward SQLite contents.
    const skill = (directory, metadata = "") => write(join(directory, "SKILL.md"), `---\nname: wrong-frontmatter-name\ndescription: PRIVATE_DESCRIPTION\n${metadata}---\nPRIVATE_SKILL_BODY\n`);
    const rootSkills = join(repo, ".agents/skills");
    skill(join(rootSkills, "review"));
    skill(join(rootSkills, "background"), "user-invocable: false\n");
    skill(join(rootSkills, "disabled"), "user-invocable: false\ndisable-model-invocation: true\n");
    skill(join(rootSkills, "profile-disabled"));
    skill(join(rootSkills, "home-only"));
    skill(join(home, ".claude/skills/personal"));
    skill(join(home, "extra-skills/custom"));
    skill(join(repo, ".github/skills/root-disabled"));
    write(join(repo, ".github/prompts/explain.prompt.md"), "---\nname: explain\ndescription: PRIVATE_PROMPT_DESCRIPTION\n---\nPRIVATE_PROMPT_BODY\n");
    write(join(home, "custom-prompts/custom-command.prompt.md"), "PRIVATE_PROMPT_BODY\n");
    write(join(home, "single-command.prompt.md"), "PRIVATE_PROMPT_BODY\n");
    write(join(home, "star-prompts/star-kept.prompt.md"), "PRIVATE_PROMPT_BODY\n");
    write(join(home, "star-prompts/.gitignore"), "star-kept.prompt.md\n");
    write(join(home, "star-prompts/nested/star-nested.prompt.md"), "PRIVATE_PROMPT_BODY\n");
    write(join(home, "complex-prompts/nested/unsupported-glob.prompt.md"), "PRIVATE_PROMPT_BODY\n");
    const userSettings = {
      "chat.agentSkillsLocations": { ".github/skills": false, "~/extra-skills": true },
      "chat.promptFilesLocations": { [join(home, "custom-prompts")]: true, "~/single-command.prompt.md": true,
        "~/star-prompts/*": true, "~/complex-prompts/**/*.prompt.md": true },
      "files.exclude": { "**/star-kept.prompt.md": true },
    };
    write(join(root, "User/settings.json"), JSON.stringify(userSettings));
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    const disabledFile = join(rootSkills, "profile-disabled/SKILL.md");
    try {
      db.run("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)");
      db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", ["chat.disabledPromptFiles.skill", JSON.stringify([pathToFileURL(disabledFile).toJSON()])]);
      db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", ["PRIVATE_UNRELATED_ACCOUNT", "PRIVATE_CREDENTIAL_NOT_JSON"]);
      write(join(root, "User/globalStorage/state.vscdb"), db.export());
    } finally { db.close(); }
    // Windows needs junctions for directories, avoiding developer-mode-only symlinks.
    symlinkSync(join(rootSkills, "review"), join(rootSkills, "review-alias"), process.platform === "win32" ? "junction" : "dir");
    const inventoryOptions = { home, userDataDirs: [root], cwds: [repo] };
    const installed = vsCodeCapabilityInventory(inventoryOptions);
    assert(installed.skills.has("review"), "canonical skill directory name was lost");
    assert(!installed.skills.has("wrong-frontmatter-name"));
    assert(installed.skills.has("background"));
    assert(!installed.typedSkills.has("background"), "hidden skill became user-invocable");
    assert(!installed.skills.has("disabled"));
    assert(!installed.skills.has("profile-disabled"), "profile-disabled skill reported as loadable");
    assert(!installed.skills.has("root-disabled"), "disabled root was inventoried");
    assert(installed.skills.has("personal"));
    assert(installed.skills.has("custom"));
    assert(installed.commands.has("custom-command"));
    assert(installed.commands.has("single-command"));
    assert(installed.commands.has("star-kept"), "terminal /* did not use the editor's direct-folder discovery");
    assert(!installed.commands.has("star-nested"), "terminal /* incorrectly searched nested directories");
    assert(!installed.commands.has("unsupported-glob"), "full glob was partially interpreted as a literal folder");
    assert.equal(installed.complete, false, "unsupported full-glob discovery claimed exhaustive inventory");
    assert.equal(installed.skills.get("review")?.realPath, realpathSync(join(rootSkills, "review")));
    assert.equal(installed.skills.get("review-alias")?.alias, true, "symlink counted as a second idle artifact");
    assert(!JSON.stringify([...installed.skills.values(), ...installed.commands.values()]).includes("PRIVATE_"));
    const invocationRequest = { command: "explain", promptNames: ["review", "background", "unknown", "explain"],
      explicitCapabilities: [{ kind: "skill", name: "review" }, { kind: "command", name: "fix" }],
      tools: [{ id: "mcp-a", server: "docs", skill: "must-not-infer" }, { id: "mcp-a", server: "docs" }],
    };
    Object.defineProperty(invocationRequest, "message", { get() { throw new Error("read private prompt"); } });
    assert.deepEqual(vsCodeCapabilityInvocations(invocationRequest, installed), [
      { kind: "skill", name: "review", trigger: "typed" },
      { kind: "command", name: "fix", trigger: "typed" },
      { kind: "command", name: "explain", trigger: "typed" },
      { kind: "mcp", name: "docs", trigger: null },
    ], "typed capability metadata duplicated or guessed an unavailable trigger");

    // Literal plugin roots are authorized configuration, not a cache scan.
    // Both profile and workspace enablement must be read before scanning them.
    const pluginRoot = join(home, "configured-plugins");
    const enabledPlugin = join(pluginRoot, "enabled");
    const profileOff = join(pluginRoot, "profile-off");
    const workspaceOff = join(pluginRoot, "workspace-off");
    const workspaceOn = join(pluginRoot, "workspace-on");
    for (const [path, name] of [[enabledPlugin, "Review Kit"], [profileOff, "Profile Off"], [workspaceOff, "Workspace Off"], [workspaceOn, "Workspace On"]]) {
      write(join(path, "plugin.json"), JSON.stringify({ name, mcpServers: { private: { token: "PRIVATE_PLUGIN_SECRET" } } }));
      skill(join(path, "skills/analyze"));
      write(join(path, "commands/run.md"), "PRIVATE_PLUGIN_COMMAND\n");
    }
    const customPlugin = join(pluginRoot, "custom");
    write(join(customPlugin, ".plugin/plugin.json"), JSON.stringify({ name: "Component Kit",
      skills: { paths: ["custom-skills", "../outside-skills"], exclusive: true }, commands: ["extra-commands"] }));
    skill(join(customPlugin, "skills/excluded-default"));
    skill(join(customPlugin, "custom-skills/component"));
    skill(join(pluginRoot, "outside-skills/escape"));
    write(join(customPlugin, "commands/default.md"), "PRIVATE_PLUGIN_COMMAND\n");
    write(join(customPlugin, "extra-commands/custom.md"), "PRIVATE_PLUGIN_COMMAND\n");
    const claudePlugin = join(pluginRoot, "claude-root");
    write(join(claudePlugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "Claude Kit" }));
    skill(claudePlugin);
    const schemaPlugin = join(pluginRoot, "schema-kit");
    write(join(schemaPlugin, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "Schema Kit",
      extensions: { "com.github.copilot": { skills: { paths: ["custom"], exclusive: true }, commands: { paths: ["prompts"], exclusive: true } } },
    }));
    skill(join(schemaPlugin, "skills/excluded-schema-default"));
    skill(join(schemaPlugin, "com.github.copilot/custom/within"));
    write(join(schemaPlugin, "com.github.copilot/prompts/schema.md"), "PRIVATE_PLUGIN_COMMAND\n");
    symlinkSync(join(pluginRoot, "outside-skills/escape"), join(schemaPlugin, "com.github.copilot/custom/escape"), process.platform === "win32" ? "junction" : "dir");
    const saveCapabilityState = (path, rows) => {
      const state = new SQL.Database();
      try {
        state.run("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)");
        for (const [key, value] of rows) state.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [key, value]);
        write(path, state.export());
      } finally { state.close(); }
    };
    const profileStateFile = join(root, "User/globalStorage/state.vscdb");
    const profileRows = [
      ["chat.disabledPromptFiles.skill", JSON.stringify([pathToFileURL(disabledFile).href])],
      ["agentPlugins.enablement", JSON.stringify([[pathToFileURL(profileOff).href, false], [pathToFileURL(workspaceOn).href, false]])],
      ["PRIVATE_UNRELATED_ACCOUNT", "PRIVATE_CREDENTIAL_NOT_JSON"],
    ];
    saveCapabilityState(profileStateFile, profileRows);
    const workspaceStateFile = join(root, "User/workspaceStorage/workspace/state.vscdb");
    saveCapabilityState(workspaceStateFile, [["agentPlugins.enablement", JSON.stringify([
      [pathToFileURL(workspaceOff).href, false], [pathToFileURL(workspaceOn).href, true],
    ])]]);
    skill(join(repo, "blank-location-skill"));
    skill(join(repo, "~invalid-location/invalid-tilde"));
    const pluginSettings = { ...userSettings,
      "chat.agentSkillsLocations": { ...userSettings["chat.agentSkillsLocations"], "": true, "~invalid-location": true },
      "chat.pluginLocations": Object.fromEntries([enabledPlugin, profileOff, workspaceOff, workspaceOn, customPlugin, claudePlugin, schemaPlugin].map((path) => [path, true])),
    };
    write(join(root, "User/settings.json"), JSON.stringify(pluginSettings));
    const plugins = vsCodeCapabilityInventory(inventoryOptions);
    assert(plugins.skills.has("review-kit:analyze"), "configured plugin skill was not discovered");
    assert(plugins.typedSkills.has("review-kit:analyze"), "plugin slash namespace was lost");
    assert(!plugins.typedSkills.has("analyze"), "bare plugin alias became an invented slash command");
    assert(plugins.commands.has("review-kit:run"));
    assert(!plugins.skills.has("profile-off:analyze"), "profile-disabled plugin was loaded");
    assert(!plugins.skills.has("workspace-off:analyze"), "workspace disablement failed to override profile default");
    assert(plugins.skills.has("workspace-on:analyze"), "workspace enablement failed to override profile disablement");
    assert(plugins.skills.has("component-kit:component"));
    assert(!plugins.skills.has("component-kit:excluded-default"), "exclusive component locations retained their default");
    assert(!plugins.skills.has("component-kit:escape"), "plugin component path escaped its configured root");
    assert(plugins.commands.has("component-kit:default"));
    assert(plugins.commands.has("component-kit:custom"), "additive custom command paths replaced defaults");
    assert(plugins.skills.has("claude-kit:claude-root"), "legacy root-level plugin skill fallback was lost");
    assert(plugins.skills.has("schema-kit:within"));
    assert(plugins.commands.has("schema-kit:schema"));
    assert(!plugins.skills.has("schema-kit:escape"), "schema plugin followed an out-of-root skill symlink");
    assert(!plugins.skills.has("schema-kit:excluded-schema-default"));
    assert(!plugins.skills.has("blank-location-skill"), "empty skill location scanned the workspace root");
    assert(!plugins.skills.has("invalid-tilde"), "invalid tilde skill location was accepted");
    assert(!JSON.stringify([...plugins.skills.values(), ...plugins.commands.values()]).includes("PRIVATE_"));
    assert.deepEqual(vsCodeCapabilityInvocations({ tools: [], promptNames: ["review-kit:analyze", "review-kit:run"] }, plugins), [
      { kind: "skill", name: "review-kit:analyze", trigger: "typed" },
      { kind: "command", name: "review-kit:run", trigger: "typed" },
    ]);
    write(join(root, "User/settings.json"), JSON.stringify({ ...pluginSettings, "chat.plugins.enabled": false }));
    const pluginsOff = vsCodeCapabilityInventory(inventoryOptions);
    assert([...pluginsOff.skills.values(), ...pluginsOff.commands.values()].every((entry) => entry.source !== "plugin"), "disabled plugin feature still reported plugin inventory");
    saveCapabilityState(profileStateFile, [["agentPlugins.enablement", JSON.stringify([[pathToFileURL(profileOff).href, "PRIVATE_NOT_BOOLEAN"]])]]);
    assert.throws(() => vsCodeCapabilityInventory(inventoryOptions), /Cannot read VS Code capability enablement/,
      "malformed enablement was treated as enabled");
    saveCapabilityState(profileStateFile, profileRows);
    write(join(root, "User/settings.json"), JSON.stringify(userSettings));
    const nested = join(repo, "nested"); mkdirSync(nested);
    mkdirSync(join(repo, ".git"));
    assert(!vsCodeCapabilityInventory({ ...inventoryOptions, cwds: [nested] }).skills.has("review"), "parent discovery ran without the editor setting");
    write(join(nested, ".vscode/settings.json"), JSON.stringify({ "chat.useCustomizationsInParentRepositories": true }));
    assert(vsCodeCapabilityInventory({ ...inventoryOptions, cwds: [nested] }).skills.has("review"));
    write(join(repo, ".vscode/settings.json"), JSON.stringify({ "chat.useAgentSkills": false }));
    assert.equal(vsCodeCapabilityInventory(inventoryOptions).skills.size, 0, "disabled skill feature was ignored");
    write(join(root, "User/globalStorage/state.vscdb"), "PRIVATE_CORRUPT_DB");
    assert.throws(() => vsCodeCapabilityInventory(inventoryOptions), /Cannot read VS Code capability enablement/);
    rmSync(join(root, "User/globalStorage/state.vscdb"));

    // Error flags can arrive as mutations; cancelling a request must not turn
    // every previously successful tool into a tool failure.
    write(file, log([{ kind: 0, v: { sessionId, requests: [activity] } },
      { kind: 1, k: ["requests", 0, "modelState", "value"], v: 2 },
      { kind: 1, k: ["requests", 0, "isCanceled"], v: true },
      { kind: 1, k: ["requests", 0, "response", 1, "resultDetails", "isError"], v: false },
      { kind: 1, k: ["requests", 0, "response", 2, "isConfirmed"], v: false },
    ]));
    const changed = scanVsCode(options).requests[0];
    assert.equal(changed.cancelled, true);
    assert.equal(changed.tools[0].outcome, "success");
    assert.equal(changed.tools[1].outcome, "success");
    assert.equal(changed.tools[2].outcome, "cancelled");

    const guarded = { sessionId, requests: [structuredClone(first)] };
    Object.defineProperty(guarded.requests[0].message, "text", { get() { throw new Error("read private prompt"); } });
    Object.defineProperty(guarded.requests[0].response[0], "invocationMessage", { get() { throw new Error("read private tool message"); } });
    Object.defineProperty(guarded.requests[0].response[0].resultDetails, "output", { get() { throw new Error("read private output"); } });
    const marker = { kind: "hook" };
    Object.defineProperty(marker, "stopReason", { get() { throw new Error("read private hook reason"); } });
    guarded.requests[0].response = [...guarded.requests[0].response, marker];
    const privateMutation = { kind: 1, k: ["requests", 0, "message", "text"] };
    Object.defineProperty(privateMutation, "v", { get() { throw new Error("read private mutation"); } });
    const presenceMutation = { kind: 2, k: ["requests", 0, "response", 1, "stopReason"] };
    Object.defineProperty(presenceMutation, "v", { get() { throw new Error("read private presence mutation"); } });
    const state = replayVsCode([{ kind: 0, v: guarded }, privateMutation, presenceMutation, { kind: 1, k: ["__proto__", "polluted"], v: true }]);
    assert(!JSON.stringify(state).includes("PRIVATE_"));
    assert.equal({}.polluted, undefined);
    write(file, log([{ kind: 0, v: initial }]) + 'broken\n' + log([{ kind: 2, k: ["requests"], v: [second] }]));
    await assert.rejects(() => source.collect(range), /Invalid VS Code/);
    assert.deepEqual(vsCodeDataDirs({ home, platform: "linux", env: {} }), [join(home, ".config/Code"), join(home, ".config/Code - Insiders")]);
    assert.deepEqual(vsCodeDataDirs({ home, platform: "win32", env: { APPDATA: "/fixture-roaming" } }), [join("/fixture-roaming", "Code"), join("/fixture-roaming", "Code - Insiders")]);
    assert.deepEqual(vsCodeDataDirs({ env: { VSCODE_PORTABLE: "/fixture-portable" } }), [join("/fixture-portable", "user-data")]);

    // Coverage must survive the inventory's latest-day anchor and suppression
    // of idle rows for fired artifacts. Otherwise older VS Code activity turns
    // into apparently complete CLI skill adoption on the next active day.
    const cliHome = join(home, ".copilot");
    for (const name of ["mixed-fired", "mixed-idle"]) {
      write(join(cliHome, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\nPRIVATE_BODY\n`);
    }
    const mixedDays = new CapabilityCollector({ home, copilotHome: cliHome,
      vscodeUserDataDirs: [root], since: date, until: "2026-09-08" });
    mixedDays.vscode(measured);
    mixedDays.copilotVisitor().record({ id: "mixed-invocation", timestamp: "2026-09-08T12:00:00Z",
      type: "skill.invoked", data: { name: "mixed-fired", trigger: "agent-invoked", content: "PRIVATE_BODY" } });
    const mixedRows = mixedDays.finish();
    const firedRow = mixedRows.find((row) => row.agent === "copilot" && row.kind === "skill" && row.name === "mixed-fired" && row.date === "2026-09-08");
    const idleRow = mixedRows.find((row) => row.agent === "copilot" && row.kind === "skill" && row.name === "mixed-idle" && row.date === "2026-09-08");
    const earlierFired = mixedRows.find((row) => row.agent === "copilot" && row.kind === "skill" && row.name === "mixed-fired" && row.date === date);
    const earlierIdle = mixedRows.find((row) => row.agent === "copilot" && row.kind === "skill" && row.name === "mixed-idle" && row.date === date);
    assert.equal(firedRow?.date, "2026-09-08");
    assert.equal(firedRow?.invocations, 1, "known CLI invocation was lost when marking incomplete coverage");
    assert.equal(idleRow?.date, "2026-09-08");
    assert.equal(idleRow?.invocations, 0);
    assert.equal(earlierFired?.invocations, 0, "VS Code-day coverage row for a later-fired skill is missing");
    assert.equal(earlierIdle?.invocations, 0, "VS Code-day coverage row for an idle skill is missing");
    assert.equal(mixedRows.filter((row) => row.name === "mixed-fired").reduce((sum, row) => sum + row.invocations, 0), 1,
      "coverage rows duplicated observed invocation counts");
    for (const row of [firedRow, idleRow, earlierFired, earlierIdle]) {
      assert(row?.unavailableMetrics.includes("invocations"), "older VS Code skill coverage was lost on a later CLI day");
      assert(row.unavailableMetrics.includes("triggerModel"), "unknown VS Code automatic triggers became complete");
      assert(row.unavailableMetrics.includes("contextTokens"), "missing skill-body usage became a measured zero");
    }
    assert.deepEqual(mixedDays.finish(), mixedRows, "finishing mixed-day coverage twice changed rows");
    const laterOnly = new CapabilityCollector({ home, copilotHome: cliHome,
      vscodeUserDataDirs: [root], since: "2026-09-08", until: "2026-09-08" });
    laterOnly.copilotVisitor().record({ id: "mixed-invocation", timestamp: "2026-09-08T12:00:00Z",
      type: "skill.invoked", data: { name: "mixed-fired", trigger: "agent-invoked", content: "PRIVATE_BODY" } });
    const laterRows = laterOnly.finish();
    assert(laterRows.every((row) => row.date === "2026-09-08"), "later push would overwrite historical VS Code coverage");
    assert(!laterRows.find((row) => row.name === "mixed-fired")?.unavailableMetrics.includes("invocations"),
      "CLI-only day lost its observable invocation coverage");
    console.log("OK  VS Code fixtures: mutation replay, provider scope, dedup, shared grain, tokens and privacy");
  } finally { rmSync(home, { recursive: true, force: true }); }
}
