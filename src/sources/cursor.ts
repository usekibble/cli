import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readCursorLog } from "./cursor-log.js";
import { PricingContext } from "./pricing.js";
import { repoName } from "./repo.js";
import { readCursorTools, type CursorToolSample } from "./cursor-tools.js";
import { readCursorActivity, type CursorActivitySample } from "./cursor-activity.js";
import type { CollectOptions, CollectResult, NormalizedDailyUsage, SessionRef, SourceContext, UsageSource } from "./types.js";

/** Only this compact counts record is persisted. Hook content and paths are discarded. */
export interface CursorSample {
  version: 1;
  date: string;
  conversationId: string;
  generationId: string;
  model: string;
  repo: string | null;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
}

const COUNTERS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] as const;
const SAMPLE_KEYS = ["version", "date", "conversationId", "generationId", "model", "repo", "tokensIn", "tokensOut", "tokensCacheRead", "tokensCacheWrite"];
function invalid(): never { throw new Error("Invalid Cursor usage metadata; collection stopped."); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function identifier(value: unknown): string {
  // Captured Cursor conversation and generation identifiers are UUIDs. Do not
  // accept arbitrary strings that could accidentally be message content.
  if (typeof value !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value)) return invalid();
  return value.toLowerCase();
}
function modelName(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || !/^[a-z\d][a-z\d._:/+-]*$/i.test(value)) return invalid();
  return value;
}
function safeRepo(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 128 || /[/\\\u0000-\u001f\u007f]/.test(value) || value === "." || value === "..") return invalid();
  return value;
}
function add(a: number, b: number): number { return count(a + b); }

/**
 * Version-specific Cursor CLI stop fields, evidenced in CLI 2026.06.24.
 * Capture and semantics: github.com/omnigent-ai/omnigent, docs/cursor-native-cost-tracking.md.
 * input_tokens includes both cache buckets. A stop measures a turn, not a
 * response count. Missing usage is unsupported, never reconstructed from text.
 */
export function normalizeCursorStop(payload: unknown, observedAt = new Date()): CursorSample | null {
  const p = object(payload);
  if (p.hook_event_name !== undefined && p.hook_event_name !== "stop") return null;
  if (!COUNTERS.some((key) => Object.hasOwn(p, key))) return null;
  const input = count(p.input_tokens), output = count(p.output_tokens);
  add(input, output);
  const read = count(p.cache_read_tokens);
  const write = count(p.cache_write_tokens);
  if (add(read, write) > input || !Number.isFinite(observedAt.getTime())) return invalid();
  const conversationId = identifier(p.conversation_id), generationId = identifier(p.generation_id);
  const model = modelName(p.model);
  // Read only workspace metadata, never transcript_path, text or tool arguments.
  let cwd = typeof p.cwd === "string" && p.cwd.length <= 4096 ? p.cwd : null;
  if (!cwd && Array.isArray(p.workspace_roots) && p.workspace_roots.length === 1) {
    const root: unknown = p.workspace_roots[0];
    if (typeof root === "string" && root.length <= 4096) cwd = root;
  }
  const repo = cwd ? repoName({ cwd }) : null;
  return { version: 1, date: observedAt.toISOString().slice(0, 10), conversationId, generationId, model,
    repo: safeRepo(repo), tokensIn: input - read - write, tokensOut: output, tokensCacheRead: read, tokensCacheWrite: write };
}

export function cursorUsagePath(home = homedir()): string {
  const xdg = home === homedir() ? process.env.XDG_CONFIG_HOME : undefined;
  return join(xdg || join(home, ".config"), "kibble", "cursor-usage.jsonl");
}

