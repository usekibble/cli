/**
 * Keeps opaque transcript identities on the machine while a scan is running.
 *
 * Session ids, response ids, record ids, tool ids and item ids are never sent.
 * They only stop a transcript copied into a second file from being counted
 * twice. A missing identity stays countable because guessing from content would
 * cross the collector's privacy boundary.
 */
export class TranscriptDeduper {
  private readonly seen = new Set<string>();

  first(kind: string, session: string | null, id: string | null): boolean {
    if (!id) return true;
    const key = JSON.stringify([kind, session ?? "", id]);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

/** The cumulative token counters identify a Codex usage snapshot without content. */
export function tokenSnapshotId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const counts = value as Record<string, unknown>;
  if (!["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"].some((key) => key in counts)) return null;
  return JSON.stringify([
    counts.input_tokens,
    counts.cached_input_tokens ?? counts.cache_read_input_tokens,
    counts.cache_write_input_tokens,
    counts.output_tokens,
    counts.reasoning_output_tokens,
    counts.total_tokens,
  ]);
}
