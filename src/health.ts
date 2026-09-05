import { createSource } from "./sources/index.js";

// Verify the complete command module and both native parsers without reading
// transcripts, using the network, or touching login and collection state.
process.argv = [process.execPath, process.argv[1]!, "--version"];
await createSource().version();
await import("./cli.js");
