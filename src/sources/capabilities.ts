import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Capability telemetry: which skills, slash commands, and MCP servers a machine
 * has, which of them actually fire, and what they cost to load.
 *
 * ORGANIZATION POLICY. Whether this runs is the owner's decision for the whole
 * organization (Settings, `collect_capabilities`), echoed to every machine at
 * `kibble login` and on every push and stored as `capabilities` in the config.
 * On by default; with it off the collector sends nothing from here and the
 * server drops the section anyway.
 *
 * WHAT THIS READS, EXHAUSTIVELY:
 *   - the NAMES of entries in skill and command directories (a directory
 *     listing -- never the contents of a skill file),
 *   - from session transcripts: tool_use blocks where the tool is `Skill`, the
 *     `skill` argument, MCP tool names, the CHARACTER LENGTH of the text block
 *     carrying the skill body, and the `attributionSkill` / `attributionMcpServer`
 *     stamps Claude Code puts on its own records together with that record's
 *     token usage,
 *   - the LENGTH of each installed skill's `description` frontmatter field.
 *
 * Bodies and descriptions are measured and discarded; only their sizes are kept.
 *
 * It never reads prompts, assistant replies, file contents, tool arguments other
 * than the skill name, or the body of any skill. The `args` a user passes to a
 * skill are explicitly discarded -- they are free text and would be content.
 *
 * This file is the entire surface of the privacy claim for capability data and
 * is meant to be read end to end in one sitting.
 */

export type CapabilityKind = "skill" | "command" | "mcp";

