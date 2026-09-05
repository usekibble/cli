# @usekibble/cli

Kibble (usekibble.com) is a Claude Code and Codex usage dashboard for teams.
This is its open-source collector. It reads the usage logs that coding agents (Claude Code,
Codex) already write on this machine and pushes a per-day summary to your
Kibble dashboard, so a team lead can see what every coding agent spent this
week, per engineer, team, model and repo.

Requires Node.js 20 or later.
The supported interface is the `kibble` command; modules under `dist/` are
internal implementation details.

```
npm install -g @usekibble/cli
kibble login        # OAuth device grant, links this machine
kibble push         # send today's counts now
kibble schedule status
```

`kibble login` installs a background push (hourly and at startup) via launchd,
cron or Task Scheduler when your organization asks for it.

## Collection and recovery

Every push automatically collects all supported local agents. The local adapter
uses the native parser for eight agents and a shared Codex token decoder for
Codex usage and session ids; the broader CLI parser
adds the remaining agents. The two sources never contribute usage for the same
agent in one push. Manual pushes, scheduled pushes and `kibble doctor` use this
same collector, with no parser option to configure.

Automatic pushes resume from the last accepted day, bounded to 30 days.
A targeted `--since` / `--until` push advances that cursor only when it covers
the outstanding interval. Replayed transcript records count once, and large
transcripts are read incrementally in the shared collection pass.

Configuration lives in `$XDG_CONFIG_HOME/kibble` when `XDG_CONFIG_HOME` is set,
or `~/.config/kibble` otherwise. Scheduled collection keeps the configuration
location used at installation. To switch servers, use `kibble login --server
<url>` so credentials and synchronization state belong to that destination.

To verify collection against local Claude Code transcripts:

```
pnpm build
node scripts/verify-accuracy.mjs YYYY-MM-DD YYYY-MM-DD
```

Choose a window containing usage. The check runs synthetic collection and
recovery fixtures and compares the default collector against raw
Claude totals. An empty window or a parser outside the accuracy tolerance
fails the check. It does not establish every agent's transcript accuracy.

## Claude Code and Codex metric coverage

Both paths report the same wire fields when their logs expose the evidence.
Repository and model cuts share a transcript walk. Codex daily totals use the
same token decoder as those cuts, including snapshot deduplication, model
changes, cache reads/writes and reasoning as a subset of output. The pinned
native Codex parser is excluded because it recounts repeated snapshots.

| Metric | Claude Code | Codex |
| --- | --- | --- |
| Tokens, estimated cost, response and session counts | Supported | Supported, including archived sessions |
| Repository and model attribution | Recorded cwd and model | Session/settings cwd and model |
| Tool calls and failures | Tool-use/result blocks | Supported classified items and legacy completion events |
| Tool and turn durations | Recorded duration fields | Recorded duration fields |
| Edits, hunks and changed lines | Structured edit metadata | Successful file-change diffs |
| Human turns, text/reasoning blocks, compactions | Supported records/blocks | Supported completed items |
| Hook completions/failures, stream retry errors | Supported events | Supported events |
| Skill and command inventory | Personal, project, installed plugins | Personal, project, system, enabled plugins |
| MCP invocation counts | Named MCP tool calls | MCP completion items/events |
| Explicit skill use | Skill calls and trigger metadata | Structured user skill selections, counted once per item/name |
| Named slash-command use | Recorded command markers | Recognized leading command names in local CLI history |
| Automatic skill use, capability-attributed tokens/cost | Recorded Claude metadata | Not observed |
| Cache-write TTL, iteration arrays, sidechain markers, user-modified edits | Recorded Claude metadata | No equivalent decoded field |

Missing fields and unsupported event formats are not proof of zero activity.
Tool kinds differ across agents, so spend per tool call is an average over each
agent's recorded tools. Repository cuts require attribution and need not cover
all daily usage. Inventory description sizes are character-based estimates,
not measured context billing. Codex skill selections and command submissions are recorded as user-triggered
requests, not proof of successful execution. The collector never infers automatic
skill use from shell command lines, prompt mentions or tool arguments.

Named Codex commands come from `$CODEX_HOME/history.jsonl`. Only a bounded
leading `/name` token is examined: built-in or installed commands, and explicit
`/prompts:name` submissions. Arguments and expanded prompts are not examined.
The history file is read once with capability reporting enabled; transcript
text is not counted again. Two submissions in the same second remain two uses.
Commands omitted from history and automatic skill reads remain outside coverage;
zero means no supported invocation was observed. Days containing only capability
activity can still be pushed without token rows.

Codex discovery includes project `.agents/skills`, `~/.agents/skills`,
`$CODEX_HOME/skills` (including `.system`), `$CODEX_HOME/prompts`, and enabled
plugins from `$CODEX_HOME/config.toml`. `CODEX_HOME` defaults to `~/.codex`.
The active plugin cache version is selected using Codex's local/semver rule;
disabled plugins and configured disabled skills are excluded. Discovery covers
local files, not remote skill resources or every project configuration overlay.
Symlink aliases produce one installed artifact. Roots, versions and configuration
contents stay on the machine.

## Reading your own numbers back

```
kibble usage                  # this month: totals, trend vs prior, by agent, by model
kibble usage --range week     # also: day, 90d, or --since/--until
kibble usage --json           # the full answer, for scripts and agents
kibble skill install          # teach your coding agent to analyse it
```

`kibble usage` reads back what you can already see on your own dashboard page,
and only that: the link token is scoped to its owner, so this can never show a
teammate's numbers. `kibble skill install` writes a `kibble-usage` skill into
`~/.claude/skills` (and `~/.codex/skills` when Codex is installed) so you can
ask your coding agent things like "what did my AI usage look like this month";
the agent runs `kibble usage --json` itself and the token never leaves the
CLI's config.

## What leaves this machine

Counts only: token totals, model names, opaque session ids, repository names,
and, while your organization has capability reporting switched on, the names of
the skills, slash commands and MCP servers installed here with recorded invocation counts where available. Codex counts explicit skill selections and recognized command submissions;
automatic skill use and commands omitted from history are outside coverage. Per agent, how this machine is billed: a subscription and its tier
(Max 5x, ChatGPT Pro), an API key, or a cloud provider's account. Never
prompts, file contents, tool arguments.

The billing mode is read from the login file each agent already keeps
(`~/.claude.json`, `~/.codex/auth.json`). Those files also hold account,
organization and machine ids, your email and live tokens; `src/sources/plans.ts`
copies out the mode and the tier and nothing else leaves.

Finding those skills means looking in three places: your `~/.claude`, the
`.claude` of each checkout you have worked in, and each installed plugin. The
checkouts come from the working directory your agent records in its own logs,
walked upwards until a `.claude` turns up. That directory is a path, so it is
read and discarded here and never sent, the same way repository names are
reduced before they leave. Which of the three a skill came from, and what
version it is, are worked out on this machine and are not sent either.

The server's ingest schema is strict, so a field it does not expect is a
rejected request. Every line this package sends is in `src/`, and it is short
enough to read.

## Links

- How to use Kibble, from install to reading the dashboard: https://usekibble.com/docs
- Dashboard and pricing: https://usekibble.com
- Source: https://github.com/usekibble/cli
- hello@usekibble.com

MIT.
