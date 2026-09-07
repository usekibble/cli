import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { copilotCapabilityName, readCopilotConfig } from "./copilot-config.js";
import type { CapabilitySource, InstalledCapability, Inventory } from "./capabilities.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const pathKey = (path: string): string => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

export interface VsCodeCapabilityInventory extends Inventory {
  /** Names exposed in the slash menu, not skills with user-invocable: false. */
  typedSkills: Set<string>;
  /** Remote artifacts, extension contributions and historical profile selection are not exhaustive. */
  complete: boolean;
}

export interface VsCodeCapabilityOptions {
  home: string;
  cwds?: Iterable<string>;
  /** VS Code user-data roots. Paths remain local and are never capability fields. */
  userDataDirs: Iterable<string>;
  /** Resolved profile disablement from chat.disabledPromptFiles.skill, if available. */
  disabledSkillPaths?: ReadonlySet<string>;
}

function children(path: string): string[] {
  try { return readdirSync(path).sort(); } catch { return []; }
}

function settingsAt(path: string): Obj {
  if (!existsSync(path)) return {};
  const settings = readCopilotConfig(path);
  if (!settings) throw new Error("Cannot read VS Code capability settings");
  return settings;
}

// sql.js initializes asynchronously, while the existing shared sidecar scan is
// synchronous. One bounded child reads only these exact profile storage keys;
// never SELECT * or accept caller-supplied SQL. It opens an in-memory snapshot
// and never writes/exports it, so the editor's live state cannot be modified.
const profileReader = `
import { readFileSync, statSync, existsSync } from 'node:fs';
try {
  const databasePath = process.argv[1];
  const before = statSync(databasePath);
  if (before.size > 67108864) throw new Error();
  const journalActive = () => ['-wal', '-journal'].some(suffix => existsSync(databasePath + suffix) && statSync(databasePath + suffix).size > 0);
  if (journalActive()) throw new Error();
  const bytes = readFileSync(databasePath);
  const after = statSync(databasePath);
  if (journalActive() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error();
  const { default: init } = await import(process.argv[2]);
  const SQL = await init();
  const db = new SQL.Database(bytes);
  const stmt = db.prepare("SELECT key, value FROM ItemTable WHERE key IN ('chat.disabledPromptFiles.skill', 'chat.disabledPromptFiles.prompt', 'agentPlugins.enablement')");
  const result = { skill: [], prompt: [], plugins: [] };
  try {
    while (stmt.step()) {
      const [key, raw] = stmt.get();
      const value = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      const entries = JSON.parse(value);
      if (!Array.isArray(entries)) throw new Error();
      if (key === 'agentPlugins.enablement') {
        result.plugins = entries.map(entry => {
          if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'boolean') throw new Error();
          return entry[0].startsWith('file:') ? [entry[0], entry[1]] : null;
        }).filter(Boolean);
        continue;
      }
      result[key.endsWith('.skill') ? 'skill' : 'prompt'] = entries.map(entry => {
        if (typeof entry === 'string') return entry.startsWith('file:') ? entry : null;
        if (entry && entry.scheme === 'file' && typeof entry.path === 'string') return { scheme: 'file', path: entry.path, authority: typeof entry.authority === 'string' ? entry.authority : '' };
        return null;
      }).filter(Boolean);
    }
  } finally { stmt.free(); db.close(); }
  process.stdout.write(JSON.stringify(result));
} catch { process.exitCode = 1; }
`;

interface CapabilityState { skills: Set<string>; commands: Set<string>; plugins: Map<string, boolean> }

function capabilityState(databasePath: string): CapabilityState {
  const result: CapabilityState = { skills: new Set(), commands: new Set(), plugins: new Map() };
  if (!existsSync(databasePath)) return result;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", profileReader, databasePath, import.meta.resolve("sql.js")], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  if (child.error || child.status !== 0) throw new Error("Cannot read VS Code capability enablement");
  try {
    const records = object(JSON.parse(child.stdout));
    for (const [key, target] of [["skill", result.skills], ["prompt", result.commands]] as const) {
      for (const entry of Array.isArray(records[key]) ? records[key] as unknown[] : []) {
        const value = object(entry);
        const uri = typeof entry === "string" ? entry
          : value.scheme === "file" && typeof value.path === "string"
            ? `file://${typeof value.authority === "string" ? value.authority : ""}${value.path}` : null;
        if (!uri) continue;
        try { target.add(realpathSync(fileURLToPath(uri))); } catch { /* Disabled, removed file. */ }
      }
    }
    for (const entry of Array.isArray(records.plugins) ? records.plugins : []) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "boolean") throw new Error();
      // Enablement keys identify the configured URI, not a symlink's target.
      // Resolve lexical paths consistently without replacing that identity.
      result.plugins.set(pathKey(fileURLToPath(entry[0])), entry[1]);
    }
  } catch { throw new Error("Invalid VS Code capability enablement"); }
  return result;
}