function decodeSample(value: unknown): CursorSample {
  const p = object(value);
  if (Object.keys(p).length !== SAMPLE_KEYS.length || SAMPLE_KEYS.some((key) => !Object.hasOwn(p, key)) || p.version !== 1) return invalid();
  if (typeof p.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return invalid();
  const date = new Date(`${p.date}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== p.date) return invalid();
  const sample: CursorSample = { version: 1, date: p.date, conversationId: identifier(p.conversationId), generationId: identifier(p.generationId), model: modelName(p.model), repo: safeRepo(p.repo),
    tokensIn: count(p.tokensIn), tokensOut: count(p.tokensOut), tokensCacheRead: count(p.tokensCacheRead), tokensCacheWrite: count(p.tokensCacheWrite) };
  add(add(add(sample.tokensIn, sample.tokensCacheRead), sample.tokensCacheWrite), sample.tokensOut);
  return sample;
}

export class CursorSource implements UsageSource {
  readonly name = "cursor-local";
  readonly coverage = "Cursor recorded stop-hook token counts; forward collection only, no inferred response counts";
  private readonly pricing: PricingContext;
  private samples: Readonly<CursorSample>[] | undefined;
  private tools: Readonly<CursorToolSample>[] | undefined;
  private activity: Readonly<CursorActivitySample>[] | undefined;
  constructor(private readonly context: SourceContext & { path?: string } = {}) {
    this.pricing = context.pricing ?? new PricingContext();
  }
  async version(): Promise<string> { return "Kibble Cursor stop parser 1"; }

  snapshot({ since, until }: CollectOptions): CursorSample[] {
    if (this.samples) return this.samples.filter(({ date }) => date >= since && date <= until);
    const seen = new Map<string, CursorSample>();
    for (const sample of readCursorLog(this.context.path ?? cursorUsagePath(this.context.home), "usage", decodeSample)) {
      const key = JSON.stringify([sample.conversationId, sample.generationId]);
      const previous = seen.get(key);
      if (previous) {
        // Hook retries may be observed on a later day. Keep the first receipt,
        // but abort if its actual metadata changed instead of guessing totals.
        if (JSON.stringify({ ...previous, date: sample.date }) !== JSON.stringify(sample)) {
          throw new Error("Conflicting Cursor generation metadata; collection stopped.");
        }
      } else seen.set(key, sample);
    }
    const tools = readCursorTools(join(dirname(this.context.path ?? cursorUsagePath(this.context.home)), "cursor-tools.jsonl"));
    const activity = readCursorActivity(join(dirname(this.context.path ?? cursorUsagePath(this.context.home)), "cursor-activity.jsonl"));
    this.activity = activity.map(sample => Object.freeze(sample));
    this.samples = [...seen.values()].map((sample) => Object.freeze(sample));
    this.tools = tools.map((sample) => {
      // A completed generation can supply a missing model, but a distinct
      // explicit tool model may be a subagent. Never invent model aliases.
      const stop = seen.get(JSON.stringify([sample.conversationId, sample.generationId]));
      return Object.freeze(sample.model === null && stop ? { ...sample, model: stop.model } : sample);
    });
    return this.samples.filter(({ date }) => date >= since && date <= until);
  }

  toolSnapshot(options: CollectOptions): CursorToolSample[] {
    this.snapshot(options);
    return this.tools!.filter(({ date }) => date >= options.since && date <= options.until);
  }

  activitySnapshot(options: CollectOptions): CursorActivitySample[] {
    this.snapshot(options);
    return this.activity!.filter(({ date }) => date >= options.since && date <= options.until);
  }

  async collect(options: CollectOptions): Promise<CollectResult> {
    const samples = this.snapshot(options);
    await this.pricing.prefetch(samples.map(({ model }) => model));
    const days = new Map<string, NormalizedDailyUsage>(), sessions = new Map<string, SessionRef>();
    for (const sample of samples) {
      const { date, model, tokensIn, tokensOut, tokensCacheRead, tokensCacheWrite } = sample;
      const costMicros = count(this.pricing.costMicros(model, { input: tokensIn, output: tokensOut, cacheRead: tokensCacheRead, cacheWrite: tokensCacheWrite }));
      const key = JSON.stringify([date, model]);
      const row = days.get(key) ?? { date, agent: "cursor", model, provider: null, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensReasoning: 0, messageCount: 0, costMicros: 0 };
      row.tokensIn = add(row.tokensIn, tokensIn);
      row.tokensOut = add(row.tokensOut, tokensOut);
      row.tokensCacheRead = add(row.tokensCacheRead, tokensCacheRead);
      row.tokensCacheWrite = add(row.tokensCacheWrite, tokensCacheWrite);
      row.costMicros = add(row.costMicros, costMicros);
      days.set(key, row);
      const sessionId = `cursor:${createHash("sha256").update(`cursor:conversation:${sample.conversationId}`).digest("hex")}`;
      const session = sessions.get(sessionId) ?? { sessionId, agent: "cursor", date, messageCount: 0, costMicros: 0 };
      if (date < session.date) session.date = date;
      session.costMicros = add(session.costMicros, costMicros);
      sessions.set(sessionId, session);
    }
    for (const tool of [...this.toolSnapshot(options), ...this.activitySnapshot(options)]) {
      const sessionId = `cursor:${createHash("sha256").update(`cursor:conversation:${tool.conversationId}`).digest("hex")}`;
      const session = sessions.get(sessionId) ?? { sessionId, agent: "cursor", date: tool.date, messageCount: 0, costMicros: 0 };
      if (tool.date < session.date) session.date = tool.date;
      sessions.set(sessionId, session);
    }
    return { daily: [...days.values()], sessions: [...sessions.values()] };
  }
}
