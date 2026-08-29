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
 * The fallback source. It covers far more clients than the Rust library (50+ vs
 * 9) and its pricing table is kept current, so it is the right choice for a team
 * running agents the library does not parse. What it cannot provide is session
 * ids: `tokscale graph` aggregates to day x client x model, so this source
 * returns no sessions and the dedup ledger and session percentiles are
 * unavailable when it is selected.
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

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = resolveTokscaleBin();
    const isJs = bin.endsWith(".js");
    const child = spawn(
      isJs ? process.execPath : bin,
      isJs ? [bin, ...args] : args,
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));

    child.on("error", (err) =>
      reject(
        new Error(
          `could not run tokscale (${err.message}). Reinstall @usekibble/cli to restore it.`,
        ),
      ),
    );
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      reject(
        new Error(`tokscale exited ${code}: ${stderr.trim() || "no output"}`),
      );
    });
  });
}

export class TokscaleCliSource implements UsageSource {
  readonly name = "tokscale-cli";
  readonly coverage = "50+ local clients, no session ids";

  async version(): Promise<string> {
    return (await run(["--version"])).trim();
  }

  async collect({ since, until }: CollectOptions): Promise<CollectResult> {
    const raw = await run([
      "graph",
      "--since",
      since,
      "--until",
      until,
      "--no-spinner",
    ]);

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
