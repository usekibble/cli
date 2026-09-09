import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  normalizeAgent,
  toMicros,
  type CollectOptions,
  type CollectResult,
  type NormalizedDailyUsage,
  type UsageSource,
} from "./types.js";

/**
 * Lane A via the tokscale CLI binary.
 *
 * The broad fallback behind `TokscaleHybridSource`. It covers far more clients
 * than the Rust library (50+ vs 9), but its overlapping Claude Code parser is
 * not accurate enough to use. The hybrid admits rows from this source only for
 * agents the core does not support. `tokscale graph` aggregates to day x client
 * x model, so the current CLI export provides no session ids.
 */

interface GraphClientEntry {
  client: string;
  modelId: string;
  providerId: string | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  };
  cost: number;
  messages: number;
}

interface GraphContribution {
  date: string;
  clients?: GraphClientEntry[];
}

interface GraphExport {
  contributions?: GraphContribution[];
}

function resolveTokscaleBin(): string {
  // Resolve the binary that ships with our own dependency tree, so the version
  // is pinned by our lockfile rather than whatever is on the user's PATH.
  const require = createRequire(import.meta.url);
  try {
    const pkgJson = require.resolve("@tokscale/cli/package.json");
    return pkgJson.replace(/package\.json$/, "bin.js");
  } catch {
    return "tokscale";
  }
}

export function runTokscale(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = resolveTokscaleBin();
    const isJs = bin.endsWith(".js");
    const child = spawn(
      isJs ? process.execPath : bin,
      isJs ? [bin, ...args] : args,
      { stdio: ["ignore", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) },
    );

    let stdout = "";
    let bytes = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error("tokscale timed out.");
      child.kill("SIGKILL");
    }, 120_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      bytes += Buffer.byteLength(c);
      if (bytes > 64 * 1024 * 1024) {
        failure = new Error("tokscale output exceeded the safety limit.");
        child.kill("SIGKILL");
      } else stdout += c;
    });
    // Errors from account commands can contain credentials or account ids.
    child.stderr.on("data", () => {});

    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not run tokscale. Reinstall @usekibble/cli to restore it."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code === 0) return resolve(stdout);
      reject(
        new Error(`tokscale exited ${code}. Check its installation or Cursor login.`),
      );
    });
  });
}

export class TokscaleCliSource implements UsageSource {
  constructor(private readonly client?: string, private readonly env?: NodeJS.ProcessEnv) {}
  readonly name = "tokscale-cli";
  readonly coverage = "50+ local clients, no session ids";

  async version(): Promise<string> {
    return (await runTokscale(["--version"])).trim();
  }

  async collect({ since, until }: CollectOptions): Promise<CollectResult> {
    const raw = await runTokscale([
      "graph",
      ...(this.client ? ["--client", this.client] : []),
      "--since",
      since,
      "--until",
      until,
      "--no-spinner",
    ], this.env);

    let parsed: GraphExport;
    try {
      parsed = JSON.parse(raw) as GraphExport;
    } catch {
      throw new Error(
        "tokscale graph did not return JSON. This usually means a version mismatch -- run `kibble doctor`.",
      );
    }

    const daily: NormalizedDailyUsage[] = [];
    for (const day of parsed.contributions ?? []) {
      // `graph` reports whole days; a range boundary can include a day outside
      // the requested window, so filter rather than trust the range.
      if (day.date < since || day.date > until) continue;
      for (const entry of day.clients ?? []) {
        daily.push({
          date: day.date,
          agent: normalizeAgent(entry.client),
          model: entry.modelId,
          provider: entry.providerId ?? null,
          tokensIn: entry.tokens.input,
          tokensOut: entry.tokens.output,
          tokensCacheRead: entry.tokens.cacheRead,
          tokensCacheWrite: entry.tokens.cacheWrite,
          tokensReasoning: entry.tokens.reasoning,
          messageCount: entry.messages,
          costMicros: toMicros(entry.cost),
        });
      }
    }

    return { daily, sessions: [] };
  }
}
