import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ciSessionKey } from "../ci-identity.js";
import { ciReceiptSchema, transcriptRevision, type CiReceipt } from "../ci-receipt.js";
import { ClaudeTokenReader } from "./claude.js";
import { CodexTokenReader, codexItem, codexTool, object } from "./codex.js";
import { PricingContext, type PricingRef } from "./pricing.js";
import { readTranscripts, type Rec, type TranscriptFile } from "./transcripts.js";
import { TranscriptDeduper } from "./transcript-dedup.js";
import type { CiAgent, CiTokens } from "./ci-stream.js";

const MAX_RECORD = 8 * 1024 * 1024;
const MAX_SESSIONS = 100;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const modelName = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const zero = (): CiTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null });
const buckets = ["input", "output", "cacheRead", "cacheWrite"] as const;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function optionalObject(value: unknown): Rec {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid CI accounting record.");
  return value as Rec;
}
function add(a: CiTokens, b: CiTokens) {
  for (const key of buckets) {
    a[key] += b[key];
    if (!integer(a[key])) throw new Error("CI transcript counters exceed the supported limit.");
  }
  if (b.reasoning !== null) a.reasoning = (a.reasoning ?? 0) + b.reasoning;
}
function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Explicit job roots only. Never follow a link into a different agent home. */
function filesIn(root: string): TranscriptFile[] {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error();
  const files: TranscriptFile[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 64) throw new Error();
    for (const name of readdirSync(dir).sort()) {
      if (++visited > 100_000) throw new Error();
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error();
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (name.endsWith(".jsonl")) {
        if (!stat.isFile() || files.length >= 10_000) throw new Error();
        files.push({ path, mtimeMs: stat.mtimeMs });
      }
    }
  };
  walk(realpathSync(root), 0);
  return files;
}

interface Session {
  key: string;
  startedAt: string;
  observed: boolean;
  tokens: CiTokens;
  hasUsage: boolean;
  models: Map<string, { ref: PricingRef; tokens: CiTokens }>;
  unsupportedModel: boolean;
  activity: { toolCalls: number; toolErrors: number };
}
type CiPricing = Pick<PricingContext, "prefetch" | "knownCostMicros">;

