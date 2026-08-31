# @usekibble/cli

The Kibble collector. It reads the usage logs that coding agents (Claude Code,
Codex) already write on this machine and pushes a per-day summary to your
Kibble dashboard, so a team lead can see what every coding agent spent this
week, per engineer, team, model and repo.

```
npm install -g @usekibble/cli
kibble login        # OAuth device grant, links this machine
kibble push         # send today's counts now
kibble schedule status
```

`kibble login` installs a background push (hourly and at startup) via launchd,
cron or Task Scheduler when your organization asks for it.

## What leaves this machine

Counts only: token totals, model names, opaque session ids, repository names,
and, while your organization has capability reporting switched on, the names of
the skills, slash commands and MCP servers installed here with how often each
one fired. Per agent, how this machine is billed: a subscription and its tier
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