function frontmatter(path: string): Obj {
  // Only frontmatter metadata is retained. Body, description and argument hints
  // never escape this function; description is reduced to a character count.
  const text = readFileSync(path, "utf8");
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  const metadata = header ? object(parseYaml(header)) : {};
  return {
    name: copilotCapabilityName(metadata.name),
    descriptionLength: typeof metadata.description === "string" ? metadata.description.length : 0,
    userInvocable: metadata["user-invocable"] !== false,
    modelInvocable: metadata["disable-model-invocation"] !== true,
  };
}

const skillLocations = {
  ".agents/skills": true, ".github/skills": true, ".claude/skills": true,
  "~/.agents/skills": true, "~/.copilot/skills": true, "~/.claude/skills": true,
};

/** Full prompt globs are intentionally not approximated here. VS Code's owner
 * is ISearchService.fileSearch: deepest non-glob folder; case-insensitive file
 * pattern; files.exclude + search.exclude (including sibling `when` clauses);
 * provider ignore handling, including .gitignore/.ignore/.rgignore and the
 * explorer.excludeGitIgnore-derived disregardIgnoreFiles setting. The CLI has
 * no direct equivalent. globby offers synchronous filesystem/glob/ignore APIs,
 * but those alone do not prove matching provider/exclusion precedence.
 * https://github.com/microsoft/vscode/blob/1.135.0/src/vs/workbench/contrib/chat/common/promptSyntax/utils/promptFilesLocator.ts
 * https://github.com/sindresorhus/globby#api
 */

function pluginToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_.:-]/g, "-")
    .replace(/-+/g, "-").replace(/^[-:.]+|[-:.]+$/g, "");
}

