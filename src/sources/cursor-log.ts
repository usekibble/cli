import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";

/** Normalized Cursor logs require every line, unlike tolerant raw transcript readers. */
export function readCursorLog<T>(path: string, kind: "usage" | "tool" | "activity", decode: (value: unknown) => T): T[] {
  let fd: number;
  try { fd = openSync(path, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Could not open Cursor ${kind} metadata; collection stopped.`);
  }
  const failure = () => new Error(`Could not read complete Cursor ${kind} metadata; collection stopped.`);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw failure();
    const buffer = Buffer.alloc(64 * 1024), decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = Buffer.alloc(0), offset = 0;
    const rows: T[] = [];
    while (offset < stat.size) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!bytes) throw failure();
      offset += bytes;
      pending = Buffer.concat([pending, buffer.subarray(0, bytes)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        if (!newline || newline > 4096) throw failure();
        rows.push(decode(JSON.parse(decoder.decode(pending.subarray(0, newline)))));
        pending = pending.subarray(newline + 1);
      }
      if (pending.length > 4096) throw failure();
    }
    if (pending.length || fstatSync(fd).size < stat.size) throw failure();
    return rows;
  } catch {
    // Native JSON/parser errors can quote content. Never forward their messages.
    throw failure();
  } finally { closeSync(fd); }
}