export interface UsageCounts {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface CapabilityRecord {
  date: string;
  kind: CapabilityKind;
  name: string;
  invocations: number;
  installed: boolean;
  triggerTyped: number;
  triggerModel: number;
  /** Body size, summed over invocations -- paid only when it fires. */
  contextTokens: number;
  /** Description size -- paid in every session, fired or not. */
  descriptionTokens: number;
  attributedTurns: number;
  attributedTokens: number;
  attributedCostMicros: number;
}

/**
 * Claude Code prefixes an injected skill body with this line. It is used only to
 * recognise the block -- the line contains a path and is never stored.
 */
const SKILL_BODY_MARKER = "Base directory for this skill:";

/** Rough tokens from character count. Exact enough to compare skills. */
function approxTokens(chars: number): number {
  return Math.round(chars / 4);
}

function listDirNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((n) => {
      if (n.startsWith(".")) return false;
      try {
        // A skill is a directory; a command is a .md file.
        return statSync(join(dir, n)).isDirectory() || n.endsWith(".md");
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function stripExt(name: string): string {
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

/**
 * Size a skill's advertised description.
 *
 * Only the `description` frontmatter field is read, and only its length is kept.
 * This is the always-on cost: the model has to be told a skill exists in order
 * to choose it, so every installed skill pays this in every session.
 */
function descriptionTokensFor(dir: string): number {
  for (const candidate of ["SKILL.md", "index.md"]) {
    const file = join(dir, candidate);
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(text);
      if (!fm?.[1]) return 0;
      const name = /^name:\s*(.*)$/m.exec(fm[1])?.[1]?.trim() ?? "";
      // No `m` flag: descriptions run to several lines, and with `m` the `$`
      // in the lookahead matches end-of-LINE, truncating every multi-line
      // description to its first line.
      const desc =
        /description:[ \t]*([\s\S]*?)(?=\n[a-z_-]+:[ \t]|$)/.exec(fm[1])?.[1]?.trim() ?? "";
      if (!desc) return 0;
      // Mirrors how a skill is advertised: one line of name plus description.
      return approxTokens(`- ${name}: ${desc}`.length);
    } catch {
      return 0;
    }
  }
  return 0;
}

/** Names of skills and commands installed on this machine, with their advertised size. */
export function inventory(home = homedir()): {
  skills: string[];
  commands: string[];
  descriptionTokens: Map<string, number>;
} {
  const root = join(home, ".claude");
  const skillDir = join(root, "skills");
  const skills = listDirNames(skillDir).map(stripExt);
  const descriptionTokens = new Map<string, number>();
  for (const name of skills) {
    descriptionTokens.set(name, descriptionTokensFor(join(skillDir, name)));
  }
  return {
    skills,
    commands: listDirNames(join(root, "commands")).map(stripExt),
    descriptionTokens,
  };
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkJsonl(full, out);
    else if (name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

interface Bucket {
  invocations: number;
  triggerTyped: number;
  triggerModel: number;
  contextTokens: number;
  attributedTurns: number;
  attributedTokens: number;
  attributedCostMicros: number;
}

function bucket(): Bucket {
  return {
    invocations: 0,
    triggerTyped: 0,
    triggerModel: 0,
    contextTokens: 0,
    attributedTurns: 0,
    attributedTokens: 0,
    attributedCostMicros: 0,
  };
}

/**
 * Scan Claude Code transcripts for capability usage.
 *
 * Claude Code only: every agent writes a different transcript format, and this
 * is bespoke per-agent work (plan section 06). Other agents simply report
 * nothing rather than guessing.
 */
export function scanCapabilities(options: {
  since: string;
  until: string;
  home?: string;
  /** Cost in micros for one record's usage, so rates match Lane A exactly. */
  priceOf?: (model: string, u: UsageCounts) => number;
}): CapabilityRecord[] {
  const home = options.home ?? homedir();
  const { skills, commands, descriptionTokens } = inventory(home);
  const priceOf = options.priceOf ?? (() => 0);
  const seenRequests = new Set<string>();

  // key: `${date}|${kind}|${name}`
  const seen = new Map<string, Bucket>();
  const at = (date: string, kind: CapabilityKind, name: string): Bucket => {
    const key = `${date}|${kind}|${name}`;
    let b = seen.get(key);
    if (!b) {
      b = bucket();
      seen.set(key, b);
    }
    return b;
  };
  const activeDates = new Set<string>();

  for (const file of walkJsonl(join(home, ".claude", "projects"))) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");

    // The command the user most recently typed, used to tell an explicitly
    // invoked capability from one the model reached for on its own.
    let lastTypedCommand: string | null = null;
    // The skill whose body we expect next, so we can size what it costs to load.
    // The tool_result for a Skill call is only "Launching skill: <name>"; the
    // body arrives afterwards as a text block in a user message.
    let awaitingBody: { date: string; name: string } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const date = String(rec.timestamp ?? "").slice(0, 10);
      if (!date || date < options.since || date > options.until) continue;

      const message = (rec.message ?? {}) as Record<string, unknown>;
      const role = message.role;
      const content = message.content;

      // Claude Code stamps the records it considers a capability's own work.
      // Preferring that over any inference of ours: it is the agent's attribution.
      const attributedSkill = rec.attributionSkill;
      const attributedMcp = rec.attributionMcpServer;
      const usage = message.usage as UsageCounts | undefined;
      if (usage && (attributedSkill || attributedMcp)) {
        const requestId = String(rec.requestId ?? message.id ?? "");
        if (!requestId || !seenRequests.has(requestId)) {
          if (requestId) seenRequests.add(requestId);
          const target = attributedSkill
            ? at(date, "skill", String(attributedSkill))
            : at(date, "mcp", String(attributedMcp));
          target.attributedTurns += 1;
          target.attributedTokens +=
            (usage.input_tokens ?? 0) +
            (usage.output_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
          target.attributedCostMicros += priceOf(
            String(message.model ?? ""),
            usage,
          );
        }
      }

      if (role === "user") {
        activeDates.add(date);
        // Typed slash commands arrive wrapped in <command-name> tags.
        const flat =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((b) =>
                    b && typeof b === "object" && (b as { type?: string }).type === "text"
                      ? String((b as { text?: string }).text ?? "")
                      : "",
                  )
                  .join(" ")
              : "";
        const typed = flat.match(/<command-name>\s*\/?([\w:-]+)/i);
        lastTypedCommand = typed?.[1]?.toLowerCase() ?? null;
        if (typed?.[1]) {
          const name = typed[1].toLowerCase();
          const b = at(date, "command", name);
          b.invocations += 1;
          b.triggerTyped += 1;
        }

        // The skill body: measure its size, keep nothing else. The marker line
        // contains a filesystem path, which is why only `.length` is read.
        if (awaitingBody && Array.isArray(content)) {
          for (const blk of content) {
            const b = blk as { type?: string; text?: string };
            if (b?.type !== "text" || typeof b.text !== "string") continue;
            if (!b.text.startsWith(SKILL_BODY_MARKER)) continue;
            at(awaitingBody.date, "skill", awaitingBody.name).contextTokens +=
              approxTokens(b.text.length);
            awaitingBody = null;
            break;
          }
        }
        continue;
      }

      if (role !== "assistant" || !Array.isArray(content)) continue;
      activeDates.add(date);

      for (const blk of content) {
        const b = blk as {
          type?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
        };
        if (b?.type !== "tool_use" || !b.name) continue;

        if (b.name === "Skill") {
          // Only the skill name is kept. `args` is free text -- never read.
          const skill = String(b.input?.skill ?? "").trim();
          if (!skill) continue;
          const rec = at(date, "skill", skill);
          rec.invocations += 1;
          // A skill named by the slash command the user just typed was invoked,
          // not chosen.
          if (lastTypedCommand && skill.toLowerCase().endsWith(lastTypedCommand))
            rec.triggerTyped += 1;
          else rec.triggerModel += 1;
          awaitingBody = { date, name: skill };
          continue;
        }

        if (b.name.startsWith("mcp__")) {
          const server = b.name.split("__")[1];
          if (server) at(date, "mcp", server).invocations += 1;
        }
      }
    }
  }

  const out: CapabilityRecord[] = [];
  for (const [key, b] of seen) {
    const [date, kind, ...rest] = key.split("|");
    const name = rest.join("|");
    if (!date || !kind || !name) continue;
    out.push({
      date,
      kind: kind as CapabilityKind,
      name,
      invocations: b.invocations,
      installed:
        kind === "skill" ? skills.includes(name) : kind === "command" ? commands.includes(name) : false,
      triggerTyped: b.triggerTyped,
      triggerModel: b.triggerModel,
      contextTokens: b.contextTokens,
      descriptionTokens: kind === "skill" ? (descriptionTokens.get(name) ?? 0) : 0,
      attributedTurns: b.attributedTurns,
      attributedTokens: b.attributedTokens,
      attributedCostMicros: b.attributedCostMicros,
    });
  }

  // Installed but never invoked. Reported against the most recent active day so
  // it lands in the window the dashboard is showing. This is the row that only a
  // local collector can produce.
  const anchor = [...activeDates].sort().pop();
  if (anchor) {
    for (const [kind, names] of [
      ["skill", skills],
      ["command", commands],
    ] as const) {
      for (const name of names) {
        const used = out.some((r) => r.kind === kind && r.name === name);
        if (used) continue;
        out.push({
          date: anchor,
          kind,
          name,
          invocations: 0,
          installed: true,
          triggerTyped: 0,
          triggerModel: 0,
          contextTokens: 0,
          descriptionTokens: kind === "skill" ? (descriptionTokens.get(name) ?? 0) : 0,
          attributedTurns: 0,
          attributedTokens: 0,
          attributedCostMicros: 0,
        });
      }
    }
  }

  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || b.invocations - a.invocations,
  );
}
