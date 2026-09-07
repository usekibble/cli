import { createHash } from "node:crypto";

/** A portable opaque identity, independent of filenames, machines and CI jobs. */
export function ciSessionKey(agent: "codex" | "claude-code", session: string): string {
  const hash = createHash("sha256").update(JSON.stringify(["kibble-ci-session-v1", agent, session])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x80;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
