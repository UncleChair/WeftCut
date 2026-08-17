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
// What it checks — every catalog filter gets a phase, each driven by a
// non-neutral parameter (the colour trio at amount -40, a gain below 1 so
// nothing clips; sharpen at amount 60):
//   default-pool: each filter through an 8-bit pool intermediate
//                 → gradient collapses to ~256 distinct values (banding)
//   f16-pool:     each filter through an rgba16float pool intermediate
//                 → gradient preserves ~1024 distinct values (full precision)
// Plus two sharpen-specific probes, because its kernel is exactly identity on
// the gradient and so bands the same whether it ran or not: an exact
// pass-through at amount 0, and the predicted ring around a hard step.
//
// And a third condition, `wgsl-webgpu`, which runs the WGSL half of the
// dual-source sharpen on a real WebGPU device — the backend the PREVIEW uses,
// and one nothing else in the repo executes.

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

import { electronBinPath } from "../lib/electron-bin.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The repo's own Electron; override with ELECTRON_BIN when running from a
// checkout that keeps Electron elsewhere.
const ELECTRON_BIN = process.env.ELECTRON_BIN ?? electronBinPath();

if (!existsSync(ELECTRON_BIN)) {
  console.error(
    `[f16-parity] BLOCKED: Electron binary not found at ${ELECTRON_BIN}\n` +
    `  Run \`npm install\` at the repo root, or set ELECTRON_BIN env var to the correct path and retry.`,
  );
  process.exit(2);
}

const MAIN = path.join(__dirname, "main.cjs");
const WGSL_MAIN = path.join(__dirname, "wgsl.cjs");

/// Run one Electron host and parse its single `<PREFIX>_RESULT <json>` line.
function runHost(label, main, env, prefix, timeout) {
  console.log(`[f16-parity] running condition: ${label} ...`);
  let stdout;
  try {
    stdout = execFileSync(ELECTRON_BIN, [main], {
      env: { ...process.env, ...env },
      timeout,
      encoding: "utf8",
    });
  } catch (err) {
    const output = err.stdout ?? "";
    console.error(`[f16-parity] Electron exited with error for ${label}:\n${output}`);
    throw new Error(`Electron run failed for ${label}: ${err.message}`);
  }

  const resultLine = stdout
    .split("\n")
    .find((l) => l.startsWith(`${prefix}_RESULT `) || l.startsWith(`${prefix}_ERROR `));
  if (!resultLine) {
    console.error(`[f16-parity] No ${prefix}_RESULT line in output:\n${stdout}`);
    throw new Error(`No ${prefix}_RESULT line for ${label}`);
  }
  if (resultLine.startsWith(`${prefix}_ERROR `)) {
    const data = JSON.parse(resultLine.slice(`${prefix}_ERROR `.length));
    throw new Error(`Gate reported error for ${label}: ${JSON.stringify(data)}`);
  }
  const data = JSON.parse(resultLine.slice(`${prefix}_RESULT `.length));
  console.log(`[f16-parity] ${label} result:`, JSON.stringify(data, null, 2));
  return data;
}

const runCondition = (f16) =>
  runHost(f16 ? "f16-pool" : "default-pool", MAIN, { POOL_F16: f16 ? "1" : "0" }, "GATE", 35_000);

let failed = false;

// --- Condition A: default pool ---
const defaultResult = runCondition(false);
// --- Condition B: f16 pool ---
const f16Result = runCondition(true);

const DEFAULT_THRESHOLD = 260;
const F16_THRESHOLD = 900;

