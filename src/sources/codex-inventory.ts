import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "smol-toml";
import { compare, valid } from "semver";
import { object } from "./codex.js";

export function codexHome(
  home = homedir(),
  env: NodeJS.ProcessEnv = home === homedir() ? process.env : {},
): string {
  return env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, ".codex");
}

export interface CodexRoot {
  dir: string;
  kind: "skill" | "command";
  source: "personal" | "project" | "plugin";
  prefix?: string;
}

/** Local discovery metadata only; never retain config credentials or skill bodies. */
export function codexRoots(home: string, cwds: Iterable<string>): { roots: CodexRoot[]; disabled: Set<string> } {
  const base = codexHome(home);
  const roots: CodexRoot[] = [];
  const projects = new Set<string>();
  for (const cwd of cwds) {
    if (!isAbsolute(cwd)) continue;
    let dir = cwd;
    for (let depth = 0; depth < 32 && dir !== home; depth++) {
      projects.add(dir);
      if (existsSync(join(dir, ".git"))) break;
      const parent = dirname(dir);
      if (dir === parent) break;
      dir = parent;
    }
  }
  for (const dir of projects) roots.push({ dir: join(dir, ".agents/skills"), kind: "skill", source: "project" });
  roots.push(
    { dir: join(home, ".agents/skills"), kind: "skill", source: "personal" },
    { dir: join(base, "skills"), kind: "skill", source: "personal" },
    { dir: join(base, "skills/.system"), kind: "skill", source: "personal" },
    { dir: join(base, "prompts"), kind: "command", source: "personal" },
  );
  if (home === homedir()) roots.push({ dir: "/etc/codex/skills", kind: "skill", source: "personal" });

  let config: Record<string, unknown> = {};
  try { config = parse(readFileSync(join(base, "config.toml"), "utf8")); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("could not read Codex inventory configuration");
  }
  const disabled = new Set<string>();
  const rules = object(config.skills).config;
  if (Array.isArray(rules)) for (const rule of rules) {
    const r = object(rule);
    if (r.enabled !== false || typeof r.path !== "string") continue;
    try { disabled.add(realpathSync(dirname(r.path))); } catch { /* missing skill cannot load */ }
  }

  // Codex core-plugins/store.rs: local wins, otherwise greatest semver (lexical
  // order for non-semver names). Only configured enabled plugins are eligible.
  for (const [id, value] of Object.entries(object(config.plugins))) {
    if (object(value).enabled !== true) continue;
    const at = id.lastIndexOf("@");
    if (at <= 0) continue;
    const plugin = id.slice(0, at), marketplace = id.slice(at + 1);
    if (![plugin, marketplace].every((s) => /^[\w.-]+$/.test(s) && s !== "." && s !== "..")) continue;
    const cache = join(base, "plugins/cache", marketplace, plugin);
    let versions: string[];
    try { versions = readdirSync(cache, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { continue; }
    const version = versions.includes("local") ? "local" : versions.sort((a, b) => valid(a) && valid(b) ? compare(a, b) : a < b ? -1 : a > b ? 1 : 0).pop();
    if (!version) continue;
    const dir = join(cache, version);
    let manifest: Record<string, unknown> = {};
    for (const candidate of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
      try { manifest = object(JSON.parse(readFileSync(join(dir, candidate), "utf8"))); break; }
      catch { /* legacy plugins use the same default directories */ }
    }
    for (const kind of ["skill", "command"] as const) {
      const field = manifest[kind === "skill" ? "skills" : "commands"];
      const paths = typeof field === "string" ? [field] : Array.isArray(field) ? field : [kind === "skill" ? "skills" : "commands"];
      for (const path of paths) {
        if (typeof path !== "string") continue;
        const root = resolve(dir, path), rel = relative(dir, root);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        roots.push({ dir: root, kind, source: "plugin", prefix: plugin });
      }
    }
  }
  return { roots, disabled };
}
