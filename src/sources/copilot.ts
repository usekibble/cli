import { homedir } from "node:os";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PricingContext } from "./pricing.js";
import {
  partitionByFloor,
  readTranscripts,
  transcriptFloor,
  type Rec,
  type TranscriptFile,
  type TranscriptVisitor,
} from "./transcripts.js";
import {
  type CollectOptions,
  type CollectResult,
  type NormalizedDailyUsage,
  type SessionRef,
  type SourceContext,
  type UsageSource,
} from "./types.js";

/**
 * GitHub Copilot CLI keeps resumable sessions below this directory. Respect
 * COPILOT_HOME, which replaces the whole ~/.copilot path in the CLI itself.
 */
export function copilotHome(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_HOME || join(home, ".copilot");
}

export function copilotTranscripts(root: string): TranscriptFile[] {
  const dir = join(root, "session-state");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Cannot list Copilot session counters", { cause: error });
  }
  const files: TranscriptFile[] = [];
  for (const entry of entries.sort()) {
    // Session workspaces can contain arbitrary files. Only open the event log,
    // never recursively walk artifacts or temporary JSONL beside it.
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(entry)) continue;
    const path = join(dir, entry, "events.jsonl");
    try {
      const stat = statSync(path);
      if (stat.isFile()) files.push({ path, mtimeMs: stat.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Cannot inspect Copilot session counters", { cause: error });
      }
    }
  }
  return files;
}

export interface CopilotUsageDelta {
  date: string;
  sessionId: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensReasoning: number;
  messageCount: number;
}

interface ModelSnapshot {
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensReasoning: number;
  messageCount: number;
}

