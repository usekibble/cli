#!/usr/bin/env node
import { launch } from "./updates.js";

await launch().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
