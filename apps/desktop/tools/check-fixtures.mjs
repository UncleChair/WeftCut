#!/usr/bin/env node
/// CI-style end-to-end gate: render every fixture in apps/desktop/fixtures
/// through the vitest browser test, then SSIM-compare each against its
/// committed baselines via the `fixture_compare` Rust CLI.
///
/// Exits 0 on full pass, 1 on any regression / hard error, 2 on
/// missing baselines (unless `--allow-missing-baseline` is passed).
///
/// Two-step decomposition by design:
///   - `npm run fixtures:render` produces the MP4 set in `build/fixtures/`
///   - `cargo run --bin fixture_compare` consumes each MP4 + the
///     committed `expected/` PNGs.
/// Keeping them separate lets a developer regenerate baselines via a
/// run-only invocation without touching the compare half, and lets CI
/// run the compare against a previously-rendered MP4 set without
/// reinstalling Playwright on every check.

import { readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const FIXTURES_DIR = resolve(PACKAGE_ROOT, "fixtures");
const BUILD_DIR = resolve(PACKAGE_ROOT, "build", "fixtures");

const ARGS = process.argv.slice(2);
const SKIP_RENDER = ARGS.includes("--skip-render");
const ALLOW_MISSING = ARGS.includes("--allow-missing-baseline");

function runChild(cmd, args, opts = {}) {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      cwd: opts.cwd ?? PACKAGE_ROOT,
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        resolveP({ code: 128, signal });
      } else {
        resolveP({ code: code ?? 0 });
      }
    });
    child.on("error", (err) => {
      console.error(`[fixtures:check] failed to spawn ${cmd}: ${err.message}`);
      resolveP({ code: 127 });
    });
  });
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function listFixtures() {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  const fixtures = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const manifestPath = join(FIXTURES_DIR, e.name, "manifest.json");
    if (!(await exists(manifestPath))) continue;
    fixtures.push(e.name);
  }
  fixtures.sort();
  return fixtures;
}

async function main() {
  const fixtures = await listFixtures();
  if (fixtures.length === 0) {
    console.error("[fixtures:check] no fixtures found in", FIXTURES_DIR);
    process.exit(0);
    return;
  }
  console.log(
    `[fixtures:check] ${fixtures.length} fixture(s): ${fixtures.join(", ")}`,
  );

  if (!SKIP_RENDER) {
    console.log("[fixtures:check] step 1/2: rendering via vitest browser…");
    const { code } = await runChild("npm", ["run", "fixtures:render"]);
    if (code !== 0) {
      console.error(`[fixtures:check] render step failed (exit ${code})`);
      process.exit(1);
      return;
    }
  } else {
    console.log("[fixtures:check] --skip-render: using existing build/fixtures/*.mp4");
  }

  console.log("[fixtures:check] step 2/2: SSIM compare per fixture");
  let regressions = 0;
  let missing = 0;
  let hardErrors = 0;
  for (const name of fixtures) {
    const fixtureRoot = join(FIXTURES_DIR, name);
    const mp4Path = join(BUILD_DIR, `${name}.mp4`);
    if (!(await exists(mp4Path))) {
      console.error(`[fixtures:check] ${name}: MP4 missing at ${mp4Path}`);
      hardErrors++;
      continue;
    }
    const cargoArgs = [
      "run",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--bin",
      "fixture_compare",
      "--quiet",
      "--",
      "--fixture",
      fixtureRoot,
      "--mp4",
      mp4Path,
    ];
    if (ALLOW_MISSING) cargoArgs.push("--allow-missing-baseline");
    const { code } = await runChild("cargo", cargoArgs);
    if (code === 0) {
      console.log(`[fixtures:check] ${name}: PASS`);
    } else if (code === 1) {
      console.log(`[fixtures:check] ${name}: FAIL (SSIM regression)`);
      regressions++;
    } else if (code === 4) {
      console.log(`[fixtures:check] ${name}: MISSING BASELINE`);
      missing++;
    } else {
      console.log(`[fixtures:check] ${name}: HARD ERROR (exit ${code})`);
      hardErrors++;
    }
  }

  console.log(
    `[fixtures:check] summary — ${fixtures.length - regressions - missing - hardErrors} pass, ` +
      `${regressions} regression(s), ${missing} missing-baseline, ${hardErrors} hard error(s)`,
  );

  if (regressions > 0 || hardErrors > 0) process.exit(1);
  if (missing > 0 && !ALLOW_MISSING) process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error("[fixtures:check] unhandled:", err);
  process.exit(1);
});
