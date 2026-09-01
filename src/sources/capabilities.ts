import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { Rec, TranscriptVisitor } from "./transcripts.js";

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
 *     listing -- never the contents of a skill file), in three places: the
 *     personal `~/.claude`, the `.claude` of every checkout a transcript
 *     worked in, and the `skills/` and `commands/` of each installed plugin,
 *   - the `cwd` field of transcript records and the existence of a `.claude`
 *     directory above it, which is how those checkouts are found. The working
 *     directory is a path: it is read, walked, and discarded here, exactly as
 *     `sources/repos.ts` does, and never leaves the machine,
 *   - `~/.claude/plugins/installed_plugins.json`, for the install path and name
 *     of each plugin, so a stale copy in the plugin cache is not counted,
 *   - from session transcripts: tool_use blocks where the tool is `Skill`, the
 *     `skill` argument, MCP tool names, the CHARACTER LENGTH of the text block
 *     carrying the skill body, and the `attributionSkill` / `attributionMcpServer`
 *     stamps Claude Code puts on its own records together with that record's
 *     token usage,
 *   - the LENGTH of each installed skill's `description` frontmatter field,
 *   - the same directory-listing read of Codex's `~/.codex/skills` and
 *     `~/.codex/prompts`, and from Codex session files the SERVER NAME of each
 *     `McpToolCall` item. Codex writes no capability attribution and no
 *     structured skill invocation, so those stay zero for Codex rows.
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

/** Which agent the row is a fact about. Every capability row carries one. */
export type CapabilityAgent = "claude-code" | "codex";

