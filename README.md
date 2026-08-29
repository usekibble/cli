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

Counts only: token totals, model names, opaque session ids, repository names.
Never prompts, file contents, tool arguments, paths, hostnames or hardware ids.
The server's ingest schema is strict, so a field it does not expect is a
rejected request. Every line this package sends is in `src/`, and it is short
enough to read.

## Links

- Dashboard and pricing: https://usekibble.com
- Source: https://github.com/henchiyb/kibble
- hello@usekibble.com

MIT.
