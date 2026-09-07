# @usekibble/cli

Kibble (usekibble.com) is a Claude Code, Codex and GitHub Copilot usage dashboard for teams.
This is its open-source collector. It reads the usage logs that coding agents (Claude Code,
Codex, GitHub Copilot CLI and Copilot Chat in VS Code) already write on this machine and pushes a per-day summary to your
Kibble dashboard, so a team lead can see what every coding agent spent this
week, per engineer, team, model and repo.

Requires Node.js 20 or later.
The supported interface is the `kibble` command; modules under `dist/` are
internal implementation details.

```
npm install -g @usekibble/cli
kibble login        # links this machine and sends initial usage when org policy is on
kibble push         # send usage manually, or retry a failed collection
kibble schedule status
```

`kibble login` sends the first usage immediately, then installs a background push
(hourly and at startup) via launchd, cron or Task Scheduler when your organization
asks for automatic collection. The first sync imports available usage from today
and the preceding 29 UTC days. Refresh My usage after the terminal confirms the
push. If automatic collection is off, login sends nothing: run `kibble push`
to import that history. Collection failures are reported in the terminal; retry
with `kibble push` or diagnose them with `kibble doctor`.

CLI prompts, help, status messages and errors are in English regardless of
the terminal locale.

## Automatic updates

After a successful interactive login, Kibble asks once whether this machine may
download and run new CLI versions approved by Kibble. Submit `y` or press Enter
to enable updates, or `n` to keep the current version. Closing the prompt or
pressing Ctrl-C does not enable updates. Your login and collection still work.
The saved choice survives re-login and logout, and is independent of your
organization's automatic collection policy.

For noninteractive setup, consent must be explicit:

```
kibble login --auto-update
```

```
kibble update                 # check for an approved update now
kibble update status          # preference, versions, last check and last error
kibble update disable         # keep collecting with the current version
kibble update enable          # opt in, or retry setup
kibble update rollback        # restore the previous version and disable updates
```

Enabling prepares a private installation beside your config, verifies startup
and both native parsers without reading transcripts, and moves any existing
background schedule to a stable launcher. It uses npm without install scripts
and never requests administrator access. Setup needs npm and network access to
install dependencies. If setup fails, your original installation stays available.

Before a push, the launcher checks npm's `auto` release tag at most once per
24–30 hours. The extra delay spreads checks across machines. Checks run even if
collection is failing or there is no usage. A release is installed in a separate
directory and activated only after package integrity, Node compatibility and
startup checks pass. Registry and installation failures keep the current version
running. An already-running push keeps its original code and lock. Rollback
changes the active executable, never your link token or synchronization state.
Old runtime directories are retained so running processes can finish safely.
Production dependencies are pinned to the versions verified for the release.

Without a scheduled push, automatic checks happen when you next run `kibble push`.
Read-only commands and dry runs do not check for updates. CI and source checkouts
use their own installed version. For an explicitly pinned or company-managed
installation, set `KIBBLE_NO_UPDATE=1` to use that installed version and skip
automatic checks without changing the saved preference. Explicit `update`
commands and `login --auto-update` still perform the action you requested.

Updates run with the invoking user's permissions. Integrity verification detects
corrupt or substituted downloads; it does not protect against a compromised
publisher. Leave updates disabled if your company requires centrally deployed
software. Kibble never accepts an executable or update URL from the ingest server.

Existing versions without the updater need one manual upgrade:

```
npm install -g @usekibble/cli@latest
kibble update enable
```

Alternatively, after upgrading, answer the prompt on your next `kibble login`.

### Approving a release for automatic updates

Publishing a release does not automatically approve it for existing machines.
After the collector checks and platform validation pass, promote its exact
version with `npm dist-tag add @usekibble/cli@<version> auto`. Until that tag exists,
checks report the unavailable release and collection continues. Prereleases and
automatic downgrades are rejected. A newer release must keep the launcher state
format, `dist/index.js`, `dist/cli.js`, and the transcript-free `dist/health.js`
contract compatible. The bundled bootstrap retains recovery commands, while
ordinary runs load the active release's updater before collection.

## Collection and recovery

Every push automatically collects all supported local agents. The local adapter
uses the native parser for eight agents and a shared Codex token decoder for
Codex usage and session ids, plus dedicated Copilot CLI and VS Code metadata
adapters. The broader CLI parser adds only the remaining agents. Copilot's CLI
and editor totals are combined before ingest; overlapping upstream Copilot
totals are excluded. Manual pushes, scheduled pushes and `kibble doctor` use
this same collector, with no parser option to configure.

