import { createHash } from "node:crypto";

const COMPOUND = /^compound:[a-f\d]{64}$/;
function simple(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[^a-z\d_-]/i.test(value);
}

/**
 * Cursor 3.19.13 can append newline-separated opaque call namespaces. Keep
 * every component and separator in the digest: stripping whitespace or taking
 * only one component would merge distinct calls. Raw IDs cannot claim the
 * reserved colon-prefixed storage namespace. Legacy single IDs stay unchanged.
 */
export function normalizeCursorCallId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1031) return null;
  if (simple(value)) return value;
  const parts = value.split("\n");
  if (parts.length < 2 || parts.length > 8 || !parts.every(simple)) return null;
  return `compound:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Only normalized IDs may appear in local metadata records. */
export function storedCursorCallId(value: unknown): string | null {
  return typeof value === "string" && (simple(value) || (value.length === 73 && COMPOUND.test(value))) ? value : null;
}
