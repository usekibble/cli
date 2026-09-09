import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { cursorArtifact } from "./cursor-inventory.js";
import { readCursorSelectionSnapshot } from "./cursor-store-reader.js";

// Internal worker: the database path arrives over stdin, never command arguments.
try {
  const databasePath = readFileSync(0, "utf8");
  if (!databasePath || databasePath.length > 32768 || databasePath.includes("\0")) throw new Error();
  const result = readCursorSelectionSnapshot(databasePath).map(row => {
    const artifacts = new Set<string>();
    for (const path of row.skillPaths) {
      if (!isAbsolute(path) || !/(?:^|[/\\])SKILL\.md$/.test(path)) continue;
      try { artifacts.add(cursorArtifact(realpathSync(dirname(path)))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        artifacts.add(cursorArtifact(dirname(path)));
      }
    }
    return { ...row, skillPaths: [], skillArtifacts: [...artifacts].sort() };
  });
  process.stdout.write(JSON.stringify(result));
} catch {
  // No SQLite diagnostics, database paths, credentials or content leave stderr.
  process.exitCode = 1;
}