Dedicated local counters are authoritative for Copilot. Upstream aggregate-only
Copilot OpenTelemetry totals are excluded because they cannot be reliably
deduplicated against those sessions. Work recorded only by that telemetry
source is outside this release's Copilot coverage.

Automatic pushes resume from the last accepted day, bounded to 30 UTC days including today.
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

## CI collection

CI supports ordinary agents that save sessions and ephemeral agents that do not.
Both use the same write-only automation credentials and counts-only receipts.

| Agent workflow | Collection |
| --- | --- |
| Normal Codex or Claude Code with saved native sessions | `kibble ci collect` after the agent stops |
| Ephemeral invocation without saved sessions | `kibble run` around the invocation |
| Retry a previously collected result | `kibble ci upload` with the saved receipts |

### Normal agents with saved sessions

Keep the existing agent invocation, including its normal terminal output. In a
final CI step, scan the **isolated session directory for this job**:

```sh
kibble ci collect --agent codex --sessions-dir "$RUNNER_TEMP/codex/sessions" \
  --receipts-dir "$RUNNER_TEMP/kibble-receipts" --upload

# Or, for Claude Code:
kibble ci collect --agent claude-code --sessions-dir "$RUNNER_TEMP/claude/projects" \
  --receipts-dir "$RUNNER_TEMP/kibble-receipts" --upload
```

