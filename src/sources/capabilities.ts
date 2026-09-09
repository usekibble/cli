import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { copilotCapabilityName, readCopilotConfig } from "./copilot-config.js";
import { vsCodeCapabilityInventory, vsCodeCapabilityInvocations } from "./vscode-capabilities.js";
import { vsCodeDataDirs } from "./vscode.js";
import type { Rec, TranscriptVisitor } from "./transcripts.js";
import { TranscriptDeduper } from "./transcript-dedup.js";
import { codexItem, codexSettings } from "./codex.js";
import { codexRoots } from "./codex-inventory.js";
import { codexCommandName, codexSkillSelections } from "./codex-capabilities.js";
import type { VsCodeRequest } from "./vscode.js";
import { cursorArtifact, readCursorInventory } from "./cursor-inventory.js";
import type { CursorAgentMetadata } from "./cursor-agent-metadata.js";

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
 *   - Codex personal/project .agents skills, CODEX_HOME skills and prompts,
 *     system skills, and enabled plugin roots from local config and manifests
 *     (codex-inventory.ts); from Codex session files the SERVER NAME of each
 *     `McpToolCall` item and the NAME of structured UserInput::Skill selections,
 *   - from Codex history.jsonl, only the bounded leading slash-command NAME,
 *     recognized against built-ins, installed commands or /prompts:name.
 *     Arguments and expanded prompts are never inspected. Codex capability
 *     attribution and implicit shell-based skill reads remain unobserved.
 *   - Copilot skills from its documented personal, project and installed
 *     plugin roots, plus skill names, triggers, body lengths and MCP server
 *     names from structured Copilot session events.
 *   - Cursor personal skill/command directories and last-observed project
 *     inventory snapshots, including nested skills and compatibility roots.
 *     Hooks derive snapshots from working-directory metadata, retaining names,
 *     description sizes and local-only alias hashes, never paths or bodies.
 *     Observation dates establish activity, never capability invocation counts.
 *   - Cursor's local agent graph supplies explicit command names and manually
 *     selected skill paths, resolved against inventory and discarded locally.
 *     Message identities deduplicate selections; content bytes are not decoded.
 *     Completed MCP steps supply a stable call ID and provider display name;
 *     arguments, results and scoped server identifiers are not decoded.
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
export type CapabilityAgent = "claude-code" | "codex" | "copilot" | "cursor";

export type CapabilityMetricKey = "invocations" | "triggerTyped" | "triggerModel" | "contextTokens" | "descriptionTokens" | "attributedTurns" | "attributedTokens" | "attributedCostMicros";

