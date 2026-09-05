const messages = {
  loginOption: "allow team and organization usage reads within your current dashboard role",
  scopeOption: "self (default), team, or org; access follows your current role",
  teamOption: "one allowed team by exact name or ID; omit for all allowed teams",
  listOption: "list the reporting scopes and teams available to this device",
  help: "read usage for a personal, team or organization scope",
  skillHelp: "teach your coding agent to analyze authorized usage with kibble usage --json",
  invalidScope: "Use --scope self, team or org. --team requires --scope team.",
  invalidList: "Use --list-scopes without scope, team or date options.",
  reportingEnabled: "Reporting access enabled within your current role. Run kibble usage --list-scopes to see available teams. Ordinary kibble login restores personal-only reads.",
  reportingDisabled: "This device can read personal usage only. For role-based reporting, run kibble login --reporting.",
  unsupported: "The server did not confirm the requested reporting scope. Upgrade the server before using scoped reporting.",
  self: "Personal",
  team: "Teams",
  org: "Organization",
  scope: "Scope",
  role: "Role",
  available: "Available scopes",
  jsonHint: "Add --json to the same command for full day-by-day detail.",
};
export function usageText(key: keyof typeof messages): string {
  return messages[key];
}