export interface UsageCounts {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface CapabilityRecord {
  agent: CapabilityAgent;
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

export type CapabilitySource = "personal" | "project" | "plugin";

/**
 * One skill or command present on this machine.
 *
 * `source` and `realPath` stay local. The wire format is names and counts, and
 * `capabilityRef` on the server is `.strict()`, so reporting where a skill came
 * from is a plan decision and a schema change on both ends, never a field
 * smuggled into a push. They are kept here because both are needed to decide
 * which copy a name refers to before anything is counted.
 */
export interface InstalledCapability {
  name: string;
  source: CapabilitySource;
  /** Symlinks resolved, so one artifact reached by two names stays one artifact. */
  realPath: string;
  descriptionTokens: number;
  /** A second name for a capability already listed (`<plugin>:<skill>` -> `<skill>`). */
  alias?: boolean;
}

export interface Inventory {
  skills: Map<string, InstalledCapability>;
  commands: Map<string, InstalledCapability>;
}

/**
 * Entries of a skill or command directory, with symlinks followed.
 *
 * `statSync` follows links on purpose. A project's `.claude/skills` is
 * routinely a directory of symlinks into a shared, agent-neutral folder, and
 * the tidier-looking `readdirSync(dir, { withFileTypes: true })` uses lstat
 * semantics: it would call every one of those links "not a directory" and
 * return an empty inventory without failing. A link whose target is gone
 * throws here and is skipped, which is the right answer, since it cannot load
 * either.
 */
function listEntries(dir: string, want: "skill" | "command"): { name: string; path: string }[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { name: string; path: string }[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue; /* dangling symlink: listed by the OS, loadable by nobody */
    }
    // A skill is a directory. A command is a .md file, and a directory of them
    // is a namespace: `commands/frontend/component.md` is `frontend:component`,
    // never a command called `frontend`.
    if (want === "skill") {
      if (isDir) out.push({ name, path });
      continue;
    }
    if (isDir) {
      for (const child of listEntries(path, "command"))
        out.push({ name: `${name}:${child.name}`, path: child.path });
    } else if (name.endsWith(".md")) {
      out.push({ name: name.slice(0, -3), path });
    }
  }
  return out;
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
      // description to its first line. The key that ends the description may be
      // block-valued (`references:` then a list, `metadata:` then a map), so the
      // lookahead has to accept a newline after the colon as well as a space;
      // requiring a space ran the capture on into the next key's block.
      const desc =
        /description:[ \t]*([\s\S]*?)(?=\n[a-z_-]+:(?:[ \t]|\n|$)|$)/.exec(fm[1])?.[1]?.trim() ?? "";
      if (!desc) return 0;
      // Mirrors how a skill is advertised: one line of name plus description.
      return approxTokens(`- ${name}: ${desc}`.length);
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * The plugins actually installed, from the install record rather than the cache.
 *
 * `~/.claude/plugins/cache` keeps older versions of a plugin beside the live
 * one, so walking it reports the same skill several times over.
 * `installed_plugins.json` is the authority for which copy is loadable.
 */
function pluginRoots(home: string): { plugin: string; dir: string }[] {
  const file = join(home, ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(file)) return [];
  let parsed: { plugins?: Record<string, { installPath?: string }[]> };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as typeof parsed;
  } catch {
    return [];
  }
  const out: { plugin: string; dir: string }[] = [];
  for (const [id, entries] of Object.entries(parsed.plugins ?? {})) {
    // `frontend-design@claude-plugins-official`: the plugin is the part the
    // model names when it invokes `<plugin>:<skill>`. Split on the LAST `@`,
    // because a scoped id (`@scope/name@marketplace`) starts with one and
    // `split("@")[0]` would hand back an empty string, filing every skill of
    // that plugin as `:<skill>`.
    const at = id.lastIndexOf("@");
    const plugin = (at > 0 ? id.slice(0, at) : id) || id;
    for (const entry of entries ?? []) {
      const dir = entry?.installPath;
      if (dir && existsSync(dir)) out.push({ plugin, dir });
    }
  }
  return out;
}

/**
 * Checkouts whose `.claude` directory could have been in play.
 *
 * Every Claude Code record carries the working directory, which is how
 * `sources/repos.ts` already attributes tokens to a repo. The same values
 * answer "whose project skills were loadable here": walk up from each working
 * directory towards the machine's home, collecting every level that has a
 * `.claude`. A worktree falls out for free, since it carries its own.
 *
 * A root below another root is a directory-scoped skill: Claude Code lists it
 * as `apps/web:deploy` when the session opened at the checkout above it, and as
 * `deploy` when it opened there. Which one the model typed is a fact about that
 * session, not about the machine, so both names are registered and only one is
 * ever reported (see `inventory`).
 *
 * Only directory existence is tested, and no path leaves this module.
 */
function projectRoots(
  home: string,
  cwds: Iterable<string>,
): { dir: string; prefixes: string[] }[] {
  const roots = new Set<string>();
  const seen = new Set<string>();
  for (const cwd of cwds) {
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    let dir = cwd;
    for (let depth = 0; depth < 32; depth++) {
      if (dir === home) break;
      if (existsSync(join(dir, ".claude"))) roots.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const all = [...roots];
  return all.map((dir) => ({
    dir,
    prefixes: all
      .filter((other) => other !== dir && dir.startsWith(`${other}${sep}`))
      .map((other) => relative(other, dir).split(sep).join("/"))
      // A worktree's own `.claude` is not a namespace anyone types.
      .filter((rel) => rel && !rel.split("/").includes(".claude")),
  }));
}

/**
 * Every skill and command this machine can load, and what each advertises.
 *
 * Three roots, because a name alone does not say which copy answered:
 *   - project, `<checkout>/.claude/{skills,commands}` for every checkout a
 *     transcript worked in,
 *   - personal, `~/.claude/{skills,commands}`,
 *   - plugin, the `skills/` and `commands/` of each installed plugin, listed as
 *     `<plugin>:<skill>` the way the model invokes them, with the bare name kept
 *     as an alias when no nearer copy claims it.
 *
 * Precedence on a repeated name is project, then personal, then plugin: the
 * nearer copy is the one somebody edited last. Reading only the personal
 * directory, as this did until now, marked every project, plugin and built-in
 * skill as not installed and gave it a description cost of zero.
 */
export function inventory(home = homedir(), cwds: Iterable<string> = []): Inventory {
  const skills = new Map<string, InstalledCapability>();
  const commands = new Map<string, InstalledCapability>();
  const described = new Map<string, number>();

  // One artifact, however many names reach it. The FIRST name registered for a
  // real path is the one reported; every later name for the same path is an
  // alias, so `installed` still answers for it while the never-fired loop files
  // it once. A skills directory of symlinks into a shared folder, and a plugin
  // skill reachable both qualified and bare, both land here.
  const claimed = new Map<Map<string, InstalledCapability>, Set<string>>();

  const add = (
    map: Map<string, InstalledCapability>,
    name: string,
    path: string,
    source: CapabilitySource,
    withDescription: boolean,
  ) => {
    if (!name || map.has(name)) return;
    let realPath: string;
    try {
      realPath = realpathSync(path);
    } catch {
      return;
    }
    let paths = claimed.get(map);
    if (!paths) claimed.set(map, (paths = new Set()));
    const alias = paths.has(realPath);
    paths.add(realPath);
    let descriptionTokens = 0;
    if (withDescription) {
      descriptionTokens = described.get(realPath) ?? descriptionTokensFor(realPath);
      described.set(realPath, descriptionTokens);
    }
    map.set(name, { name, source, realPath, descriptionTokens, ...(alias ? { alias: true } : {}) });
  };

  const roots: { dir: string; source: CapabilitySource; prefixes: string[] }[] = [
    ...projectRoots(home, cwds).map(({ dir, prefixes }) => ({
      dir: join(dir, ".claude"),
      source: "project" as const,
      prefixes,
    })),
    { dir: join(home, ".claude"), source: "personal" as const, prefixes: [] },
    ...pluginRoots(home).map(({ plugin, dir }) => ({
      dir,
      source: "plugin" as const,
      // A plugin skill is invoked `<plugin>:<skill>`; the bare name is the
      // alias, and loses to any nearer copy that claimed it first.
      prefixes: [plugin],
    })),
  ];
  for (const { dir, source, prefixes } of roots) {
    for (const [kind, map, described] of [
      ["skill", skills, true],
      ["command", commands, false],
    ] as const) {
      for (const e of listEntries(join(dir, kind === "skill" ? "skills" : "commands"), kind)) {
        const names =
          source === "plugin"
            ? [...prefixes.map((p) => `${p}:${e.name}`), e.name]
            : [e.name, ...prefixes.map((p) => `${p}:${e.name}`)];
        for (const name of names) add(map, name, e.path, source, described);
      }
    }
  }
  return { skills, commands };
}

/**
 * Every skill and custom prompt Codex can load on this machine.
 *
 * One root: `~/.codex/skills` for skills (the same SKILL.md shape Claude Code
 * uses, so the description sizing is shared) and `~/.codex/prompts` for custom
 * prompts, reported as commands. Codex has no plugin marketplace install
 * record and no per-checkout capability directory to walk, so there are no
 * project or plugin roots and no aliases.
 */
export function codexInventory(home = homedir()): Inventory {
  const skills = new Map<string, InstalledCapability>();
  const commands = new Map<string, InstalledCapability>();
  for (const e of listEntries(join(home, ".codex", "skills"), "skill")) {
    let realPath: string;
    try {
      realPath = realpathSync(e.path);
    } catch {
      continue;
    }
    skills.set(e.name, {
      name: e.name,
      source: "personal",
      realPath,
      descriptionTokens: descriptionTokensFor(realPath),
    });
  }
  for (const e of listEntries(join(home, ".codex", "prompts"), "command")) {
    let realPath: string;
    try {
      realPath = realpathSync(e.path);
    } catch {
      continue;
    }
    commands.set(e.name, { name: e.name, source: "personal", realPath, descriptionTokens: 0 });
  }
  return { skills, commands };
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
 * Accumulates capability usage from Claude Code transcripts.
 *
 * Claude Code only: every agent writes a different transcript format, and this
 * is bespoke per-agent work (plan section 06). Other agents simply report
 * nothing rather than guessing.
 *
 * A visitor rather than its own walk, so that one read and one parse of each
 * transcript feeds this and `repos.ts` together (`transcripts.ts`). The two
 * counters that survive a file are here; the two that must not are closed over
 * by the visitor and reset in `startFile`.
 */
export class CapabilityCollector {
  private readonly seenRequests = new Set<string>();
  /** key: `${agent}|${date}|${kind}|${name}` */
  private readonly seen = new Map<string, Bucket>();
  /** Days each agent was active in the window; anchors that agent's idle rows. */
  private readonly activeDates = new Map<CapabilityAgent, Set<string>>();
  /**
   * Working directories seen in the transcripts, which is how the project roots
   * are found. Collected during the walk rather than guessed from the encoded
   * directory names under `~/.claude/projects`, which replace every path
   * separator with a dash and cannot be decoded back.
   */
  private readonly cwds = new Set<string>();
  private readonly home: string;
  private readonly priceOf: (model: string, u: UsageCounts) => number;

  constructor(private readonly options: {
    since: string;
    until: string;
    home?: string;
    /** Cost in micros for one record's usage, so rates match Lane A exactly. */
    priceOf?: (model: string, u: UsageCounts) => number;
  }) {
    this.home = options.home ?? homedir();
    this.priceOf = options.priceOf ?? (() => 0);
  }

  private readonly at = (
    agent: CapabilityAgent,
    date: string,
    kind: CapabilityKind,
    name: string,
  ): Bucket => {
    const key = `${agent}|${date}|${kind}|${name}`;
    let b = this.seen.get(key);
    if (!b) {
      b = bucket();
      this.seen.set(key, b);
    }
    return b;
  };

  private readonly active = (agent: CapabilityAgent, date: string): void => {
    let dates = this.activeDates.get(agent);
    if (!dates) this.activeDates.set(agent, (dates = new Set()));
    dates.add(date);
  };

  /**
   * A working directory from a transcript this pass did not parse whole.
   *
   * Files older than the window are skipped for speed, but which checkouts have
   * a loadable `.claude` is a fact about the machine rather than about the
   * window, so their `cwd` still has to reach the inventory. `harvestCwds` in
   * `transcripts.ts` reads the head of each skipped file for exactly this.
   */
  addCwd(cwd: string): void {
    if (cwd) this.cwds.add(cwd);
  }

  visitor(): TranscriptVisitor {
    const { seenRequests, active, cwds, priceOf, options } = this;
    const at = (date: string, kind: CapabilityKind, name: string) =>
      this.at("claude-code", date, kind, name);
    // The command the user most recently typed, used to tell an explicitly
    // invoked capability from one the model reached for on its own.
    let lastTypedCommand: string | null = null;
    // The skill whose body we expect next, so we can size what it costs to load.
    // The tool_result for a Skill call is only "Launching skill: <name>"; the
    // body arrives afterwards as a text block in a user message.
    let awaitingBody: { date: string; name: string } | null = null;
    return {
      startFile: () => {
        lastTypedCommand = null;
        awaitingBody = null;
      },
      record: (rec: Rec) => {
        // Before the date filter: which projects to scan is a fact about the
        // machine, not about the window being pushed.
        const cwd = rec.cwd;
        if (typeof cwd === "string" && cwd) cwds.add(cwd);

        const date = String(rec.timestamp ?? "").slice(0, 10);
        if (!date || date < options.since || date > options.until) return;

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
          active("claude-code", date);
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
          return;
        }

        if (role !== "assistant" || !Array.isArray(content)) return;
        active("claude-code", date);

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
      },
    };
  }

  /**
   * Capability usage from Codex session files, driven over the same walk that
   * feeds `repos.ts`.
   *
   * The only structured capability fact a Codex session carries is the server
   * name on an `McpToolCall` item. A Codex skill fires by the model reading
   * SKILL.md with an ordinary shell command, and counting that would mean
   * reading command lines, which are content; so Codex skill rows come from
   * the inventory alone, `invocations` zero.
   */
  codexVisitor(): TranscriptVisitor {
    const { at, active, options } = this;
    return {
      record: (r: Rec) => {
        const date = String(r.timestamp ?? "").slice(0, 10);
        if (!date || date < options.since || date > options.until) return;
        if (r.type !== "event_msg" && r.type !== "turn_context") return;
        active("codex", date);
        if (r.type !== "event_msg") return;
        const payload = (r.payload ?? {}) as Record<string, unknown>;
        if (payload.type !== "item_completed") return;
        const item = (payload.item ?? {}) as Record<string, unknown>;
        if (item.type !== "McpToolCall") return;
        const server = String(item.server ?? "").trim();
        if (server) at("codex", date, "mcp", server).invocations += 1;
      },
    };
  }

  finish(): CapabilityRecord[] {
    const { home, cwds, seen, activeDates } = this;
    const inventories: Record<CapabilityAgent, Inventory> = {
      "claude-code": inventory(home, cwds),
      codex: codexInventory(home),
    };

    const out: CapabilityRecord[] = [];
    for (const [key, b] of seen) {
      const [agent, date, kind, ...rest] = key.split("|");
      const name = rest.join("|");
      if (!agent || !date || !kind || !name) continue;
      const inv = inventories[agent as CapabilityAgent];
      out.push({
        agent: agent as CapabilityAgent,
        date,
        kind: kind as CapabilityKind,
        name,
        invocations: b.invocations,
        installed:
          kind === "skill"
            ? inv.skills.has(name)
            : kind === "command"
              ? inv.commands.has(name)
              : false,
        triggerTyped: b.triggerTyped,
        triggerModel: b.triggerModel,
        contextTokens: b.contextTokens,
        descriptionTokens: kind === "skill" ? (inv.skills.get(name)?.descriptionTokens ?? 0) : 0,
        attributedTurns: b.attributedTurns,
        attributedTokens: b.attributedTokens,
        attributedCostMicros: b.attributedCostMicros,
      });
    }

    // Installed but never invoked, per agent. Reported against that agent's most
    // recent active day so it lands in the window the dashboard is showing, and
    // not at all for an agent that never ran in the window. This is the row that
    // only a local collector can produce.
    for (const agent of ["claude-code", "codex"] as const) {
      const anchor = [...(activeDates.get(agent) ?? [])].sort().pop();
      if (!anchor) continue;
      const inv = inventories[agent];
      for (const [kind, entries] of [
        ["skill", inv.skills],
        ["command", inv.commands],
      ] as const) {
        // What already fired, by artifact. A skill invoked under one of its names
        // must not come back as never-fired under another: the same plugin skill
        // reaches the model as `<plugin>:<skill>` and bare, and a directory-scoped
        // project skill as `apps/web:deploy` and `deploy`.
        const fired = new Set<string>();
        for (const r of out) {
          if (r.agent !== agent || r.kind !== kind) continue;
          const at = entries.get(r.name)?.realPath;
          if (at) fired.add(at);
        }
        for (const [name, entry] of entries) {
          // An alias is a second name for an artifact already listed; reporting
          // it would file one skill as two.
          if (entry.alias) continue;
          const used =
            fired.has(entry.realPath) ||
            out.some((r) => r.agent === agent && r.kind === kind && r.name === name);
          if (used) continue;
          out.push({
            agent,
            date: anchor,
            kind,
            name,
            invocations: 0,
            installed: true,
            triggerTyped: 0,
            triggerModel: 0,
            contextTokens: 0,
            descriptionTokens: kind === "skill" ? entry.descriptionTokens : 0,
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
}
