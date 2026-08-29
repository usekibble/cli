#!/usr/bin/env node
import { Command } from "commander";
import { login, logout } from "./commands/login.js";
import { push } from "./commands/push.js";
import { scheduleInstall, scheduleStatus, scheduleUninstall } from "./commands/schedule.js";
import { loadConfig, configPath } from "./config.js";
import { devicePath } from "./device.js";
import { createSource, parseSourceName } from "./sources/index.js";

const program = new Command();

program
  .name("kibble")
  .description(
    "Kibble collector -- reports AI coding agent token usage to your team's dashboard.\n" +
      "Counts only: never prompts, file contents, or tool arguments.",
  )
  .version("0.2.1");

program
  .command("login")
  .option("--server <url>", "Kibble server base URL")
  .option("--no-browser", "print the URL instead of opening a browser")
  .option("--device <label>", 'a name for this machine, e.g. "work laptop" (optional)')
  .description("authorize this machine against your Kibble account")
  .action(login);

program
  .command("logout")
  .description("forget the link token stored on this machine and revoke it on the server")
  .action(logout);

program
  .command("push")
  .option("--since <date>", "inclusive UTC start date, YYYY-MM-DD")
  .option("--until <date>", "inclusive UTC end date, YYYY-MM-DD")
  .option("--dry-run", "print what would be sent, send nothing")
  .option("--server <url>", "Kibble server base URL")
  .option("--source <name>", 'parser: "core" (default, in-process, session ids) or "cli" (more clients)')
  .option("--quiet", "print one line per run (used by the hourly schedule)")
  .description("send daily usage aggregates")
  .action(push);

const schedule = program
  .command("schedule")
  .description(
    "run `kibble push` in the background, every hour and at startup, via the OS scheduler\n" +
      "(installed automatically by `kibble login` when your organization requires it)",
  );
schedule
  .command("install")
  .description("register the background push (launchd on macOS, cron on Linux, Task Scheduler on Windows)")
  .action(scheduleInstall);
schedule
  .command("uninstall")
  .option("--force", "remove it even though the organization requires automatic collection")
  .description("remove the background push")
  .action(scheduleUninstall);
schedule
  .command("status")
  .description("show whether the background push is registered, the org policy, and the last log line")
  .action(scheduleStatus);

program
  .command("whoami")
  .description("show the linked identity and config location")
  .action(() => {
    const config = loadConfig();
    console.log(`config   ${configPath()}`);
    console.log(`server   ${config.server}`);
    console.log(`email    ${config.email ?? "(not linked)"}`);
    console.log(`org      ${config.organizationName ?? "(not linked)"}`);
    console.log(`team     ${config.teamName ?? "(unassigned)"}`);
    console.log(`device   ${config.deviceName ?? "(not linked)"}  (install id in ${devicePath()})`);
    console.log(`linked   ${config.linkToken ? "yes" : "no -- run 'kibble login'"}`);
    console.log(
      `collect  ${config.autoCollect === undefined ? "(unknown until login)" : config.autoCollect ? "automatic, required by the organization" : "manual or scheduled, your choice"}`,
    );
    console.log(
      `skills   ${config.capabilities === false ? "not reported (organization policy)" : "skill, command and MCP names reported (organization policy)"}`,
    );
  });

program
  .command("doctor")
  .option("--source <name>", 'parser to check: "core" or "cli"')
  .description("check that the underlying parser is present and working")
  .action(async (opts: { source?: string }) => {
    const source = createSource(parseSourceName(opts.source));
    try {
      console.log(`parser   ${source.name}`);
      console.log(`version  ${await source.version()}`);
      console.log(`covers   ${source.coverage}`);
      const result = await source.collect({
        since: new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10),
        until: new Date().toISOString().slice(0, 10),
      });
      const agents = [...new Set(result.daily.map((r) => r.agent))].sort();
      console.log(`rows     ${result.daily.length} in the last 7 days`);
      console.log(`sessions ${result.sessions.length || "none reported by this parser"}`);
      console.log(`agents   ${agents.join(", ") || "(none found)"}`);
      console.log("\nOK");
    } catch (err) {
      console.error(`FAILED   ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err: Error) => {
  // Under the hourly schedule every log line carries a timestamp.
  const stamp = process.argv.includes("--quiet") ? `${new Date().toISOString()}  ` : "";
  console.error(`${stamp}${err.message}`);
  process.exit(1);
});