function pluginName(prefix: string, value: string): string {
  const name = pluginToken(value);
  return name === prefix || name.startsWith(`${prefix}:`) ? name : `${prefix}:${name}`;
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

interface PluginDefinition { root: string; prefix: string; manifest: Obj; agentFormat: boolean }
function pluginDefinition(path: string): PluginDefinition | null {
  try { if (!statSync(path).isDirectory()) return null; } catch { return null; }
  const rootManifest = readCopilotConfig(join(path, "plugin.json"));
  const schema = rootManifest?.$schema;
  const agentFormat = typeof schema === "string" && schema.startsWith("https://agent-plugins.org/schemas/") && schema.endsWith("/plugin.schema.json");
  const manifestPath = agentFormat ? join(path, "plugin.json")
    : existsSync(join(path, ".plugin/plugin.json")) ? join(path, ".plugin/plugin.json")
    : path.split(sep).includes(".claude") || existsSync(join(path, ".claude-plugin/plugin.json")) ? join(path, ".claude-plugin/plugin.json")
    : join(path, "plugin.json");
  const manifest = existsSync(manifestPath) ? settingsAt(manifestPath) : {};
  const prefix = pluginToken(typeof manifest.name === "string" && manifest.name.trim() ? manifest.name : basename(path));
  return prefix ? { root: path, prefix, manifest, agentFormat } : null;
}

function pluginComponentPaths(plugin: PluginDefinition, kind: "skill" | "command"): string[] {
  const component = kind === "skill" ? "skills" : "commands";
  const namespace = "com.github.copilot";
  const section = plugin.agentFormat ? object(object(plugin.manifest.extensions)[namespace])[component] : plugin.manifest[component];
  const configuration = object(section);
  const rawPaths = typeof section === "string" ? [section] : Array.isArray(section) ? section : configuration.paths;
  const paths = Array.isArray(rawPaths) ? rawPaths.filter((p): p is string => typeof p === "string" && !!p.trim()).map((p) => p.trim()) : [];
  const exclusive = Array.isArray(configuration.paths) && configuration.exclusive === true;
  const base = plugin.agentFormat ? join(plugin.root, namespace) : plugin.root;
  const defaults = plugin.agentFormat && kind === "command" ? join(plugin.root, namespace, component) : join(plugin.root, component);
  return [...new Set([
    ...(exclusive ? [] : [defaults]),
    ...paths.map((path) => join(base, path)).filter((path) => contained(base, path)),
  ])];
}

/**
 * VS Code's inventory is not the Copilot CLI inventory: different settings,
 * prompt folders and parent-workspace discovery apply. Defaults and canonical
 * folder names follow VS Code 1.135 promptFileLocations/promptsServiceImpl.
 * https://github.com/microsoft/vscode/blob/1.135.0/src/vs/workbench/contrib/chat/common/promptSyntax/config/promptFileLocations.ts
 */
export function vsCodeCapabilityInventory(options: VsCodeCapabilityOptions): VsCodeCapabilityInventory {
  const inventory: VsCodeCapabilityInventory = {
    skills: new Map(), commands: new Map(), typedSkills: new Set(), complete: false,
  };
  const claimed = { skill: new Set<string>(), command: new Set<string>() };
  const profiles: { path: string; user: string }[] = [];
  for (const root of options.userDataDirs) {
    const user = join(root, "User");
    if (!existsSync(user)) continue;
    profiles.push({ path: user, user });
    for (const profile of children(join(user, "profiles"))) profiles.push({ path: join(user, "profiles", profile), user });
  }
  const stateCache = new Map<string, CapabilityState>();
  const stateAt = (path: string) => {
    let state = stateCache.get(path);
    if (!state) { state = capabilityState(path); stateCache.set(path, state); }
    return state;
  };
  const workspaceStates = new Map<string, Map<string, boolean>>();
  const workspacePlugins = (user: string, cwd: string | null): Map<string, boolean> => {
    if (!cwd) return new Map();
    const key = `${user}|${cwd}`;
    const cached = workspaceStates.get(key);
    if (cached) return cached;
    const states: { mtime: number; plugins: Map<string, boolean> }[] = [];
    const storage = join(user, "workspaceStorage");
    for (const name of children(storage)) {
      const metadataPath = join(storage, name, "workspace.json");
      if (!existsSync(metadataPath)) continue;
      const folder = settingsAt(metadataPath).folder;
      if (typeof folder !== "string") continue;
      let folderPath: string;
      try { folderPath = fileURLToPath(folder); } catch { continue; }
      if (pathKey(folderPath) !== pathKey(cwd)) continue;
      const databasePath = join(storage, name, "state.vscdb");
      const plugins = stateAt(databasePath).plugins;
      states.push({ mtime: existsSync(databasePath) ? statSync(databasePath).mtimeMs : 0, plugins });
    }
    // A migrated storage copy must not re-enable a plugin disabled in its latest state.
    states.sort((a, b) => b.mtime - a.mtime);
    const plugins = states[0]?.plugins ?? new Map<string, boolean>();
    workspaceStates.set(key, plugins);
    return plugins;
  };
  let disabled = { skills: new Set<string>(), commands: new Set<string>() };
  const add = (kind: "skill" | "command", path: string, source: CapabilitySource, plugin?: PluginDefinition) => {
    try {
      const realPath = realpathSync(path);
      if (!statSync(realPath).isFile()) return;
      if (plugin?.agentFormat && !contained(realpathSync(plugin.root), realPath)) return;
      if ((kind === "skill" ? disabled.skills : disabled.commands).has(realPath)) return;
      if (kind === "skill" && options.disabledSkillPaths?.has(realPath)) return;
      const metadata = frontmatter(realPath);
      // The editor deliberately falls back to the skill's directory name even
      // when frontmatter names a different skill. Do not use the symlink target's name.
      const name = kind === "skill" ? basename(dirname(path))
        : metadata.name ?? basename(path).replace(plugin ? /\.md$/i : /\.prompt\.md$/i, "");
      if (!copilotCapabilityName(name)) return;
      if (kind === "skill" && !/^[a-z0-9-]{1,64}$/.test(String(name))) return;
      if (kind === "skill" && !metadata.userInvocable && !metadata.modelInvocable) return;
      const map = kind === "skill" ? inventory.skills : inventory.commands;
      const artifactPath = kind === "skill" ? dirname(realPath) : realPath;
      const names = plugin ? [pluginName(plugin.prefix, String(name)), ...(kind === "skill" ? [String(name)] : [])] : [String(name)];
      for (const [index, candidate] of names.entries()) {
        if (!copilotCapabilityName(candidate) || map.has(candidate)) continue;
        const alias = claimed[kind].has(artifactPath);
        claimed[kind].add(artifactPath);
        const entry: InstalledCapability = {
          name: candidate, source, realPath: artifactPath,
          descriptionTokens: Math.round(Number(metadata.descriptionLength) / 4),
          ...(alias ? { alias: true } : {}),
        };
        map.set(entry.name, entry);
        if (kind === "skill" && metadata.userInvocable && index === 0) inventory.typedSkills.add(entry.name);
      }
    } catch { /* Broken links, missing files and invalid frontmatter are not loadable. */ }
  };
  const scan = (kind: "skill" | "command", dir: string, source: CapabilitySource) => {
    if (kind === "command" && dir.toLowerCase().endsWith(".prompt.md")) {
      add(kind, dir, source); return;
    }
    for (const name of children(dir)) {
      if (kind === "skill") {
        const folder = join(dir, name);
        const file = children(folder).find((entry) => entry.toLowerCase() === "skill.md");
        if (file) add(kind, join(folder, file), source);
      } else if (name.toLowerCase().endsWith(".prompt.md")) add(kind, join(dir, name), source);
    }
  };
  const scanPlugin = (plugin: PluginDefinition, skillsEnabled: boolean) => {
    for (const kind of ["skill", "command"] as const) {
      if (kind === "skill" && !skillsEnabled) continue;
      const files = new Set<string>();
      for (const dir of pluginComponentPaths(plugin, kind)) {
        if (kind === "skill") {
          if (!plugin.agentFormat && existsSync(join(dir, "SKILL.md"))) files.add(join(dir, "SKILL.md"));
          else for (const name of children(dir)) {
            const file = join(dir, name, "SKILL.md");
            if (existsSync(file)) files.add(file);
          }
        } else {
          try {
            if (statSync(dir).isFile() && dir.toLowerCase().endsWith(".md")) files.add(dir);
            else for (const name of children(dir)) if (name.toLowerCase().endsWith(".md")) files.add(join(dir, name));
          } catch { /* Missing component directory. */ }
        }
      }
      if (kind === "skill" && !plugin.agentFormat && files.size === 0 && existsSync(join(plugin.root, "SKILL.md"))) files.add(join(plugin.root, "SKILL.md"));
      for (const path of files) add(kind, path, "plugin", plugin);
    }
  };
  const contexts = [...new Set(options.cwds ?? [])];
  // A saved workspace proves discovery context, not every ancestor on disk.
  for (const { path: profile, user } of profiles) {
    const profileState = stateAt(join(profile, "globalStorage", "state.vscdb"));
    disabled = profileState;
    const userSettings = settingsAt(join(profile, "settings.json"));
    const contextsOrEmpty: (string | null)[] = contexts.length ? contexts : [null];
    for (const cwd of contextsOrEmpty) {
      const workspaceSettings = cwd ? settingsAt(join(cwd, ".vscode", "settings.json")) : {};
      const settings = { ...userSettings, ...workspaceSettings };
      const roots = cwd ? [cwd] : [];
      if (cwd && settings["chat.useCustomizationsInParentRepositories"] === true) {
        const parents: string[] = [];
        let dir = cwd;
        for (let depth = 0; depth < 32 && dir !== options.home; depth++) {
          if (existsSync(join(dir, ".git"))) { roots.push(...parents); break; }
          const parent = dirname(dir);
          if (parent === dir) break;
          parents.push(parent); dir = parent;
        }
      }
      for (const kind of ["skill", "command"] as const) {
        if (kind === "skill" && settings["chat.useAgentSkills"] === false) continue;
        const key = kind === "skill" ? "chat.agentSkillsLocations" : "chat.promptFilesLocations";
        const locations = { ...(kind === "skill" ? skillLocations : { ".github/prompts": true }),
          ...object(userSettings[key]), ...object(workspaceSettings[key]) };
        // Workspaces win over personal copies with the same name.
        for (const personal of [false, true]) for (const [configuredLocation, enabled] of Object.entries(locations)) {
          // resolveSearchLocation treats a sole final '*' as a literal folder:
          // resolveFilesAtLocation lists immediate children, without search
          // ignores or recursion. Other globs still need the editor's search
          // semantics and must not use this shortcut.
          const location = kind === "command" && configuredLocation.endsWith("/*")
            ? configuredLocation.slice(0, -1) : configuredLocation;
          if (enabled !== true || location.startsWith("~/") !== personal) continue;
          if (/[?*{}[\]]/.test(location)) continue;
          if (kind === "skill" && (!location.trim() || location.includes("\\") || /^~(?!\/)/.test(location) || win32.isAbsolute(location))) continue;
          if (isAbsolute(location)) {
            if (kind === "command") scan(kind, location, "personal");
            continue;
          }
          if (personal) scan(kind, join(options.home, location.slice(2)), "personal");
          else for (const root of roots) scan(kind, join(root, location), "project");
        }
        // Legacy user prompt files remain loaded from the active profile.
        if (kind === "command") scan(kind, join(profile, "prompts"), "personal");
      }
      if (settings["chat.plugins.enabled"] !== false) {
        const overrides = workspacePlugins(user, cwd);
        const locations = { ...object(userSettings["chat.pluginLocations"]), ...object(workspaceSettings["chat.pluginLocations"]) };
        const plugins = new Map<string, PluginDefinition>();
        for (const [location, enabled] of Object.entries(locations)) {
          const value = location.trim();
          if (enabled === false || !value || /[*?{}[\]]/.test(value)) continue;
          const path = value === "~" ? options.home : value.startsWith("~/") ? join(options.home, value.slice(2))
            : isAbsolute(value) ? resolve(value) : cwd ? resolve(cwd, value) : null;
          if (!path || (overrides.get(pathKey(path)) ?? profileState.plugins.get(pathKey(path)) ?? true) === false) continue;
          const plugin = pluginDefinition(path);
          if (plugin) plugins.set(path, plugin);
        }
        for (const plugin of [...plugins.values()].sort((a, b) => a.root.localeCompare(b.root))) scanPlugin(plugin, settings["chat.useAgentSkills"] !== false);
      }
    }
  }
  return inventory;
}

export interface VsCodeCapabilityInvocation {
  kind: "skill" | "command" | "mcp";
  name: string;
  trigger: "typed" | "model" | null;
}

export interface VsCodeCapabilityRequest {
  command?: string | null;
  promptNames?: readonly string[];
  explicitCapabilities?: readonly { kind: "skill" | "command"; name: string }[];
  tools: readonly { id: string; server?: string | null }[];
}

/** Names come from structured parser parts/tool metadata, never message text,
 * tool arguments, reference paths or tool output. Unknown prompt names are not
 * classified as skills merely because they look like a slash command. */
export function vsCodeCapabilityInvocations(
  request: VsCodeCapabilityRequest,
  inventory: VsCodeCapabilityInventory,
): VsCodeCapabilityInvocation[] {
  const out: VsCodeCapabilityInvocation[] = [];
  const selected = new Set<string>();
  const typed = (kind: "skill" | "command", value: unknown) => {
    const name = copilotCapabilityName(value);
    if (!name || selected.has(`${kind}|${name}`)) return;
    selected.add(`${kind}|${name}`);
    out.push({ kind, name, trigger: "typed" });
  };
  for (const entry of request.explicitCapabilities ?? []) {
    if (entry.kind === "skill" || entry.kind === "command") typed(entry.kind, entry.name);
  }
  if (request.command) typed("command", request.command);
  for (const name of request.promptNames ?? []) {
    // Prompt files have precedence in VS Code's slash-command discovery.
    if (inventory.commands.has(name)) typed("command", name);
    else if (inventory.typedSkills.has(name)) typed("skill", name);
  }
  const tools = new Set<string>();
  for (const tool of request.tools) {
    if (tools.has(tool.id)) continue;
    tools.add(tool.id);
    const server = copilotCapabilityName(tool.server);
    if (server) out.push({ kind: "mcp", name: server, trigger: null });
  }
  return out;
}