/** Parse persisted structured records, never prompts, tool arguments or output. */
export async function collectCiTranscripts(options: {
  agent: CiAgent; sessionsDir: string; pricing?: CiPricing;
}): Promise<CiReceipt[]> {
  const { agent } = options;
  let files: TranscriptFile[];
  try { files = filesIn(options.sessionsDir); }
  catch { throw new Error("Cannot scan CI sessions. Use an existing job-only directory without symlinks or special files."); }
  if (!files.length) throw new Error("No CI transcript files found. Ephemeral runs require kibble run.");
  const before = files.map((file) => lstatSync(file.path));
  const sessions = new Map<string, Session>();
  const claude = new ClaudeTokenReader({ dedupScope: "global", updates: "monotonic" });
  const codex = new CodexTokenReader();
  const seen = new TranscriptDeduper();
  let codexSession: string | null = null;
  let observed = 0;
  const at = (id: unknown, date: unknown, observed = true): Session => {
    const startedAt = timestamp(date);
    if (!identifier(id) || !startedAt) throw new Error("Missing CI session identity or timestamp.");
    const key = ciSessionKey(agent, id);
    let session = sessions.get(key);
    if (!session) {
      if (sessions.size >= MAX_SESSIONS) throw new Error("Collect at most 100 CI sessions per directory.");
      session = { key, startedAt, observed: false, tokens: zero(), hasUsage: false, models: new Map(), unsupportedModel: false,
        activity: { toolCalls: 0, toolErrors: 0 } };
      sessions.set(key, session);
    }
    session.observed ||= observed;
    if (startedAt < session.startedAt) session.startedAt = startedAt;
    return session;
  };
  const usage = (session: Session, tokens: CiTokens, model: string | null, provider?: string) => {
    add(session.tokens, tokens);
    session.hasUsage = true;
    if (!model || !modelName(model) || (provider && !modelName(provider))) {
      session.unsupportedModel = true;
      return;
    }
    const key = JSON.stringify([model, provider ?? ""]);
    let row = session.models.get(key);
    if (!row) {
      if (session.models.size >= 128) throw new Error("Too many CI models in one session.");
      row = { ref: { model, provider }, tokens: zero() };
      session.models.set(key, row);
    }
    add(row.tokens, tokens);
  };
  const tool = (session: Session, id: unknown, failed = false) => {
    if (!identifier(id)) throw new Error("Missing CI tool identity.");
    if (seen.first(failed ? "error" : "tool", session.key, id)) {
      if (failed) session.activity.toolErrors++;
      else session.activity.toolCalls++;
    }
  };
  // Strict checks precede the shared decoder, whose legacy callers tolerate old
  // counters. A malformed file must never replace a previously valid CI receipt.
  const validate = (record: Rec, keys: string[]) => {
    for (const key of keys) if (record[key] !== undefined && !integer(record[key])) throw new Error("Invalid CI token count.");
  };
  const readClaude = (record: Rec) => {
    if (record.type === "session_meta" || record.type === "result") throw new Error("Use native Claude transcript files.");
    if (!["assistant", "user", "system"].includes(String(record.type))) return;
    if (!record.sessionId) {
      if (record.type === "assistant" || record.type === "user") throw new Error("Missing CI session identity.");
      return;
    }
    const session = at(record.sessionId, record.timestamp);
    const message = object(record.message);
    if (record.type === "assistant") {
      const raw = optionalObject(message.usage);
      if (Object.keys(raw).length) {
        validate(raw, ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]);
        if (!integer(raw.input_tokens) || !integer(raw.output_tokens)) throw new Error("Incomplete CI token count.");
        if (!identifier(record.requestId ?? message.id)) throw new Error("Missing CI response identity.");
      }
      const sample = claude.read(record);
      if (sample) usage(session, { input: sample.usage.input_tokens ?? 0, output: sample.usage.output_tokens ?? 0,
        cacheRead: sample.usage.cache_read_input_tokens ?? 0, cacheWrite: sample.usage.cache_creation_input_tokens ?? 0,
        reasoning: null }, sample.model);
    }
    if (record.type === "assistant" || record.type === "user") {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        const b = object(block);
        if (record.type === "assistant" && b.type === "tool_use") tool(session, b.id);
        if (record.type === "user" && b.type === "tool_result" && b.is_error === true) tool(session, b.tool_use_id, true);
      }
    }
  };
  const readCodex = (record: Rec) => {
    const p = object(record.payload);
    if (["thread.started", "turn.completed", "result"].includes(String(record.type))) throw new Error("Use native Codex transcript files.");
    if (record.type === "session_meta") {
      codexSession = identifier(p.id) ? p.id : null;
      at(codexSession, p.timestamp ?? record.timestamp, false);
    } else if (codexSession && ["turn_context", "event_msg", "response_item"].includes(String(record.type))) {
      at(codexSession, record.timestamp);
    }
    const isUsage = record.type === "event_msg" && p.type === "token_count";
    if (isUsage) {
      if (!codexSession) throw new Error("Missing CI session header.");
      const info = optionalObject(p.info);
      for (const raw of [optionalObject(info.last_token_usage), optionalObject(info.total_token_usage)]) {
        if (!Object.keys(raw).length) continue;
        validate(raw, ["input_tokens", "output_tokens", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens", "total_tokens"]);
        if (!integer(raw.input_tokens) || !integer(raw.output_tokens) ||
          Number(raw.cached_input_tokens ?? 0) + Number(raw.cache_write_input_tokens ?? 0) > raw.input_tokens ||
          Number(raw.reasoning_output_tokens ?? 0) > raw.output_tokens) throw new Error("Invalid CI token buckets.");
      }
    }
    const sample = codex.read(record);
    if (sample) usage(at(sample.session, record.timestamp), {
      input: sample.usage.input_tokens ?? 0, output: sample.usage.output_tokens ?? 0,
      cacheRead: sample.usage.cache_read_input_tokens ?? 0, cacheWrite: sample.usage.cache_creation_input_tokens ?? 0,
      reasoning: sample.reasoning,
    }, sample.model, sample.provider);
    const item = codexItem(record);
    if (item && codexTool(item)) {
      const session = at(codexSession, record.timestamp);
      tool(session, item.id);
      if (["failed", "declined"].includes(String(item.status)) ||
        (typeof item.exit_code === "number" && item.exit_code !== 0)) tool(session, item.id, true);
    }
  };
  try {
    readTranscripts(files, [{
      startFile(file) { codex.startFile(file); codexSession = null; },
      record(record) {
        if (++observed > 1_000_000) throw new Error("CI transcript record limit exceeded.");
        if (agent === "codex") readCodex(record); else readClaude(record);
      },
    }], { strict: true, maxLineBytes: MAX_RECORD });
    const after = filesIn(options.sessionsDir);
    if (after.length !== files.length || after.some((file, i) => file.path !== files[i]!.path)) throw new Error();
    for (const [i, file] of files.entries()) {
      const current = lstatSync(file.path), previous = before[i]!;
      if (current.dev !== previous.dev || current.ino !== previous.ino || current.size !== previous.size || current.mtimeMs !== previous.mtimeMs) throw new Error();
    }
  } catch {
    throw new Error("CI transcript collection failed. Files must be valid, stable native JSONL with session identities and token counts. Stop the agents before collecting; nothing uploaded.");
  }
  // A rollout can begin with a provisional header immediately replaced by the
  // actual session header. Metadata alone is not a second execution.
  for (const [key, session] of sessions) if (!session.observed) sessions.delete(key);
  if (!sessions.size) throw new Error("No supported CI sessions found; nothing uploaded.");
  const pricing = options.pricing ?? new PricingContext();
  let priced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pricing.prefetch([...sessions.values()].flatMap((session) => [...session.models.values()]
        .filter((row) => row.ref.model !== "unknown").map((row) => row.ref))),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 10_000); }),
    ]);
    priced = true;
  } catch { /* Observed tokens remain reportable when prices are unavailable. */ }
  finally { clearTimeout(timer); }
  const receipts: CiReceipt[] = [];
  for (const session of sessions.values()) {
    const models = new Map<string, CiReceipt["models"][number]>();
    for (const row of session.models.values()) {
      const { input, output, cacheRead, cacheWrite } = row.tokens;
      const cost = priced && row.ref.model !== "unknown" ? pricing.knownCostMicros(row.ref, { input, output, cacheRead, cacheWrite }) : null;
      let model = models.get(row.ref.model);
      if (!model) {
        model = { model: row.ref.model, ...zero(), costMicros: 0 };
        models.set(row.ref.model, model);
      }
      add(model, row.tokens);
      model.costMicros = cost === null || model.costMicros === null ? null : model.costMicros + cost;
    }
    const rows = [...models.values()].sort((a, b) => a.model.localeCompare(b.model));
    const costMicros = !session.hasUsage || session.unsupportedModel || rows.some((row) => row.costMicros === null)
      ? null : rows.reduce((sum, row) => sum + row.costMicros!, 0);
    const tokens = session.hasUsage ? session.tokens : null;
    receipts.push(ciReceiptSchema.parse({ schemaVersion: 1, source: "transcript", runId: session.key, sessionKey: session.key,
      revision: transcriptRevision({ tokens, activity: session.activity }), agent, accountingScope: "recorded_session",
      startedAt: session.startedAt, endedAt: null, durationMs: null, outcome: "unknown",
      process: { exitCode: null, signal: null, forwardedSignal: null }, agentResult: null,
      usageStatus: tokens ? "partial" : "unavailable", tokens, models: rows, costMicros,
      costBasis: costMicros === null ? "unavailable" : "list_price_estimate", activity: session.activity,
      issues: ["transcript_usage_only", ...(session.unsupportedModel ? ["unsupported_model_name"] : [])],
    }));
  }
  return receipts.sort((a, b) => a.runId.localeCompare(b.runId));
}
