#!/usr/bin/env node
// LOCAL-ONLY parity gate — skipped in CI (no GPU, no Electron binary).
//
// Proves that setting TexturePool.textureOptions.format = "rgba16float" at
// export-worker init preserves filter precision on the 10-bit path and guards
// against a Pixi upgrade silently breaking the invariant.
//
// Run from any directory:
//   node apps/desktop/e2e/effects-f16-parity/run.mjs
//
// Or from apps/desktop/e2e (where the script is declared):
//   npm run gate:effects-f16-parity
//
// No environment variables are needed — it resolves the repo's own Electron.
// Override that only for a checkout that keeps Electron elsewhere:
//   ELECTRON_BIN=/path/to/electron node run.mjs
//
// What it checks:
//   default-pool: BlurFilter and the chromakey pass-through through an
//                 8-bit / f16 pool intermediate
//                 → gradient collapses to ~256 distinct values (banding)
//   f16-pool:     BlurFilter and the chromakey pass-through through an
//                 rgba16float pool intermediate
//                 → gradient preserves ~1024 distinct values (full precision)

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..", "..", "..");

// The repo's own Electron, resolved platform-appropriately; override with
// ELECTRON_BIN when running from a checkout that keeps Electron elsewhere.
//
// `electron/path.txt` is the package's own record of the executable's name
// inside `dist/`, so reading it is what makes this correct on macOS — there the
// binary is `Electron.app/Contents/MacOS/Electron`, not a bare `electron`.
// Deliberately NOT `import("electron")`, whose module-evaluation side effect is
// to *download* a missing binary: this gate's missing-binary contract is a
// clean BLOCKED exit, not a network fetch.
function repoElectron() {
  const dir = path.join(REPO, "node_modules", "electron");
  const nameFile = path.join(dir, "path.txt");
  const name = existsSync(nameFile)
    ? readFileSync(nameFile, "utf8").trim()
    : process.platform === "win32" ? "electron.exe" : "electron";
  return path.join(dir, "dist", name);
}

const ELECTRON_BIN = process.env.ELECTRON_BIN ?? repoElectron();

if (!existsSync(ELECTRON_BIN)) {
  console.error(
    `[f16-parity] BLOCKED: Electron binary not found at ${ELECTRON_BIN}\n` +
    `  Run \`npm install\` at the repo root, or set ELECTRON_BIN env var to the correct path and retry.`,
  );
  process.exit(2);
}

const MAIN = path.join(__dirname, "main.cjs");

function runCondition(f16) {
  const label = f16 ? "f16-pool" : "default-pool";
  console.log(`[f16-parity] running condition: ${label} ...`);
  let stdout;
  try {
    stdout = execFileSync(ELECTRON_BIN, [MAIN], {
      env: { ...process.env, POOL_F16: f16 ? "1" : "0" },
      timeout: 35_000,
      encoding: "utf8",
    });
  } catch (err) {
    const output = err.stdout ?? "";
    console.error(`[f16-parity] Electron exited with error for ${label}:\n${output}`);
    throw new Error(`Electron run failed for ${label}: ${err.message}`);
  }

  // Find the GATE_RESULT / GATE_ERROR line.
  const resultLine = stdout.split("\n").find((l) => l.startsWith("GATE_RESULT ") || l.startsWith("GATE_ERROR "));
  if (!resultLine) {
    console.error(`[f16-parity] No GATE_RESULT line in output:\n${stdout}`);
    throw new Error(`No GATE_RESULT line for ${label}`);
  }
  if (resultLine.startsWith("GATE_ERROR ")) {
    const data = JSON.parse(resultLine.slice("GATE_ERROR ".length));
    throw new Error(`Gate reported error for ${label}: ${JSON.stringify(data)}`);
  }
  const data = JSON.parse(resultLine.slice("GATE_RESULT ".length));
  console.log(`[f16-parity] ${label} result:`, JSON.stringify(data, null, 2));
  return data;
}

let failed = false;

// --- Condition A: default pool ---
const defaultResult = runCondition(false);
// --- Condition B: f16 pool ---
const f16Result = runCondition(true);

const DEFAULT_THRESHOLD = 260;
const F16_THRESHOLD = 900;

for (const filterPhase of ["blur", "chroma"]) {
  const distinctDefault = defaultResult.phases?.[filterPhase]?.distinct ?? -1;
  if (distinctDefault <= DEFAULT_THRESHOLD && distinctDefault > 0) {
    console.log(`[f16-parity] PASS default-pool ${filterPhase}: distinct=${distinctDefault} <= ${DEFAULT_THRESHOLD} (bands as expected)`);
  } else {
    console.error(`[f16-parity] FAIL default-pool ${filterPhase}: distinct=${distinctDefault} — expected banding in (0, ${DEFAULT_THRESHOLD}]`);
    failed = true;
  }

  const distinctF16 = f16Result.phases?.[filterPhase]?.distinct ?? -1;
  if (distinctF16 > F16_THRESHOLD) {
    console.log(`[f16-parity] PASS f16-pool ${filterPhase}: distinct=${distinctF16} > ${F16_THRESHOLD} (precision preserved)`);
  } else {
    console.error(`[f16-parity] FAIL f16-pool ${filterPhase}: distinct=${distinctF16} <= ${F16_THRESHOLD} — pool bump not preserving precision`);
    failed = true;
  }
}

if (failed) {
  console.error("\n[f16-parity] GATE FAILED");
  process.exit(1);
} else {
  console.log("\n[f16-parity] GATE PASSED");
  process.exit(0);
}
