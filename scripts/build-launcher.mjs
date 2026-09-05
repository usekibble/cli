import { build } from "esbuild";

// A single file survives a failed collector installation. Built-in modules stay
// external; semver and the lock/config helpers travel with the launcher.
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: { js: 'import { createRequire as launcherRequire } from "node:module"; const require = launcherRequire(import.meta.url);' },
});
