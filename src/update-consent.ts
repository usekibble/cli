import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { readUpdateState } from "./update-state.js";
import { disableUpdates, enableUpdates } from "./updates.js";
import { updateText as t } from "./update-messages.js";

/** EOF and Ctrl-C are not a yes. Only a submitted empty line selects [Y/n]. */
export async function askForUpdates(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<boolean | undefined> {
  output.write(`${t("explanation")}\n`);
  // readline emits a final unterminated line at EOF. That is not submission.
  let ended = false;
  const onEnd = () => { ended = true; };
  input.on("end", onEnd);
  const reader = createInterface({ input, output });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: boolean | undefined) => {
      if (settled) return;
      settled = true;
      input.off("end", onEnd);
      reader.close();
      resolve(answer);
    };
    reader.on("SIGINT", () => finish(undefined));
    reader.on("close", () => finish(undefined));
    reader.on("line", (line) => {
      if (ended) { finish(undefined); return; }
      const answer = line.trim().toLowerCase();
      if (answer === "" || answer === "y" || answer === "yes") finish(true);
      else if (answer === "n" || answer === "no") finish(false);
      else output.write(`${t("invalidAnswer")}\n${t("prompt")}`);
    });
    output.write(t("prompt"));
  });
}

export async function offerAutomaticUpdates(
  explicit?: boolean,
  interaction = {
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI &&
      process.env.KIBBLE_NO_UPDATE !== "1" && !/\.tsx?$/.test(process.argv[1] ?? "")),
    ask: askForUpdates,
    enable: enableUpdates,
  },
): Promise<void> {
  try {
    if (explicit === true) { await interaction.enable(); return; }
    if (readUpdateState().enabled !== undefined || !interaction.terminal) return;
    const answer = await interaction.ask();
    if (answer === true) await interaction.enable();
    else if (answer === false) disableUpdates();
    else console.log(t("interrupted"));
  } catch {
    // Update setup cannot turn a successful device link into a failed login.
    console.log(t("failed"));
  }
}
