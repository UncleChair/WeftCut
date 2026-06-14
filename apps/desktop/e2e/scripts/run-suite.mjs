import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run wdio for one suite by spawning node -> wdio.js directly with the --suite
// flag in argv. This sidesteps the Windows npm/PowerShell `--` swallowing trap
// (passing `--suite` through `npm run ... -- --suite x` silently drops it).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.resolve(HERE, ".."); // apps/desktop/e2e
const WDIO_BIN = path.resolve(E2E_ROOT, "node_modules", "@wdio", "cli", "bin", "wdio.js");
const CONF = path.resolve(E2E_ROOT, "wdio.conf.mjs");

const VALID = new Set(["all", "smoke", "ui", "export", "audio", "motif"]);
const suite = process.argv[2];
if (!suite || !VALID.has(suite)) {
  console.error(`[run-suite] usage: node scripts/run-suite.mjs <${[...VALID].join("|")}>`);
  process.exit(2);
}

const args = ["run", CONF];
if (suite !== "all") args.push("--suite", suite);

const child = spawn(process.execPath, [WDIO_BIN, ...args], {
  stdio: "inherit",
  cwd: E2E_ROOT,
});
child.on("exit", (code) => process.exit(code ?? 1));
