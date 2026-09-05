import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The `kibble-usage` skill: instructions that teach a coding agent to read
 * this machine's own usage back through `kibble usage --json` and analyse it.
 *
 * The skill is text in this file rather than a packaged asset because only
 * `dist/` ships to npm; embedding it keeps `kibble skill install` working
 * from any install without a files-list change. The agent it lands in gets no
 * credential: the command runs under the owner's account and the link token
 * stays in the CLI config, so the skill can only ask, never authenticate.
 */
const SKILL = `---
name: kibble-usage
description: Analyse this machine owner's AI coding agent spend and token usage from Kibble. Use when asked about token usage, AI spend, coding agent costs, usage trends, or which agents and models cost the most.
---

# Kibble usage analysis

Kibble tracks what AI coding agents spent, as counts only. This skill reads
the machine owner's own aggregates back from their Kibble server and analyses
them. The data is self-scoped: it is always and only the owner's usage, never
a teammate's, and it contains no prompts, file contents, or paths.

## Getting the data

Always pass \`--json\`. Without it the command prints a human summary that is
harder to parse. Pick the window with \`--range\` or an explicit pair of days:

\`\`\`bash
kibble usage --json --range day     # today so far (UTC)
kibble usage --json --range week    # last 7 days
kibble usage --json --range month   # last 30 days (default)
kibble usage --json --range 90d
kibble usage --json --since 2026-08-01 --until 2026-08-31   # both required, YYYY-MM-DD, UTC
\`\`\`

The command prints one JSON object to stdout and exits 0. On failure it
prints an error to stderr and exits 1:

- \`Not linked. Run 'kibble login' first.\` means this machine has no link
  token yet; ask the user to run \`kibble login\`, do not run it yourself.
- \`usage read failed (401): ...\` means the token was revoked; same fix.
- \`usage read failed (400): ...\` means the window was malformed; check the
  dates are YYYY-MM-DD, since <= until, and not in the future.
- \`unknown range\` means a typo in \`--range\`; the accepted words are day,
  week, month, 7d, 30d, 90d.

## The response, exactly

\`\`\`json
{
  "member": { "email": "dev@example.com" },
  "organization": { "name": "Acme" },
  "range": {
    "since": "2026-08-26", "until": "2026-09-01", "days": 7,
    "priorSince": "2026-08-19", "priorUntil": "2026-08-25",
    "clamped": false
  },
  "totals": {
    "costMicros": 3760000, "tokens": 86700,
    "billedMicros": 0, "estimatedMicros": 3760000, "activeMembers": 1
  },
  "prior": {
    "costMicros": 0, "tokens": 0,
    "billedMicros": 0, "estimatedMicros": 0, "activeMembers": 0
  },
  "daily": [
    { "date": "2026-08-26", "costMicros": 0, "isBilled": false },
    { "date": "2026-08-31", "costMicros": 1310000, "isBilled": false },
    { "date": "2026-09-01", "costMicros": 2450000, "isBilled": false }
  ],
  "byAgent": [
    { "label": "claude-code", "costMicros": 2450000, "tokens": 61300, "billedShare": 0 },
    { "label": "codex", "costMicros": 1310000, "tokens": 25400, "billedShare": 0 }
  ],
  "byModel": [
    { "label": "claude-fable-5", "costMicros": 2450000, "tokens": 61300, "billedShare": 0 },
    { "label": "gpt-5.2-codex", "costMicros": 1310000, "tokens": 25400, "billedShare": 0 }
  ],
  "detail": [
    { "date": "2026-09-01", "agent": "claude-code", "model": "claude-fable-5",
      "costMicros": 2450000, "tokens": 61300, "isBilled": false }
  ]
}
\`\`\`

Field by field:

- Money is integer \`costMicros\` everywhere: 1,000,000 micros is $1.00, so
  the \`totals.costMicros\` above is $3.76. Never treat it as a float of
  dollars.
- \`range\` is the window actually answered. \`priorSince..priorUntil\` is the
  equal-length window before it, which \`prior\` covers. \`clamped\` true
  means the plan's retention window cut the request short; say so instead of
  reading the shortfall as a drop to zero.
- \`totals\` and \`prior\`: \`billedMicros\` is vendor-billed truth,
  \`estimatedMicros\` is the local estimate; the server already merged them
  (billed wins a day), so \`costMicros\` is the one number to quote and the
  other two are its provenance, never parts of a sum.
- \`daily\` has one row per calendar day, zero-filled, for trends.
- \`byAgent\` and \`byModel\` are sorted by cost, largest first;
  \`billedShare\` is 0..1.
- \`detail\` is the finest grain the server keeps: one row per day, agent and
  model, newest first.
- \`tokens\` everywhere is the sum of input, output, cache read and cache write
  tokens. Reasoning tokens are already included in output and are not added
  again.

## Analyses worth doing

- Trend: compare \`totals\` with \`prior\` and read \`daily\` for the shape
  (steady, spiking, or one whale day).
- Mix: which agent and model carry the spend, from \`byAgent\` and
  \`byModel\`; flag a model whose share moved.
- Anomalies: from \`detail\`, days or models far off the owner's baseline.

State the date window with every claim. Format money as dollars with two
decimals. These are the owner's own numbers: report them plainly, and never
frame the analysis as surveillance of anyone else.
`;

const DIR_NAME = "kibble-usage";

/** Skill roots per agent: Claude Code always, Codex when it is installed. */
function roots(): { agent: string; dir: string; wanted: boolean }[] {
  const home = homedir();
  return [
    { agent: "claude-code", dir: join(home, ".claude", "skills", DIR_NAME), wanted: true },
    {
      agent: "codex",
      dir: join(home, ".codex", "skills", DIR_NAME),
      wanted: existsSync(join(home, ".codex")),
    },
  ];
}

export function skillInstall(): void {
  for (const root of roots()) {
    if (!root.wanted) {
      console.log(`skipped  ${root.agent} (not installed on this machine)`);
      continue;
    }
    mkdirSync(root.dir, { recursive: true });
    writeFileSync(join(root.dir, "SKILL.md"), SKILL);
    console.log(`installed  ${join(root.dir, "SKILL.md")}`);
  }
  console.log(
    '\nAsk your coding agent about "my AI usage this month" and it will read the data with `kibble usage --json`.',
  );
}

export function skillUninstall(): void {
  for (const root of roots()) {
    if (!existsSync(root.dir)) continue;
    rmSync(root.dir, { recursive: true });
    console.log(`removed  ${root.dir}`);
  }
}

/** Print the skill itself, for an agent whose skill root is somewhere else. */
export function skillShow(): void {
  console.log(SKILL);
}
