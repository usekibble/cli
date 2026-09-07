import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { ciReceiptSchema, CI_RECEIPT_BYTES, type CiReceipt } from "../ci-receipt.js";

export function ciUploadConfig(server?: string) {
  const token = process.env.KIBBLE_CI_TOKEN;
  if (!token || !/^kci_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Set KIBBLE_CI_TOKEN to an automation credential from Settings.");
  let url: URL;
  try { url = new URL(server ?? process.env.KIBBLE_SERVER ?? "https://app.usekibble.com"); }
  catch { throw new Error("Invalid Kibble server URL."); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Use an HTTPS server origin, or HTTP on localhost for development.");
  }
  return { token, endpoint: new URL("/api/ci/receipts", url).href };
}

export function readCiReceipt(path: string): CiReceipt {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > CI_RECEIPT_BYTES) throw new Error();
    const bytes = Buffer.alloc(CI_RECEIPT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > CI_RECEIPT_BYTES) throw new Error();
    return ciReceiptSchema.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")));
  } catch { throw new Error("Invalid CI receipt. Only Kibble counts-only receipts up to 128 KiB can be uploaded."); }
  finally { if (fd !== undefined) closeSync(fd); }
}

async function acknowledgement(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

export async function uploadCiReceipt(receipt: CiReceipt, config: ReturnType<typeof ciUploadConfig>) {
  // Validate again at the network boundary, including callers that bypass file reading.
  const checked = ciReceiptSchema.safeParse(receipt);
  if (!checked.success) throw new Error("Invalid CI receipt; nothing uploaded.");
  const body = JSON.stringify(checked.data);
  if (Buffer.byteLength(body) > CI_RECEIPT_BYTES) throw new Error("CI receipt exceeds 128 KiB; nothing uploaded.");
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response;
    try {
      response = await fetch(config.endpoint, { method: "POST", headers: {
        Authorization: `Bearer ${config.token}`, "Content-Type": "application/json", "Accept-Language": "en",
      }, body, redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch {
      if (attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status !== 429 && response.status < 500) throw new Error(`CI upload refused (HTTP ${response.status}). Check the credential and receipt; the agent was not rerun.`);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      continue;
    }
    try {
      const ack = await acknowledgement(response) as { runId?: unknown; revision?: unknown; status?: unknown };
      if (ack.runId !== receipt.runId || !Number.isSafeInteger(ack.revision) || Number(ack.revision) < receipt.revision ||
        !["accepted", "duplicate", "stale"].includes(String(ack.status)) ||
        (ack.status !== "stale" && ack.revision !== receipt.revision)) throw new Error();
      return { status: String(ack.status) };
    } catch { throw new Error("The server did not acknowledge this CI receipt. Retain the file and retry its upload."); }
  }
  throw new Error("CI upload unavailable after retries. Retain the receipt and retry kibble ci upload; do not rerun the agent.");
}

export async function ciUpload(paths: string[], options: { server?: string }) {
  if (paths.length > 100) throw new Error("Upload at most 100 receipts per command.");
  const config = ciUploadConfig(options.server);
  const receipts = paths.map(readCiReceipt);
  for (const receipt of receipts) {
    const result = await uploadCiReceipt(receipt, config);
    console.log(`Kibble CI ${receipt.runId}: ${result.status}.`);
  }
}