function obj(value: unknown): Rec {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function snapshot(value: unknown): ModelSnapshot {
  const metric = obj(value);
  const usage = obj(metric.usage);
  const requests = obj(metric.requests);
  return {
    // Copilot input is cache-inclusive. Kibble's categories are disjoint.
    tokensIn: Math.max(0, count(usage.inputTokens) - count(usage.cacheReadTokens) - count(usage.cacheWriteTokens)),
    tokensOut: count(usage.outputTokens),
    tokensCacheRead: count(usage.cacheReadTokens),
    tokensCacheWrite: count(usage.cacheWriteTokens),
    tokensReasoning: count(usage.reasoningTokens),
    messageCount: count(requests.count),
  };
}

/** A repeated or stale cumulative checkpoint cannot add usage a second time. */
function delta(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

/**
 * Durable Copilot usage is written on session.shutdown as a cumulative
 * per-model snapshot. A resumed session can write several shutdown events to
 * the same events.jsonl, so emit only the increase since the previous one.
 *
 * The visitor deliberately touches only event type, timestamp, session id,
 * model names, request counts and token counters. Session events also contain
 * prompts, replies, tool arguments, tool output and changed-file paths. None of
 * those fields is accessed here.
 */
export function copilotUsageVisitor(emit: (usage: CopilotUsageDelta) => void): TranscriptVisitor {
  let sessionId: string | null = null;
  let previous = new Map<string, ModelSnapshot>();
  let eventIds = new Set<string>();

  return {
    startFile: () => {
      sessionId = null;
      previous = new Map();
      eventIds = new Set();
    },
    record: (record: Rec) => {
      // The main shutdown already includes sub-agent totals.
      if (record.agentId) return;
      if (record.type === "session.start") {
        const data = obj(record.data);
        sessionId = typeof data.sessionId === "string" && /^[\da-f-]{36}$/i.test(data.sessionId)
          ? data.sessionId : null;
        return;
      }
      if (record.type !== "session.shutdown") return;

      const eventId = typeof record.id === "string" ? record.id : null;
      if (eventId && eventIds.has(eventId)) return;
      if (eventId) eventIds.add(eventId);

      const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
      if (!Number.isFinite(timestamp)) return;
      const date = new Date(timestamp).toISOString().slice(0, 10);
      const metrics = obj(obj(record.data).modelMetrics);
      for (const [model, raw] of Object.entries(metrics)) {
        if (!model || model.length > 128) continue;
        const current = snapshot(raw);
        const before = previous.get(model) ?? {
          tokensIn: 0,
          tokensOut: 0,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          tokensReasoning: 0,
          messageCount: 0,
        };
        previous.set(model, Object.fromEntries(
          Object.entries(current).map(([key, value]) => [key, Math.max(value, before[key as keyof ModelSnapshot])]),
        ) as unknown as ModelSnapshot);
        const usage: CopilotUsageDelta = {
          date,
          sessionId,
          model,
          tokensIn: delta(current.tokensIn, before.tokensIn),
          tokensOut: delta(current.tokensOut, before.tokensOut),
          tokensCacheRead: delta(current.tokensCacheRead, before.tokensCacheRead),
          tokensCacheWrite: delta(current.tokensCacheWrite, before.tokensCacheWrite),
          tokensReasoning: delta(current.tokensReasoning, before.tokensReasoning),
          messageCount: delta(current.messageCount, before.messageCount),
        };
        if (
          usage.tokensIn ||
          usage.tokensOut ||
          usage.tokensCacheRead ||
          usage.tokensCacheWrite ||
          usage.tokensReasoning ||
          usage.messageCount
        ) {
          emit(usage);
        }
      }
    },
  };
}

export interface CopilotSourceOptions extends SourceContext {
  copilotHome?: string;
  /** Test seam. Production resolves the same pinned pricing table as Lane A. */
  priceOf?: (usage: CopilotUsageDelta) => Promise<number> | number;
}

/**
 * GitHub Copilot CLI session logs behind the same UsageSource boundary as tokscale.
 * Format reference: @github/copilot 1.0.83 schemas/session-events.schema.json
 * https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events
 */
export class CopilotSource implements UsageSource {
  readonly name = "copilot-session";
  readonly coverage = "GitHub Copilot CLI local sessions, with session ids";
  private readonly root: string;
  private readonly customPrice?: CopilotSourceOptions["priceOf"];
  private readonly pricing: PricingContext;

  constructor(options: CopilotSourceOptions = {}) {
    const home = options.home ?? homedir();
    this.root = options.copilotHome ?? copilotHome(home);
    this.customPrice = options.priceOf;
    this.pricing = options.pricing ?? new PricingContext();
  }

  async version(): Promise<string> {
    return "Copilot session events v1";
  }

  private async costOf(usage: CopilotUsageDelta): Promise<number> {
    if (this.customPrice) return await this.customPrice(usage);
    return this.pricing.costMicros({ model: usage.model, provider: "github-copilot" }, {
      input: usage.tokensIn,
      output: usage.tokensOut,
      cacheRead: usage.tokensCacheRead,
      cacheWrite: usage.tokensCacheWrite,
    });
  }

  async collect({ since, until }: CollectOptions): Promise<CollectResult> {
    const files = partitionByFloor(copilotTranscripts(this.root), transcriptFloor(since)).recent;
    const deltas: CopilotUsageDelta[] = [];
    readTranscripts(files, [copilotUsageVisitor((usage) => deltas.push(usage))]);
    if (!this.customPrice) {
      await this.pricing.prefetch(deltas
        .filter((usage) => usage.date >= since && usage.date <= until)
        .map(({ model }) => ({ model, provider: "github-copilot" })));
    }

    const daily = new Map<string, NormalizedDailyUsage>();
    const sessions = new Map<string, SessionRef>();
    for (const usage of deltas) {
      if (usage.date < since || usage.date > until) continue;
      const costMicros = await this.costOf(usage);
      const dayKey = `${usage.date}|${usage.model}`;
      const day = daily.get(dayKey);
      if (day) {
        day.tokensIn += usage.tokensIn;
        day.tokensOut += usage.tokensOut;
        day.tokensCacheRead += usage.tokensCacheRead;
        day.tokensCacheWrite += usage.tokensCacheWrite;
        day.tokensReasoning += usage.tokensReasoning;
        day.messageCount += usage.messageCount;
        day.costMicros += costMicros;
      } else {
        daily.set(dayKey, {
          date: usage.date,
          agent: "copilot",
          model: usage.model,
          provider: "github-copilot",
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          tokensCacheRead: usage.tokensCacheRead,
          tokensCacheWrite: usage.tokensCacheWrite,
          tokensReasoning: usage.tokensReasoning,
          messageCount: usage.messageCount,
          costMicros,
        });
      }

      if (usage.sessionId) {
        const session = sessions.get(usage.sessionId);
        if (session) {
          session.messageCount += usage.messageCount;
          session.costMicros += costMicros;
          if (usage.date < session.date) session.date = usage.date;
        } else {
          sessions.set(usage.sessionId, {
            sessionId: usage.sessionId,
            agent: "copilot",
            date: usage.date,
            messageCount: usage.messageCount,
            costMicros,
          });
        }
      }
    }

    return {
      daily: [...daily.values()].sort(
        (a, b) => a.date.localeCompare(b.date) || b.costMicros - a.costMicros,
      ),
      sessions: [...sessions.values()],
    };
  }
}
