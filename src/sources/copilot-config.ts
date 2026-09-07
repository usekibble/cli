import { readFileSync } from "node:fs";
import { parse, type ParseError } from "jsonc-parser";

/** Copilot settings and application state are JSONC, not strict JSON. */
export function readCopilotConfig(path: string): Record<string, unknown> | null {
  try {
    const errors: ParseError[] = [];
    const value: unknown = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
    return errors.length === 0 && value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Identifiers only. A malformed name must not send a path or arbitrary text. */
export function copilotCapabilityName(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_][a-zA-Z0-9_.:@-]{0,127}$/.test(value)
    ? value
    : null;
}
