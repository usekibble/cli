import { lstatSync, mkdirSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalReceipt, type CiReceipt } from "../ci-receipt.js";
import { collectCiTranscripts } from "../sources/ci-transcripts.js";
import { ciUploadConfig, readCiReceipt, uploadCiReceipt } from "./ci.js";
import { writeReceipt } from "./run.js";

/**
 * Recollection preserves the first saved quote when observed usage is unchanged.
 * The checkout name is left out too: a receipt saved by an older collector keeps
 * its revision, and a revision cannot change its digest on the server.
 */
function accounting(receipt: CiReceipt): string {
  const { workspace: _workspace, ...rest } = receipt;
  return canonicalReceipt({ ...rest, costMicros: null, costBasis: "unavailable",
    models: receipt.models.map((model) => ({ ...model, costMicros: null })) });
}

export async function ciCollect(options: { agent?: string; sessionsDir?: string; receiptsDir?: string; upload?: boolean; server?: string }) {
  if (options.agent !== "codex" && options.agent !== "claude-code") throw new Error("Choose --agent codex or --agent claude-code.");
  if (!options.sessionsDir) throw new Error("Use --sessions-dir with this job's isolated native session directory.");
  const config = options.upload ? ciUploadConfig(options.server) : null;
  const output = resolve(options.receiptsDir ?? join(options.sessionsDir, ".kibble-ci-receipts"));
  // Scan before creating the destination so a missing input directory cannot
  // accidentally become an apparently valid empty source.
  const collected = await collectCiTranscripts({ agent: options.agent, sessionsDir: resolve(options.sessionsDir) });
  try {
    mkdirSync(output, { recursive: true, mode: 0o700 });
    if (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink()) throw new Error();
  } catch { throw new Error("Cannot create a private CI receipt directory."); }
  const lock = join(output, ".collect.lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error("CI receipt directory is busy. Retry after the other collector finishes; remove .collect.lock only after confirming it stopped."); }
  try {
    const pending = collected.map((receipt) => {
      const path = join(output, `${receipt.runId}.json`);
      let exists = false;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
        exists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot safely read an existing CI receipt.");
      }
      if (!exists) return { path, receipt, first: true, changed: true };
      const old = readCiReceipt(path);
      if (old.source !== "transcript" || old.runId !== receipt.runId || old.agent !== receipt.agent || old.startedAt !== receipt.startedAt) {
        throw new Error("CI receipt identity conflicts with an existing file. Keep the original receipt and use the same complete session logs.");
      }
      if (accounting(old) === accounting(receipt)) return { path, receipt: old, first: false, changed: false };
      if (receipt.revision <= old.revision || (old.tokens && (!receipt.tokens ||
        (["input", "output", "cacheRead", "cacheWrite"] as const).some((key) => receipt.tokens![key] < old.tokens![key]))) ||
        (old.costMicros !== null && (receipt.costMicros === null || receipt.costMicros < old.costMicros))) {
        throw new Error("CI transcript snapshot regressed or conflicts with its saved receipt. Keep the receipt and restore complete logs before recollecting.");
      }
      return { path, receipt, first: false, changed: true };
    });
    // Validate every prior snapshot before replacing any of them. Delivery starts
    // only after all counts-only artifacts have been safely written.
    for (const item of pending) {
      if (item.changed) {
        try { writeReceipt(item.path, item.receipt, item.first); }
        catch { throw new Error("Could not save CI receipts. Keep the session files and retry collection; nothing uploaded."); }
      }
    }
    for (const { receipt } of pending) {
      console.log(`Kibble CI ${receipt.runId}: recorded session; usage ${receipt.usageStatus}; cost ${receipt.costBasis}. Receipt saved locally.`);
      if (config) {
        const ack = await uploadCiReceipt(receipt, config);
        console.log(`Kibble CI upload: ${ack.status}.`);
      }
    }
    // Partial is the normal, explicit coverage of persisted sessions. A session
    // without any observed token usage must still fail rather than look free.
    if (pending.some(({ receipt }) => receipt.usageStatus === "unavailable")) process.exitCode = 1;
  } finally { rmdirSync(lock); }
}
