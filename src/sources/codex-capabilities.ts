import { object, text } from "./codex.js";
import type { Rec } from "./transcripts.js";

/** UserInput::Skill records the selected name separately from its private path. */
export function codexSkillSelections(item: Rec): string[] {
  if (item.type !== "UserMessage" || !Array.isArray(item.content)) return [];
  const names = new Set<string>();
  for (const input of item.content) {
    const selected = object(input);
    if (selected.type !== "skill") continue;
    const name = text(selected.name);
    // Do not read text, skill paths, descriptions or general mentions.
    if (name && /^[\w][\w.:-]{0,127}$/.test(name)) names.add(name);
  }
  return [...names];
}

// Codex's tui/src/slash_command.rs, plus the older /approvals spelling.
// An allowlist prevents an absolute path or arbitrary prose becoming a command.
const BUILTIN_COMMANDS = new Set([
  "model", "ide", "permissions", "approvals", "keymap", "vim",
  "setup-default-sandbox", "sandbox-add-read-dir", "experimental", "approve",
  "memories", "skills", "import", "hooks", "review", "rename", "new",
  "archive", "delete", "resume", "fork", "app", "init", "compact", "recap",
  "plan", "goal", "agents", "side", "btw", "copy", "export", "raw", "diff",
  "mention", "status", "cd", "pwd", "cwd", "usage", "debug-config", "title",
  "statusline", "theme", "pets", "pet", "mcp", "apps", "plugins", "logout",
  "quit", "exit", "feedback", "rollout", "ps", "stop", "clean", "clear",
  "personality", "test-approval", "subagents", "debug-m-drop", "debug-m-update",
]);

/**
 * A submitted slash command in history.jsonl, not a shell command or mention.
 * Examine only the bounded leading token and its delimiter, never arguments.
 * /prompts:name is explicit even if that prompt has since been uninstalled.
 */
export function codexCommandName(value: unknown, installed: (name: string) => boolean): string | null {
  if (typeof value !== "string" || value[0] !== "/") return null;
  let end = 1;
  while (end < value.length && end <= 136 && /[\w.:-]/.test(value[end]!)) end += 1;
  if (end === 1 || end > 136 || (end < value.length && !/\s/.test(value[end]!))) return null;
  const token = value.slice(1, end);
  const custom = token.startsWith("prompts:");
  const name = custom ? token.slice("prompts:".length) : token;
  if (!/^[\w][\w.:-]{0,127}$/.test(name)) return null;
  return custom || BUILTIN_COMMANDS.has(name) || installed(name) ? name : null;
}
