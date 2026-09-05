/**
 * Whether two configured server URLs resolve to the same web origin.
 * URL parsing normalizes host casing, default ports and path differences.
 */
export function sameServerOrigin(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return (
      (a.protocol === "http:" || a.protocol === "https:") &&
      (b.protocol === "http:" || b.protocol === "https:") &&
      a.origin === b.origin
    );
  } catch {
    return false;
  }
}