export interface UsageCounts {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface CapabilityRecord {
  /** Closed metric names only; unknown is distinct from no recorded use. */
  unavailableMetrics?: CapabilityMetricKey[];
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
 * Registers names against resolved artifacts for either agent's inventory.
 *
 * Name precedence stays with the first registration. A later name for the same
 * resolved path remains in the map for invocation lookup, but is marked as an
 * alias so the idle inventory emits the artifact once. Description sizing is
 * cached by resolved path for the same reason.
 */
function artifactRegistry(): {
  inventory: Inventory;
  add(
    kind: "skill" | "command",
    name: string,
    path: string,
    source: CapabilitySource,
  ): void;
} {
  const inventory: Inventory = {
    skills: new Map<string, InstalledCapability>(),
    commands: new Map<string, InstalledCapability>(),
  };
  const claimed = {
    skill: new Set<string>(),
    command: new Set<string>(),
  };
  const descriptions = new Map<string, number>();

  return {
    inventory,
    add(kind, name, path, source) {
      const entries = kind === "skill" ? inventory.skills : inventory.commands;
      if (!name || entries.has(name)) return;
      let realPath: string;
      try {
        realPath = realpathSync(path);
      } catch {
        return;
      }
      const alias = claimed[kind].has(realPath);
      claimed[kind].add(realPath);
      let descriptionTokens = 0;
      if (kind === "skill") {
        descriptionTokens = descriptions.get(realPath) ?? descriptionTokensFor(realPath);
        descriptions.set(realPath, descriptionTokens);
      }
      entries.set(name, {
        name,
        source,
        realPath,
        descriptionTokens,
        ...(alias ? { alias: true } : {}),
      });
    },
  };
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
      if (isDir && (existsSync(join(path, "SKILL.md")) || existsSync(join(path, "index.md")))) out.push({ name, path });
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
  const registry = artifactRegistry();

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
    for (const kind of ["skill", "command"] as const) {
      for (const e of listEntries(join(dir, kind === "skill" ? "skills" : "commands"), kind)) {
        const names =
          source === "plugin"
            ? [...prefixes.map((p) => `${p}:${e.name}`), e.name]
            : [e.name, ...prefixes.map((p) => `${p}:${e.name}`)];
        for (const name of names) registry.add(kind, name, e.path, source);
      }
    }
  }
  return registry.inventory;
}

/**
 * Every skill and custom prompt Codex can load on this machine.
 *
 * Personal, project, system and enabled plugin roots. Each real artifact is
 * registered once; disabled skills and inactive plugin versions are excluded.
 */
export function codexInventory(home = homedir(), cwds: Iterable<string> = []): Inventory {
  const registry = artifactRegistry();
  const { roots, disabled } = codexRoots(home, cwds);
  for (const root of roots) for (const e of listEntries(root.dir, root.kind)) {
    try { if (disabled.has(realpathSync(e.path))) continue; } catch { continue; }
    registry.add(root.kind, root.prefix ? `${root.prefix}:${e.name}` : e.name, e.path, root.source);
    if (root.prefix) registry.add(root.kind, e.name, e.path, root.source);
  }
  return registry.inventory;
}

/** Directories immediately below a path, with failures treated as an empty root. */
function directories(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

/**
 * Every Copilot skill and compatible Claude command this machine can load.
 *
 * Copilot's documented order is project .github, .agents, then .claude;
 * inherited copies; ~/.copilot then ~/.agents; and installed plugins. We only
 * need an installed/not-installed answer, but preserve that order so a repeated
 * name gets the same description Copilot advertises. Built-ins and remote
 * organization skills have no stable directory outside the installed CLI and
 * remain invocation-only, just like Claude Code's built-ins.
 */
export function copilotInventory(
  home = homedir(),
  cwds: Iterable<string> = [],
  root = join(home, ".copilot"),
  env: NodeJS.ProcessEnv = process.env,
): Inventory {
  const skills = new Map<string, InstalledCapability>();
  const commands = new Map<string, InstalledCapability>();
  const claimedSkills = new Set<string>();
  const claimedCommands = new Set<string>();

  const add = (
    map: Map<string, InstalledCapability>,
    claimed: Set<string>,
    entry: { name: string; path: string },
    source: CapabilitySource,
    withDescription: boolean,
  ) => {
    let name: string | null = copilotCapabilityName(entry.name);
    if (withDescription) {
      try {
        const text = readFileSync(join(entry.path, "SKILL.md"), "utf8");
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
        if (!frontmatter) return;
        const metadata = parseYaml(frontmatter);
        name = copilotCapabilityName(metadata?.name);
      } catch {
        return;
      }
    }
    if (!name || map.has(name)) return;
    let realPath: string;
    try {
      realPath = realpathSync(entry.path);
    } catch {
      return;
    }
    const alias = claimed.has(realPath);
    claimed.add(realPath);
    map.set(name, {
      name,
      source,
      realPath,
      descriptionTokens: withDescription ? descriptionTokensFor(realPath) : 0,
      ...(alias ? { alias: true } : {}),
    });
  };

  const projectDirs = new Set<string>();
  for (const cwd of cwds) {
    let dir = cwd;
    for (let depth = 0; depth < 32; depth++) {
      if (!dir || dir === home) break;
      projectDirs.add(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const orderedProjects = [...projectDirs].sort(
    (a, b) => b.split(sep).length - a.split(sep).length || a.localeCompare(b),
  );
  for (const dir of orderedProjects) {
    for (const namespace of [".github", ".agents", ".claude"]) {
      for (const entry of listEntries(join(dir, namespace, "skills"), "skill")) {
        add(skills, claimedSkills, entry, "project", true);
      }
    }
    for (const entry of listEntries(join(dir, ".claude", "commands"), "command")) {
      add(commands, claimedCommands, entry, "project", false);
    }
  }

  for (const dir of [join(root, "skills"), join(home, ".agents", "skills")]) {
    for (const entry of listEntries(dir, "skill")) {
      add(skills, claimedSkills, entry, "personal", true);
    }
  }
  for (const entry of listEntries(join(home, ".claude", "commands"), "command")) {
    add(commands, claimedCommands, entry, "personal", false);
  }

  const config = { ...readCopilotConfig(join(root, "config.json")), ...readCopilotConfig(join(root, "settings.json")) };
  const custom = [
    ...(env.COPILOT_SKILLS_DIRS ?? "").split(","),
    ...(Array.isArray(config.skillDirectories) ? config.skillDirectories : []),
  ];
  for (const dir of custom) {
    if (typeof dir !== "string" || !dir.trim()) continue;
    const path = dir.trim().replace(/^~(?=[/\\])/, home);
    for (const entry of listEntries(path, "skill")) add(skills, claimedSkills, entry, "personal", true);
  }

  const installed = join(root, "installed-plugins");
  const pluginDirs = directories(installed).flatMap((marketplace) => [
    marketplace,
    ...directories(marketplace),
  ]);
  for (const plugin of pluginDirs) {
    const manifest = [".plugin/plugin.json", "plugin.json", ".github/plugin/plugin.json", ".claude-plugin/plugin.json"]
      .map((path) => readCopilotConfig(join(plugin, path))).find(Boolean);
    if (!manifest) continue;
    for (const [kind, defaults] of [["skill", "skills"], ["command", "commands"]] as const) {
      const raw = manifest[defaults] ?? defaults;
      const paths = Array.isArray(raw) ? raw : [raw];
      for (const path of paths) {
        if (typeof path !== "string") continue;
        for (const entry of listEntries(join(plugin, path), kind)) {
          add(kind === "skill" ? skills : commands, kind === "skill" ? claimedSkills : claimedCommands, entry, "plugin", kind === "skill");
        }
      }
    }
  }

  return { skills, commands };
}

/** Cursor discovers nested skills, including its documented compatibility roots.
 * Only directory names and description sizes are retained. A real-path walk
 * prevents linked category directories from cycling or duplicating artifacts.
 */
export function cursorInventory(home = homedir(), cwds: Iterable<string> = []): Inventory {
  const registry = artifactRegistry();
  const visited = new Set<string>();
  function skills(dir: string, source: CapabilitySource): void {
    let real: string;
    try { real = realpathSync(dir); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("could not inspect Cursor skill inventory");
    }
    if (visited.has(real)) return;
    visited.add(real);
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      let directory: boolean;
      try { directory = statSync(path).isDirectory(); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error("could not inspect Cursor skill entry");
      }
      if (!directory) continue;
      if (existsSync(join(path, "SKILL.md"))) registry.add("skill", name, path, source);
      else skills(path, source);
    }
  }
  const projects = new Set<string>();
  for (const cwd of cwds) {
    if (!isAbsolute(cwd)) continue;
    let dir = cwd;
    for (let depth = 0; depth < 32 && dir !== home; depth++) {
      projects.add(dir);
      if (existsSync(join(dir, ".git"))) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const roots: [string, CapabilitySource][] = [...projects].map(dir => [dir, "project"]);
  roots.push([home, "personal"]);
  for (const [dir, source] of roots) {
    for (const root of [".cursor", ".agents", ".claude", ".codex"]) skills(join(dir, root, "skills"), source);
    for (const entry of listEntries(join(dir, ".cursor", "commands"), "command")) {
      registry.add("command", entry.name, entry.path, source);
    }
  }
  // Cursor 3.19.13 installs its managed built-ins here. Presence establishes
  // installed inventory only, not enabled state or a recorded invocation.
  skills(join(home, ".cursor", "skills-cursor"), "personal");
  return registry.inventory;
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
 * transcript feeds this and `repos.ts` together (`transcripts.ts`). Invocation
 * identities survive file boundaries so copied records stay idempotent; typed
 * command and awaited-body state reset in `startFile`.
 */
export class CapabilityCollector {
  private readonly vscodeRequests: VsCodeRequest[] = [];
  private readonly vscodeCounted = new Set<string>();
  // Inventory rows anchor to the latest active day, and a fired artifact has
  // no separate idle row. Coverage therefore follows the whole scanned window;
  // finish also persists it on each VS Code day so later pushes cannot erase it.
  private readonly vscodeCoverage = new Map<CapabilityKind, Set<CapabilityMetricKey>>();
  private copilotCliActive = false;
  private readonly claudeSeen = new TranscriptDeduper();
  private readonly codexSeen = new TranscriptDeduper();
  /** No tool arguments or skill bodies: only explicitly serialized names. */
  vscode(r: VsCodeRequest): void {
    this.active("copilot", r.date);
    this.vscodeRequests.push(r);
  }
  private readonly cursorSelections = new Map<string, { date: string; commands: string[]; artifacts: string[] }>();
  private readonly cursorMcpCalls = new Map<string, { date: string; name: string; records: Set<string> }>();
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
  private readonly codexCwds = new Set<string>();
  /** Copilot contexts feed its .github, .agents and .claude project roots. */
  private readonly copilotCwds = new Set<string>();
  private readonly home: string;
  private readonly copilotHome: string;
  private readonly priceOf: (model: string, u: UsageCounts) => number;

  constructor(private readonly options: {
    since: string;
    until: string;
    home?: string;
    copilotHome?: string;
    vscodeUserDataDirs?: string[];
    /** Cost in micros for one record's usage, so rates match Lane A exactly. */
    priceOf?: (model: string, u: UsageCounts) => number;
  }) {
    this.home = options.home ?? homedir();
    this.copilotHome = options.copilotHome ?? join(this.home, ".copilot");
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

  /** Recorded usage establishes activity, but contains no capability invocations. */
  addCursorActivity(date: string): void {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date >= this.options.since && date <= this.options.until) this.active("cursor", date);
  }

  /** Explicit selections and completed MCP calls. Paths become local alias hashes. */
  addCursorSelection(row: CursorAgentMetadata & { skillArtifacts?: string[] }): void {
    for (const call of row.mcpCalls ?? []) {
      if (!Number.isSafeInteger(call.completedAtMs) || call.completedAtMs < 0 || call.completedAtMs > 8.64e15) throw new Error("Invalid Cursor MCP timestamp.");
      const date = new Date(call.completedAtMs).toISOString().slice(0, 10);
      if (date < this.options.since || date > this.options.until) continue;
      if (!call.name || call.name.length > 128 || /[/\\\u0000-\u001f\u007f]/.test(call.name)) throw new Error("Invalid Cursor MCP server name.");
      const key = JSON.stringify([row.conversationId, call.id]);
      const previous = this.cursorMcpCalls.get(key);
      if (previous && (previous.date !== date || previous.name !== call.name)) throw new Error("Conflicting Cursor MCP metadata.");
      const value = previous ?? { date, name: call.name, records: new Set<string>() };
      if (call.recordId !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(call.recordId)) throw new Error("Invalid Cursor MCP record identity.");
        value.records.add(call.recordId);
      }
      this.cursorMcpCalls.set(key, value);
      this.active("cursor", date);
    }
    const timestamp = row.startedAtMs ?? row.completedAtMs;
    if (timestamp === undefined) return;
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8.64e15) throw new Error("Invalid Cursor selection timestamp.");
    const date = new Date(timestamp).toISOString().slice(0, 10);
    if (date < this.options.since || date > this.options.until) return;
    const artifacts = new Set<string>(row.skillArtifacts ?? []);
    if ([...artifacts].some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error("Invalid Cursor selected artifact identity.");
    for (const path of row.skillPaths) {
      if (!isAbsolute(path) || !/(?:^|[/\\])SKILL\.md$/.test(path)) continue;
      try { artifacts.add(cursorArtifact(realpathSync(dirname(path)))); }
      catch (error) {
        // A removed skill can still match its previously captured local identity.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not resolve Cursor selected skill metadata.");
        artifacts.add(cursorArtifact(dirname(path)));
      }
    }
    const commands = [...new Set(row.commands)].sort();
    if (commands.some(name => !name || name.length > 128 || /[/\\\u0000-\u001f\u007f]/.test(name))) throw new Error("Invalid Cursor selected command name.");
    const selection = { date, commands, artifacts: [...artifacts].sort() };
    const key = JSON.stringify([row.conversationId, row.messageId]);
    const previous = this.cursorSelections.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(selection)) throw new Error("Conflicting Cursor selection metadata.");
    this.cursorSelections.set(key, selection);
    this.active("cursor", date);
  }

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

  addCodexCwd(cwd: string): void {
    if (cwd && !this.codexCwds.has(cwd)) {
      this.codexCwds.add(cwd);
      this.codexInventoryCache = null;
    }
  }

  private codexInventoryCache: Inventory | null = null;

  private codexInstalled(): Inventory {
    return this.codexInventoryCache ??= codexInventory(this.home, this.codexCwds);
  }

  /** A Copilot context harvested from a session skipped by the mtime floor. */
  addCopilotCwd(cwd: string): void {
    if (cwd) this.copilotCwds.add(cwd);
  }

  visitor(): TranscriptVisitor {
    const { claudeSeen, active, cwds, priceOf, options } = this;
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

        const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : null;
        const recordId = typeof rec.uuid === "string" ? rec.uuid : null;
        if (!claudeSeen.first("record", sessionId, recordId)) return;

        const message = (rec.message ?? {}) as Record<string, unknown>;
        const role = message.role;
        const content = message.content;

        // Claude Code stamps the records it considers a capability's own work.
        // Preferring that over any inference of ours: it is the agent's attribution.
        const attributedSkill = rec.attributionSkill;
        const attributedMcp = rec.attributionMcpServer;
        const usage = message.usage as UsageCounts | undefined;
        const attributedTokens = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0;
        if (usage && attributedTokens > 0 && (attributedSkill || attributedMcp)) {
          const requestId = String(rec.requestId ?? message.id ?? "");
          if (claudeSeen.first("attributed-response", sessionId, requestId || null)) {
            const target = attributedSkill
              ? at(date, "skill", String(attributedSkill))
              : at(date, "mcp", String(attributedMcp));
            target.attributedTurns += 1;
            target.attributedTokens += attributedTokens;
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

        for (const [index, blk] of content.entries()) {
          const b = blk as {
            type?: string;
            id?: string;
            name?: string;
            input?: Record<string, unknown>;
          };
          if (b?.type !== "tool_use" || !b.name) continue;
          const toolId = b.id ?? (recordId ? `${recordId}:${index}` : null);
          if (!claudeSeen.first("tool", sessionId, toolId)) continue;

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
   * UserMessage content can contain UserInput::Skill with a selected name.
   * Count those explicit requests and MCP completions. Automatic skill reads
   * through shell commands and capability cost attribution remain unobserved.
   */
  codexVisitor(): TranscriptVisitor {
    const { at, active, codexSeen, options } = this;
    let sessionId: string | null = null;
    let fileNumber = 0;
    return {
      startFile: () => { fileNumber += 1; sessionId = null; },
      record: (r: Rec) => {
        const payload = (r.payload ?? {}) as Record<string, unknown>;
        const cwd = codexSettings(r)?.cwd ?? (r.type === "session_meta" ? payload.cwd : undefined);
        if (typeof cwd === "string") this.addCodexCwd(cwd);
        if (r.type === "session_meta") {
          sessionId = typeof payload.id === "string" ? payload.id : null;
          return;
        }
        const date = String(r.timestamp ?? "").slice(0, 10);
        if (!date || date < options.since || date > options.until) return;
        if (r.type !== "event_msg" && r.type !== "turn_context") return;
        active("codex", date);
        if (r.type !== "event_msg") return;
        const item = codexItem(r);
        if (!item) return;
        const itemId = typeof item.id === "string" ? item.id : null;
        if (item.type === "UserMessage") {
          if (!codexSeen.first("skill-selection", sessionId ?? `anonymous-file:${fileNumber}`, itemId)) return;
          for (const name of codexSkillSelections(item)) {
            const skill = at("codex", date, "skill", name);
            skill.invocations += 1;
            skill.triggerTyped += 1;
          }
          return;
        }
        if (item.type !== "McpToolCall") return;
        if (!codexSeen.first("item", sessionId ?? `anonymous-file:${fileNumber}`, itemId)) return;
        const server = String(item.server ?? "").trim();
        if (server) at("codex", date, "mcp", server).invocations += 1;
      },
    };
  }

  /**
   * CLI history preserves some submitted slash commands that rollouts expand.
   * Read this one file once, independently of transcript replay. History has no
   * invocation id: two submissions in the same second must remain two uses.
   */
  codexHistoryVisitor(): TranscriptVisitor {
    return { record: (record) => {
      if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) return;
      const stamp = new Date(record.ts * 1000);
      if (!Number.isFinite(stamp.valueOf())) return;
      const date = stamp.toISOString().slice(0, 10);
      if (date < this.options.since || date > this.options.until) return;
      const name = codexCommandName(record.text, (candidate) => this.codexInstalled().commands.has(candidate));
      if (!name) return;
      const command = this.at("codex", date, "command", name);
      command.invocations += 1;
      command.triggerTyped += 1;
      this.active("codex", date);
    } };
  }

  /**
   * Capability facts from GitHub Copilot CLI's durable session events.
   *
   * skill.invoked carries the exact skill name, trigger and injected body. We
   * keep the name and body length only. tool.execution_start carries the MCP
   * server name separately from its arguments, so only that name is counted.
   * Copilot does not durably attribute later model tokens to a skill, so the
   * attribution columns remain zero rather than being inferred.
   */
  copilotVisitor(): TranscriptVisitor {
    const { active, options, copilotCwds } = this;
    const at = (date: string, kind: CapabilityKind, name: string) =>
      this.at("copilot", date, kind, name);
    const rememberContext = (raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const cwd = (raw as Record<string, unknown>).cwd;
      if (typeof cwd === "string" && cwd) copilotCwds.add(cwd);
    };
    const seenEvents = new Set<string>();
    return {
      record: (record: Rec) => {
        if (typeof record.id === "string") {
          if (seenEvents.has(record.id)) return;
          seenEvents.add(record.id);
        }
        const data =
          record.data && typeof record.data === "object" && !Array.isArray(record.data)
            ? (record.data as Record<string, unknown>)
            : {};
        if (record.type === "session.start" || record.type === "session.resume") rememberContext(data.context);
        else if (record.type === "session.context_changed") rememberContext(data);

        const date = String(record.timestamp ?? "").slice(0, 10);
        if (!date || date < options.since || date > options.until) return;
        if (
          record.type === "user.message" ||
          record.type === "assistant.turn_start" ||
          record.type === "session.shutdown" ||
          record.type === "skill.invoked" ||
          record.type === "tool.execution_start"
        ) {
          this.copilotCliActive = true;
          active("copilot", date);
        }

        if (record.type === "skill.invoked") {
          const name = copilotCapabilityName(data.name);
          if (!name) return;
          const bucket = at(date, "skill", name);
          bucket.invocations += 1;
          if (data.trigger === "user-invoked") bucket.triggerTyped += 1;
          else if (data.trigger === "agent-invoked") bucket.triggerModel += 1;
          if (typeof data.content === "string") bucket.contextTokens += approxTokens(data.content.length);
          return;
        }

        if (record.type === "tool.execution_start") {
          const server = copilotCapabilityName(data.mcpServerName);
          if (server) at(date, "mcp", server).invocations += 1;
          return;
        }

        // Accept a command name when present without touching its arguments.
        // Current CLI versions keep this event ephemeral, so ordinary logs
        // cannot establish command invocation counts.
        if (record.type === "command.execute") {
          const name = copilotCapabilityName(data.commandName);
          if (!name) return;
          const bucket = at(date, "command", name);
          bucket.invocations += 1;
          bucket.triggerTyped += 1;
        }
      },
    };
  }

  finish(): CapabilityRecord[] {
    const { home, cwds, copilotCwds, copilotHome, seen, activeDates } = this;
    const cliInventory = this.copilotCliActive ? copilotInventory(home, copilotCwds, copilotHome) : { skills: new Map<string, InstalledCapability>(), commands: new Map<string, InstalledCapability>() };
    const editorInventory = this.vscodeRequests.length ? vsCodeCapabilityInventory({
      home,
      cwds: this.vscodeRequests.flatMap((r) => r.cwd ? [r.cwd] : []),
      userDataDirs: this.options.vscodeUserDataDirs ?? vsCodeDataDirs({ home }),
    }) : null;
    if (editorInventory) for (const r of this.vscodeRequests) {
      const key = `${r.sessionId}|${r.requestId}`;
      if (this.vscodeCounted.has(key)) continue;
      this.vscodeCounted.add(key);
      for (const invocation of vsCodeCapabilityInvocations(r, editorInventory)) {
        const b = this.at("copilot", r.date, invocation.kind, invocation.name);
        b.invocations++;
        if (invocation.trigger === "typed") b.triggerTyped++;
        if (invocation.trigger === "model") b.triggerModel++;
      }
      for (const kind of ["skill", "command", "mcp"] as const) {
        const key = kind;
        const missing = this.vscodeCoverage.get(key) ?? new Set<CapabilityMetricKey>();
        for (const metric of ["contextTokens", "attributedTurns", "attributedTokens", "attributedCostMicros"] as const) missing.add(metric);
        // VS Code serializes tool result content but drops automatic skill
        // metadata. A typed selection is observable, the total skill use isn't.
        if (kind === "skill") { missing.add("invocations"); missing.add("triggerModel"); }
        if (r.promptNames.some((name) => !editorInventory.commands.has(name) && !editorInventory.typedSkills.has(name)) && kind !== "mcp") {
          missing.add("triggerTyped"); missing.add("invocations");
        }
        if (kind === "mcp") {
          missing.add("triggerTyped"); missing.add("triggerModel");
          if (r.tools.some((tool) => !tool.server && tool.name.startsWith("mcp_"))) missing.add("invocations");
        }
        this.vscodeCoverage.set(key, missing);
      }
    }
    const copilotInstalled: Inventory = { skills: new Map(cliInventory.skills), commands: new Map(cliInventory.commands) };
    if (editorInventory) for (const kind of ["skills", "commands"] as const) {
      const claimed = new Set([...copilotInstalled[kind].values()].map((entry) => entry.realPath));
      for (const [name, entry] of editorInventory[kind]) {
        if (copilotInstalled[kind].has(name)) continue;
        copilotInstalled[kind].set(name, { ...entry, ...(claimed.has(entry.realPath) ? { alias: true } : {}) });
        claimed.add(entry.realPath);
      }
    }
    const cursorProjects = readCursorInventory(home, this.options.since, this.options.until);
    for (const entry of cursorProjects) this.active("cursor", entry.date);
    const cursor = this.activeDates.has("cursor") ? cursorInventory(home) : { skills: new Map<string, InstalledCapability>(), commands: new Map<string, InstalledCapability>() };
    const projectNames = new Set<string>();
    const artifacts = new Set<string>();
    for (const entry of cursorProjects) {
      const key = `${entry.kind}:${entry.name}`;
      if (projectNames.has(key)) continue;
      projectNames.add(key);
      const artifact = `${entry.kind}:${entry.artifact}`;
      const entries = entry.kind === "skill" ? cursor.skills : cursor.commands;
      entries.set(entry.name, { name: entry.name, source: "project", realPath: `captured:${entry.artifact}`, descriptionTokens: entry.descriptionTokens, alias: artifacts.has(artifact) });
      artifacts.add(artifact);
    }
    // A personal symlink to a captured project artifact is still one skill.
    for (const [kind, entries] of [["skill", cursor.skills], ["command", cursor.commands]] as const) {
      for (const entry of entries.values()) if (entry.source !== "project" && artifacts.has(`${kind}:${cursorArtifact(entry.realPath)}`)) entry.alias = true;
    }
    const inventories: Record<CapabilityAgent, Inventory> = {
      "claude-code": inventory(home, cwds),
      codex: this.codexInstalled(),
      copilot: copilotInstalled,
      cursor,
    };

    // Rebuild this agent's selection buckets so finish() is repeatable. A path
    // becomes a reported name only when an inventoried artifact establishes it.
    for (const key of seen.keys()) if (key.startsWith("cursor|")) seen.delete(key);
    // Forked conversations preserve immutable steps. Join call identities via
    // shared record pointers before counting, including transitive replays.
    const groups = new Map<string, string>();
    const recordOwners = new Map<string, string>();
    const group = (key: string): string => {
      let root = key;
      while (groups.get(root) !== root) root = groups.get(root)!;
      while (key !== root) {
        const parent = groups.get(key)!;
        groups.set(key, root);
        key = parent;
      }
      return root;
    };
    for (const key of this.cursorMcpCalls.keys()) groups.set(key, key);
    for (const [key, call] of this.cursorMcpCalls) {
      for (const record of call.records) {
        const owner = recordOwners.get(record);
        if (owner === undefined) recordOwners.set(record, key);
        else {
          const previous = this.cursorMcpCalls.get(owner)!;
          if (previous.date !== call.date || previous.name !== call.name) throw new Error("Conflicting Cursor MCP record metadata.");
          groups.set(group(key), group(owner));
        }
      }
    }
    const counted = new Set<string>();
    for (const [key, call] of this.cursorMcpCalls) {
      const root = group(key);
      if (counted.has(root)) continue;
      counted.add(root);
      this.at("cursor", call.date, "mcp", call.name).invocations += 1;
    }
    for (const selection of this.cursorSelections.values()) {
      const names = new Set<string>();
      for (const artifact of selection.artifacts) {
        const entry = [...cursor.skills.values()].find(entry => !entry.alias &&
          (entry.realPath === `captured:${artifact}` || cursorArtifact(entry.realPath) === artifact));
        if (entry) names.add(entry.name);
      }
      for (const [kind, selected] of [["skill", names], ["command", selection.commands]] as const) {
        for (const name of selected) {
          const b = this.at("cursor", selection.date, kind, name);
          b.invocations += 1;
          b.triggerTyped += 1;
        }
      }
    }

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

    // Installed with no observed invocation, per agent. Cursor explicit
    // selections do not measure automatic use, so zeros cannot establish disuse.
    // Reported against that agent's most
    // recent active day so it lands in the window the dashboard is showing, and
    // not at all for an agent that never ran in the window. This is the row that
    // only a local collector can produce.
    for (const agent of ["claude-code", "codex", "copilot", "cursor"] as const) {
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

    // Persist uncertainty on the day it arose. Window-wide flags on a later
    // CLI row alone would be replaced by a future push that excludes this VS
    // Code day. Zero here is the observed count, explicitly marked incomplete,
    // not a claim that an installed capability did not fire.
    const copilotTemplates = new Map<string, CapabilityRecord>();
    const copilotGrains = new Set<string>();
    for (const row of out) if (row.agent === "copilot") {
      const key = `${row.kind}|${row.name}`;
      copilotTemplates.set(key, row);
      copilotGrains.add(`${row.date}|${key}`);
    }
    for (const date of new Set(this.vscodeRequests.map((request) => request.date))) {
      for (const [key, template] of copilotTemplates) {
        const grain = `${date}|${key}`;
        if (copilotGrains.has(grain) || !this.vscodeCoverage.get(template.kind)?.size) continue;
        out.push({
          ...template, date, invocations: 0, triggerTyped: 0, triggerModel: 0,
          contextTokens: 0, attributedTurns: 0, attributedTokens: 0,
          attributedCostMicros: 0,
        });
        copilotGrains.add(grain);
      }
    }

    for (const row of out) if (row.agent === "copilot") {
      const missing = new Set(this.vscodeCoverage.get(row.kind) ?? []);
      for (const key of ["attributedTurns", "attributedTokens", "attributedCostMicros"] as const) missing.add(key);
      // Ordinary Copilot CLI command events are ephemeral, unlike skill events.
      if (this.copilotCliActive && row.kind === "command") for (const key of ["invocations", "triggerTyped", "triggerModel", "contextTokens"] as const) missing.add(key);
      row.unavailableMetrics = [...missing].sort();
    }
    for (const row of out) if (row.agent === "cursor") {
      const missing: CapabilityMetricKey[] = ["contextTokens", "descriptionTokens", "attributedTurns", "attributedTokens", "attributedCostMicros", "triggerModel"];
      // Explicit selections measure typed use only, not automatic skill loads.
      if (row.kind === "skill") missing.push("invocations");
      if (row.kind === "mcp") missing.push("triggerTyped");
      row.unavailableMetrics = missing.sort();
    }
    return out.sort(
      (a, b) => a.date.localeCompare(b.date) || b.invocations - a.invocations,
    );
  }
}