Configure and authenticate the agent in that job's fresh home before it runs.
Codex uses `CODEX_HOME`; pass its `sessions` directory to collection. To include
archived sessions too, a job-only Codex home can be the collection root. Claude
Code uses `CLAUDE_CONFIG_DIR`; pass its `projects` directory. Never point this CI
step at a reused runner's entire personal history. Kibble requires an explicit
directory and does not infer a safe job boundary from a date or file mtime.
The [Claude directory reference](https://code.claude.com/docs/en/claude-directory)
documents its session and subagent locations.

A GitHub Actions job with Codex installed and authenticated in its isolated
`CODEX_HOME` can keep these steps:

```yaml
env:
  CODEX_HOME: ${{ runner.temp }}/codex

steps:
  # Install the pinned CLIs and authenticate Codex in CODEX_HOME first.
  - name: Run the coding agent
    run: codex exec "Run the tests and report failures"

  - name: Collect saved sessions, including after agent failure
    if: ${{ always() }}
    env:
      KIBBLE_CI_TOKEN: ${{ secrets.KIBBLE_CI_TOKEN }}
    run: >-
      kibble ci collect --agent codex
      --sessions-dir "$CODEX_HOME/sessions"
      --receipts-dir "$RUNNER_TEMP/kibble-receipts" --upload
```

Without `--upload`, collection needs no Kibble login or credential. It writes one
private JSON receipt per session, named by its opaque stable id. The default
output directory is `.kibble-ci-receipts` inside `--sessions-dir`. Retain the
receipt directory as a CI artifact if delivery fails and retry, for example:

```sh
kibble ci upload "$RUNNER_TEMP/kibble-receipts/"*.json
```

The native session id is reduced to a stable hash-based UUID; filenames, paths
and raw session ids are not sent. Copies of the same session retain their id,
and repeated token snapshots or Claude response blocks count once. Appended
usage replaces the earlier session snapshot using a revision derived from the
observed counters. A new session has a new id and adds usage. Recollecting
unchanged usage keeps its saved price estimate; upload the saved receipt when
retrying delivery. Conflicting snapshots and regressing counters or known cost
are refused. Use one connection and collection mode per session. When a stream
and a file receipt identify the same session, the server rejects the overlap
instead of adding it twice. Older stream receipts without session identity
cannot establish this match; do not import their executions again from files.

Files report observed tokens, recorded model names, supported tool counts and
list-price token estimates when every used bucket has a known price. This is
not an invoice and does not include unrecorded usage or separate tool charges.
Missing prices stay unknown. Completion, process exit and elapsed duration stay
unknown: a closed file does not prove a successful or fully flushed run. Usage
is labelled partial even when the file parses cleanly. Claude subagent files
under the selected root are included; Codex child sessions are separate receipts
when their files are present. No missing child usage is inferred.

Collect after all agents writing to the directory have stopped. Missing or empty
inputs, malformed records, missing identities, oversized lines and symlinks fail
collection before upload. A session with no observed token usage produces an
unavailable receipt and a nonzero collection exit. Keep the agent and collection
as separate CI steps so the collector cannot hide the agent's failure. Collection
supports at most 100 sessions, 10,000 JSONL files, one million records and 8 MiB
per record per invocation. Concurrent writes to one receipt directory are
refused; after a killed collector, remove `.collect.lock` only once it has stopped.

### Ephemeral agent runs

`kibble run` captures a fresh Codex or Claude Code invocation into a local,
counts-only JSON receipt. It works without saved agent sessions, Kibble login
or a scheduler. Add `--upload` to deliver the receipt immediately, or use
`kibble ci upload` in a final CI step. `kibble push` continues to collect laptop
transcripts and does not import run receipts. These commands require the CLI
build containing CI support and a server with the CI migration and routes deployed.

```sh
kibble run --receipt codex-usage.json -- codex exec --model <model> "Run the tests and report failures"
kibble run --receipt claude-usage.json -- claude -p --model haiku "Run the tests and report failures"
```

An organization owner creates a connection under **Settings → CI connections**,
optionally assigns it to a team, and copies its credential into the CI secret
store as `KIBBLE_CI_TOKEN`. Credentials are write-only and never expire. Owners can rotate or revoke them
at any time. Rotation immediately invalidates the previous token. The server stores only their hashes.
They cannot read dashboard data, impersonate an engineer, or allocate a device.
Rotation keeps the connection and its history while invalidating the old secret.
Revocation stops delivery and retains historical usage. Team attribution is
fixed when creating the connection; create a new connection for a different team.

```sh
# With KIBBLE_CI_TOKEN supplied by your secret store:
kibble run --receipt usage.json --upload -- codex exec --model <model> "Run the tests"
# Retry delivery without another agent invocation:
kibble ci upload usage.json
```

`KIBBLE_SERVER` or `--server` selects a self-hosted server origin. The default is
`https://app.usekibble.com`. HTTPS is required except on localhost for development.
The uploader never follows redirects with credentials and retries transient
network/server failures up to four attempts, with a ten-second request timeout.
It validates the entire strict receipt before sending it. Raw agent logs and
JSON with unknown fields are rejected. `kibble run` removes `KIBBLE_CI_TOKEN` from the child agent's environment.

With this CLI build and the agent already installed and authenticated, the core
GitHub Actions steps are:

```yaml
- name: Run the coding agent
  run: kibble run --receipt "$RUNNER_TEMP/kibble-ci.json" -- codex exec "Run the tests and report failures"

- name: Deliver usage, including failed runs
  if: ${{ always() }}
  env:
    KIBBLE_CI_TOKEN: ${{ secrets.KIBBLE_CI_TOKEN }}
  run: kibble ci upload "$RUNNER_TEMP/kibble-ci.json"
```

Pin the Kibble and agent versions in the job's installation steps. Use one
receipt path per invocation. For parallel jobs, their runner-local temporary
directories and random run ids separate their usage. Retain the counts-only
receipt as a CI artifact in another `always()` step when delivery fails, then
retry `kibble ci upload` with that file. The wrapper preserves nonzero agent
exits, so collecting usage does not turn a failed job into a successful one.
A missing receipt is an upload failure, never a successful zero-usage report.

Each receipt has an increasing `revision`. Uploading the same revision again
returns a duplicate acknowledgement. A late checkpoint cannot overwrite a newer
receipt, and a finalized execution cannot be amended by a new revision. Conflicting
content at the same revision fails. Actual reruns create a fresh run id and add
their usage. Receipt timestamps and agent identity cannot change across revisions.

Owners see all CI runs; managers see connections assigned to their managed teams.
A team dashboard links to its CI report and preserves the selected time and agent.
Personal scopes contain no automation usage. The Overview summary and **CI usage**
report show reported estimates, missing prices and incomplete runs. These figures
are separate from the existing reconciled vendor/laptop total because receipts
lack a reliable vendor billing identity for deduplication. The report includes
the latest 100 runs in the selected window; its summary counts every matching run.
Runs use their UTC start date, including jobs that cross midnight. Reads, uploads
and the daily retention purge use the organization's history window.

In a source checkout, replace `kibble` with `pnpm --filter @usekibble/cli dev`.
Put Kibble options before `--`, followed by the agent executable and its arguments.
Use the agent's own installed credentials and permissions. Kibble adds
`--ephemeral --json` for Codex and
`-p --no-session-persistence --output-format stream-json --verbose` for Claude.
It does not relax the agent's sandbox or tool permissions. Text input on stdin
is inherited. Use native agent executables on Windows; shell scripts and `.cmd`
shims are not supported by the wrapper. Resumed conversations, `codex exec review`
and Claude streaming input are refused because their accounting boundaries differ.

The receipt contains a random execution id and revision, agent, UTC start/end times, elapsed
time, process exit/signal, structured result status, token buckets, observed tool
call/error counts, and fixed collection issue codes. Claude adds per-model usage
and an agent-reported cost estimate, rounded once into integer microdollars.
Model attribution comes only from usage records, never from scanning command
arguments which can also contain prompts. No prompt, answer, command, tool argument/output,
path, session transcript, account identifier or environment value is retained.
Model names are filtered to bounded identifiers. Agent stdout and stderr are
consumed and discarded, so neither becomes a CI log or artifact through Kibble.
Agent features that write their own files or telemetry remain controlled by the
agent's configuration. If a workflow needs the final answer, configure an output
file through the agent itself and treat that file as content, separate from the
Kibble receipt.

| Field | Meaning |
| --- | --- |
| `usageStatus: complete` | A valid final usage snapshot was observed for the receipt's `accountingScope`, with no collection issue. This does not mean every kind of usage is available. |
| `usageStatus: partial` | Some usage was observed, but interruption, malformed output or limited accounting prevents a complete receipt. |
| `usageStatus: unavailable` | No usable usage snapshot was observed. Token totals are `null`, never invented zeros. |
| `costMicros: null` | Cost is unavailable. A successful Codex run currently has this value. |
| `costBasis: agent_estimate` | Claude's reported estimate, not an invoice or subscription charge. |
| `outcome` | `running`, `succeeded`, `failed`, `interrupted` or `launch_failed`, separately from usage completeness. |

Codex completion usage covers the main thread. It has no verified model breakdown
or price, and child-agent spend is not established by this stream. Claude uses
the final `modelUsage` object, whose documented scope includes subagents; it never
sums preliminary assistant usage with final totals. Older results with only
top-level `usage` are marked partial. Repeated cumulative results replace earlier
snapshots instead of adding to them. Reasoning is a subset of Codex output;
Claude reasoning counts remain unknown. Tool counters describe supported events
observed in the stream, not a complete inventory of skills, MCP servers or
subagent activity. Receipts are run totals, not per-day attribution for jobs
crossing midnight.

The destination must be a new file in an existing writable directory. Kibble
reserves it before launching the agent and writes private, atomic checkpoints
at most twice a second when events arrive. A new execution gets a new `runId`;
keep that receipt unchanged when retrying artifact delivery. Choose a separate
file for every invocation and parallel job. Reusing a filename fails before the
agent runs, so it cannot erase an earlier receipt.

On macOS/Linux, SIGINT and SIGTERM are forwarded to the child process group,
followed by SIGKILL after ten seconds if it has not exited. Windows uses Node's
child termination behavior, without a process-tree cleanup guarantee. A hard
kill or destroyed runner can leave only the latest checkpoint, with
`outcome: running`, and can lose usage not yet emitted by the agent. Retain the
receipt in an `always()` artifact step while the runner still exists. Do not
upload the agent's raw JSON stream.

Nonzero child exit codes are preserved. Signal termination returns `128 + signal`.
If the child exits zero but reports an agent failure, or collection is incomplete,
Kibble exits 1. This catches Claude's observed error result with an OS exit of zero.
Receipt write failures also fail collection. A Codex run can succeed with complete
main-thread tokens and an unavailable cost; workflows requiring a price must
check `costMicros` explicitly.

The synthetic collection suite covers repeated totals, cache normalization,
missing/invalid usage, content exclusion, process failures, private receipt files
and POSIX interruption. The server ingest check also exercises capture, HTTP upload,
concurrent retries, credential rotation/revocation, scope and retention through
production functions against a throwaway local organization. Live agent validation
uses Codex 0.153.4 and Claude Code 2.1.261
on macOS. Actual Windows/Linux runners, resumed sessions and vendor invoice
reconciliation are outside that live validation.

Format references: [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Claude cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

## Cross-platform CI

The public repository runs `CLI checks` on pull requests and pushes to main,
using standard Windows, Linux and macOS runners with Node 20, 22 and 24. It
builds the standalone package, typechecks it, runs the synthetic regression
suite, and tests native parsers, managed installation and each real OS scheduler.
CI has read-only repository permissions and does not publish to npm.

After `npm run build`, `npm run verify:fixtures` runs the shared synthetic
suite without personal transcripts. `npm run verify:platform` is restricted to
disposable GitHub runners because it creates and removes real OS jobs. The local
`verify` command still runs those same synthetic fixtures before comparing the
collector against your raw Claude transcripts. An empty transcript window fails;
CI passing does not substitute for that accuracy check after parser changes.

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

`kibble usage` defaults to your own usage. For team or organization reporting,
explicitly authorize this device again, then choose the scope:

```bash
kibble login --reporting
kibble usage --list-scopes                  # allowed scopes and team names/IDs
kibble usage --scope self --range week      # your own usage, for every role
kibble usage --scope team --team Engineering --range week
kibble usage --scope team --range week      # all allowed teams combined
kibble usage --scope org --range week       # owners only
```

Owners can read the organization or any of its teams. Managers can read only
the teams assigned to them, or their own usage. Members can read only their own
usage. `--team` accepts an exact name or an ID from `--list-scopes`; IDs are
useful for scripts. Team scope without `--team` includes all allowed teams,
excluding unassigned members. Organization scope includes unassigned members.
Every report identifies its scope. `--json` also works with `--list-scopes`.

The reporting grant is checked on the server, along with the current role and
team assignments on every request. Existing collector tokens stay personal-only.
An ordinary `kibble login` rotates the token and removes reporting access;
`kibble logout` or unlinking the device revokes all its access. Selecting a scope
does not change what the collector uploads. Team and organization reports contain
aggregates, not a member or device roster. Deploy the server migration and routes
before releasing this CLI; an older server cannot fulfill scoped reports.

`kibble skill install` writes a `kibble-usage` skill into `~/.claude/skills`
(plus Codex and Copilot when installed). Ask your coding agent about
"my AI usage this month" or "Engineering's usage this week". It discovers
allowed scopes and runs `kibble usage --json`; credentials stay in the CLI
config. The skill does not authorize reporting access itself. Run
`kibble skill install` again after upgrading to refresh existing instructions.

## What leaves this machine

Counts only: token totals, model names, opaque session ids, repository names,
and, while your organization has capability reporting switched on, the names of
the skills, slash commands and MCP servers installed here with recorded invocation counts where available. Codex counts explicit skill selections and recognized command submissions;
automatic skill use and commands omitted from history are outside coverage. Per agent, how this machine is billed: a subscription and its tier
(Max 5x, ChatGPT Pro), an API key, or a cloud provider's account. Never
prompts, file contents, tool arguments.

The billing mode is read from the login state each agent already keeps
(`~/.claude.json`, `~/.codex/auth.json`, and Copilot's config). Those files can
also hold account, organization and machine ids, your email and live tokens;
`src/sources/plans.ts` copies out the mode and tier and nothing else leaves.

Finding Claude Code skills means looking in three places: your `~/.claude`, the
`.claude` of each checkout you have worked in, and each installed plugin. The
checkouts come from the working directory your agent records in its own logs,
walked upwards until a `.claude` turns up. That directory is a path, so it is
read and discarded here and never sent, the same way repository names are
reduced before they leave. Which of the three a skill came from, and what
version it is, are worked out on this machine and are not sent either.

Copilot CLI uses its documented `~/.copilot/session-state/<id>/events.jsonl`
records. Kibble reads durable session and shutdown counters, repository
context, tool and hook event types, skill invocation names, and MCP server
names. It never reads the prompt, reply, tool arguments, tool output, or the
changed-file paths stored beside those counters. Copilot skills are inventoried
from its personal, project, shared-agent and installed-plugin roots.

The default collector needs no Copilot telemetry setup. It respects
`COPILOT_HOME` (use the same value for Kibble and Copilot). Shutdown metrics are
cumulative: a resumed session contributes only the increase, recorded on the
UTC day of its shutdown checkpoint. An open or crashed session without a
shutdown checkpoint has no complete token total to report. These are model
list-price estimates, not GitHub invoices or AI-credit charges. Cached input
and reasoning tokens are not charged twice.

Activity and capability counts appear where durable events provide them.
Tokens spanning multiple repository contexts between checkpoints stay
unattributed. Copilot CLI does not persist downstream skill-token attribution or
ordinary slash-command invocations, so those counts are unavailable. A saved
GitHub login establishes subscription mode, not a tier or seat price; explicit
BYOK settings establish API/cloud mode. VS Code completions and GitHub's
cloud coding agent are not covered by this local CLI parser.

### Copilot Chat in VS Code

The default collector also reads VS Code and VS Code Insiders chat storage,
including legacy JSON snapshots and the current JSONL mutation log. No
extension, telemetry setting, or Kibble login is needed for a dry run:

```
kibble doctor
kibble push --dry-run
```

It finds the standard user-data locations on macOS, Windows and Linux, plus
portable installations through `VSCODE_PORTABLE`. If you launch VS Code with
`--user-data-dir`, set `KIBBLE_VSCODE_USER_DATA_DIR` to that same directory for
Kibble. Workspace, empty-window and transferred-session stores are supported;
migrated copies and repeated snapshots are deduplicated before aggregation.

Saved model names (including the model behind Auto), token counters, request
dates, durations, tool names, explicit MCP server labels and slash-command
names feed the existing `copilot` rows. A single-folder workspace or recorded
working-directory URI supplies repo attribution; ambiguous multi-root windows
stay unattributed. Prompts, responses, tool input/output and document contents
are discarded before replaying the metadata log. CLI and editor totals sharing
a day/model are added into one ingest row, not allowed to overwrite each other.

Coverage follows what VS Code saves. Whole-turn `modelTotals` are used when
available. Otherwise the saved counters describe only the last successful
model call in a request; multi-round or unknown-round cases produce a warning
and must not be read as complete agent-loop totals. Cache splits absent from
those older records are unknown, so estimated cost treats recorded input at
the input rate. Prices are model-list estimates, not Copilot AI credits or
invoices. Unrecorded inline completions, remote-only sessions, skill-token
attribution, and subscription-tier detection are not supplied by this adapter.

VS Code does not yet provide the same activity coverage as Claude Code:

| Metric | Saved VS Code chat coverage |
| --- | --- |
| Tool calls | Structured call IDs and names, deduplicated across rounds and cards |
| Tool pass/fail | Explicit saved errors and terminal exit codes only; a completed card is not proof of success |
| Interruptions | Explicit cancellation flags and tool denials count; a saved Cancelled state alone can represent unfinished work and remains unknown |
| Tool duration | Saved terminal/subagent timers, plus uniquely joined start/end intervals from existing extension transcripts; these can include approval waiting and remain incomplete |
| Manual skill/command triggers | Explicit selections and names resolved against local inventory |
| Automatic skill triggers | Unavailable: ordinary result serialization drops skill metadata |
| Hook failures and compactions | Observed hook/compaction markers, not complete execution totals; a hook policy block does not prove an execution failure |
| Edits and added/removed lines | Unavailable without reading content, which this collector does not do |
| Skill-attributed tokens and cost | Unavailable |

Repository and capability rows carry closed-enum `unavailableMetrics` flags.
Their observed numeric values are not complete totals when flagged. The server
preserves that distinction through aggregate cards, reports and skill rankings;
missing measurements must not become zero failures or "never used" skills.
Daily usage totals still represent the available token estimate, not a claim of
complete loop coverage. Deploy the matching server schema before releasing a
collector that sends these flags.

VS Code capability discovery respects supported local skill/prompt locations,
configured plugin roots, workspace settings and disabled entries in profile
storage. Plugin workspace enablement overrides profile enablement. It reads fixed keys
from a bounded, in-memory SQLite copy without changing the editor database.
Prompt locations ending in a sole `/*` use immediate-child folder discovery;
other search globs remain unsupported. Extension-provided artifacts, remote
workspaces, marketplace discovery, multi-root
settings and historical profile selection are not exhaustively covered. No
telemetry settings are changed to fill these gaps.

For development, `pnpm verify` also exercises Copilot schema fixtures for
resume, VS Code mutation replay, deduplication, privacy and repository
attribution before the existing Claude Code raw-transcript comparison. The
same fixtures run in public CI through `npm run verify:fixtures` after building.
They establish supported parser behavior, not live accuracy for every Copilot
installation or a complete count of unrecorded work.

The server's ingest schema is strict, so a field it does not expect is a
rejected request. Every line this package sends is in `src/`, and it is short
enough to read.

## Links

- How to use Kibble, from install to reading the dashboard: https://usekibble.com/docs
- Dashboard and pricing: https://usekibble.com
- Source: https://github.com/usekibble/cli
- hello@usekibble.com

MIT.
