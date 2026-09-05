import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * One walk, one read, one parse.
 *
 * Both sidecars (`repos.ts` and `capabilities.ts`) want different fields out of
 * the same JSONL records, and both used to walk `~/.claude/projects`
 * themselves: every transcript on the machine was read and JSON-parsed twice
 * per push, hourly, forever. On a laptop with 263 MB of transcripts that is
 * half a gigabyte of parsing an hour to produce 32 KB of payload.
 *
 * So the walk lives here instead and the sidecars are visitors over it. Two
 * things fall out of that:
 *
 *   - a record is parsed once and handed to every visitor, and
 *   - files can be skipped by mtime, which the per-sidecar walks could not do
 *     without each re-deciding the rule.
 *
 * The mtime rule: a record dated `since` cannot live in a file last written
 * before `since` began, so such a file has nothing the push is asking for.
 * `MTIME_MARGIN_MS` is slack for a skewed clock, not for correctness.
 */

export type Rec = Record<string, unknown>;

export interface TranscriptFile {
  path: string;
  mtimeMs: number;
}

export interface TranscriptVisitor {
  /** Reset per-file state. Called before the first record of each file. */
  startFile?(file?: TranscriptFile): void;
  record(rec: Rec): void;
}

/** A day of slack, so a machine with a wandering clock still reports. */
const MTIME_MARGIN_MS = 24 * 60 * 60 * 1000;

/** Enough of a transcript to find the working directory it opened in. */
const HEAD_BYTES = 16 * 1024;

/** Bound file reads while still allowing a JSONL record to span any number of reads. */
const READ_BYTES = 64 * 1024;

/** The epoch millisecond before which a file cannot hold a record in range. */
export function transcriptFloor(since: string): number {
  const start = Date.parse(`${since}T00:00:00Z`);
  return Number.isFinite(start) ? start - MTIME_MARGIN_MS : 0;
}

/** Every `.jsonl` under `dir`, with the mtime that decides whether to read it. */
export function listJsonl(dir: string, out: TranscriptFile[] = []): TranscriptFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw new Error("could not list transcript files", { cause });
  }
  for (const name of entries) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch (cause) {
      throw new Error("could not inspect a transcript file", { cause });
    }
    if (st.isDirectory()) listJsonl(path, out);
    else if (name.endsWith(".jsonl")) out.push({ path, mtimeMs: st.mtimeMs });
  }
  return out;
}

/** Split by whether the file can hold a record the push is asking for. */
export function partitionByFloor(
  files: TranscriptFile[],
  floorMs: number,
): { recent: TranscriptFile[]; older: TranscriptFile[] } {
  const recent: TranscriptFile[] = [];
  const older: TranscriptFile[] = [];
  for (const file of files) (file.mtimeMs >= floorMs ? recent : older).push(file);
  return { recent, older };
}

/** Parse one complete JSONL line and hand the same record to every visitor. */
function visitLine(line: string, visitors: TranscriptVisitor[]): void {
  if (!line) return;
  let rec: Rec;
  try {
    rec = JSON.parse(line) as Rec;
  } catch {
    return;
  }
  for (const visitor of visitors) visitor.record(rec);
}

/** Read each file once, parse each line once, hand the record to every visitor. */
export function readTranscripts(files: TranscriptFile[], visitors: TranscriptVisitor[]): void {
  if (visitors.length === 0) return;
  const chunk = Buffer.allocUnsafe(READ_BYTES);
  for (const file of files) {
    let fd: number;
    try {
      fd = openSync(file.path, "r");
    } catch (cause) {
      throw new Error("could not open a transcript", { cause });
    }

    try {
      // Even the first failed read must abort: an incomplete day cannot replace
      // the server's previous complete aggregate.
      let bytesRead: number;
      try {
        bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      } catch (cause) {
        throw new Error("could not start reading a transcript", { cause });
      }

      for (const visitor of visitors) visitor.startFile?.(file);

      const decoder = new StringDecoder("utf8");
      const fragments: string[] = [];

      while (bytesRead > 0) {
        const text = decoder.write(chunk.subarray(0, bytesRead));
        let start = 0;
        let newline = text.indexOf("\n");

        while (newline !== -1) {
          const fragment = text.slice(start, newline);
          if (fragments.length === 0) {
            visitLine(fragment, visitors);
          } else {
            fragments.push(fragment);
            visitLine(fragments.join(""), visitors);
            fragments.length = 0;
          }
          start = newline + 1;
          newline = text.indexOf("\n", start);
        }
        if (start < text.length) fragments.push(text.slice(start));

        try {
          bytesRead = readSync(fd, chunk, 0, chunk.length, null);
        } catch (cause) {
          // A partial scan cannot replace a complete daily aggregate on ingest.
          // Abort the push instead of publishing only the records read so far.
          throw new Error("could not finish reading a transcript", { cause });
        }
      }

      const tail = decoder.end();
      if (tail) fragments.push(tail);
      if (fragments.length > 0) visitLine(fragments.join(""), visitors);
    } finally {
      closeSync(fd);
    }
  }
}

/** The first bytes of a file, without reading the rest of it. */
function head(path: string, bytes: number): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, read);
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

/**
 * The working directories of transcripts too old to parse whole.
 *
 * Which checkouts have a `.claude` worth listing is a fact about the machine,
 * not about the window being pushed (`capabilities.ts`), so skipping a file by
 * mtime must not shrink the inventory: a skill in a repo nobody touched this
 * week would come back "not installed" with a description cost of zero.
 *
 * Claude Code stamps `cwd` on every record, so the head of the file answers it.
 * The last line of the head is dropped: at 16 KB it is usually cut in half.
 */
export function harvestCwds(files: TranscriptFile[], into: Set<string>, agent: "claude-code" | "codex" = "claude-code"): void {
  for (const file of files) {
    const text = head(file.path, HEAD_BYTES);
    if (!text) continue;
    const lines = text.split("\n");
    lines.pop();
    for (const line of lines) {
      if (!line) continue;
      let rec: Rec;
      try {
        rec = JSON.parse(line) as Rec;
      } catch {
        continue;
      }
      const payload = rec.payload && typeof rec.payload === "object" ? rec.payload as Rec : {};
      const cwd = agent === "codex" ? payload.cwd : rec.cwd;
      if (typeof cwd === "string" && cwd) into.add(cwd);
    }
  }
}