// One phase per catalog filter — a filter is not labelled `f16-verified` in
// effectRegistry.ts before its phase has passed here. `sharpen` is asserted
// below instead of here: a high-pass does not band a ramp, it amplifies the
// staircase the 8-bit pool made of it, so this loop's default-pool bound is the
// wrong measure for it (see there).
for (const filterPhase of ["blur", "chroma", "brightness", "contrast", "saturation"]) {
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

// --- Sharpen: its own four assertions ---
//
// Two reasons it is not in the loop above. First, the default-pool bound does
// not describe a high-pass: the 8-bit intermediate hands the filter a 256-step
// staircase, and sharpening amplifies every step, so each plateau leaves three
// distinct values (its level plus a ring pixel either side) — a ~768 ceiling,
// not 256. Second, `distinct` cannot see whether the kernel ran at all: a 3x3
// cross unsharp is exactly identity on a linear ramp (the second derivative of a
// ramp is zero), and `atQuarter` reads the source's own 0.25 for the same
// reason. So the pool parity is measured as how far the kernel moved the ramp
// away from its own pass-through, and two behaviour probes prove it ran.
function check(label, ok, detail) {
  if (ok) {
    console.log(`[f16-parity] PASS ${label}: ${detail}`);
  } else {
    console.error(`[f16-parity] FAIL ${label}: ${detail}`);
    failed = true;
  }
}

const near = (got, want, tol) => typeof got === "number" && Math.abs(got - want) <= tol;

// 256 plateaus x (level + two ring pixels) = 768; an f16 pool would give 1024,
// so this still separates the two conditions.
const SHARPEN_DEFAULT_THRESHOLD = 800;

for (const [label, result] of [["default-pool", defaultResult], ["f16-pool", f16Result]]) {
  const f16 = label === "f16-pool";
  const ramp = result.phases?.sharpen;

  const distinct = ramp?.distinct ?? -1;
  check(
    `${label} sharpen ramp distinct`,
    f16 ? distinct > F16_THRESHOLD
      : distinct > 0 && distinct <= SHARPEN_DEFAULT_THRESHOLD,
    `distinct=${distinct} ${f16 ? `> ${F16_THRESHOLD} (precision preserved)` : `<= ${SHARPEN_DEFAULT_THRESHOLD} (256 plateaus, ringed)`}`,
  );

  // The parity statement for a high-pass. Against its own amount-0 row, so this
  // is the KERNEL's excursion and not the pool's quantisation:
  //   8-bit pool → the staircase it introduced, amplified by amount (0.6/255)
  //   f16 pool   → a smooth ramp, on which this kernel is identity
  const moved = ramp?.rampMaxDiff;
  check(
    `${label} sharpen ramp excursion vs its own pass-through`,
    f16
      ? typeof moved === "number" && moved <= 0.0005
      : typeof moved === "number" && moved >= 0.0015 && moved <= 0.0035,
    `rampMaxDiff=${moved} ${f16 ? "<= 0.0005 (identity on a smooth ramp)" : "in [0.0015, 0.0035] (0.6/255 = 0.00235, the 8-bit staircase amplified)"}`
      + ` — clamp-fold at the two edge pixels: ${JSON.stringify(ramp?.edgeDiffs)}`,
  );

  // amount 0 is an exact pass-through of the filter's input. In the f16
  // condition the pool is lossless, so the ONLY honest bound is zero; in the
  // default-pool condition the 8-bit intermediate is the entire difference.
  const zero = result.phases?.sharpenZero;
  const bound = label === "f16-pool" ? 0 : 1 / 255;
  check(
    `${label} sharpen amount 0 is a pass-through`,
    typeof zero?.maxDiffVsSource === "number" && zero.maxDiffVsSource <= bound,
    `maxDiffVsSource=${zero?.maxDiffVsSource} <= ${bound}`,
  );

  // The step probe: undershoot / overshoot of 0.6 * 0.2 either side of a
  // 0.4 → 0.6 edge, and the pixels three away untouched. Fails loudly if the
  // kernel silently did nothing, has the wrong sign, or reads its texel size
  // from anywhere but uInputSize.
  const ring = result.phases?.sharpenRing;
  const w = ring?.window;
  const TOL = 0.005;
  const shape = Array.isArray(w) && w.length === 6
    && near(w[0], 0.4, TOL) && near(w[1], 0.4, TOL)
    && near(w[2], 0.28, TOL) && near(w[3], 0.72, TOL)
    && near(w[4], 0.6, TOL) && near(w[5], 0.6, TOL);
  check(
    `${label} sharpen rings a step by the predicted ±0.12`,
    shape,
    `window(x=${JSON.stringify(ring?.xs)})=${JSON.stringify(w)} — expected [0.4, 0.4, 0.28, 0.72, 0.6, 0.6] ±${TOL}`,
  );
}

// --- Condition C: the WGSL twin on a real WebGPU device ---
//
// Conditions A and B force WebGL, which is the export backend and the only one
// whose readback can see float16 — so on its own this gate never executes the
// WGSL half of a dual-source filter, which is the half the PREVIEW runs. This
// condition renders the shipped WGSL text through a WebGPU renderer and checks
// the same hand-derived step ring, at 8 bits: 0.28 x 255 = 71, 0.72 x 255 = 184.
// Its own Electron host, because WebGPU needs --enable-features=Vulkan on Linux
// and that switch also moves ANGLE's WebGL backend underneath A and B.
const wgsl = runHost("wgsl-webgpu", WGSL_MAIN, {}, "WGSL", 40_000);
if (wgsl.unavailable) {
  // A box with no WebGPU adapter cannot run it. Loud, not silent: the WGSL half
  // is then UNVERIFIED on this machine, which is a real gap in the evidence and
  // not a pass.
  console.log(`[f16-parity] SKIP wgsl-webgpu: ${wgsl.unavailable} — the WGSL half of every dual-source filter is UNVERIFIED on this box`);
} else {
  const ring = wgsl.phases?.sharpenWgslRing;
  const eq = (got, want) =>
    Array.isArray(got) && got.length === want.length && want.every((v, i) => Math.abs(got[i] - v) <= 2);
  check(
    "wgsl-webgpu sharpen amount 0 passes the step through",
    eq(ring?.zeroWindow, [102, 102, 102, 153, 153, 153]),
    `zeroWindow=${JSON.stringify(ring?.zeroWindow)} — expected [102, 102, 102, 153, 153, 153] (0.4 | 0.6 in 8-bit, untouched)`,
  );
  check(
    "wgsl-webgpu sharpen rings the step like its GLSL twin",
    eq(ring?.window, [102, 102, 71, 184, 153, 153]),
    `window=${JSON.stringify(ring?.window)} — expected [102, 102, 71, 184, 153, 153] (the WebGL lane's 0.28 / 0.72, at 8-bit)`,
  );
}

if (failed) {
  console.error("\n[f16-parity] GATE FAILED");
  process.exit(1);
} else {
  console.log("\n[f16-parity] GATE PASSED");
  process.exit(0);
}
