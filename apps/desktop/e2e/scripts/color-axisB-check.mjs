// Axis-B regression gate: runs the proxy's exact ffmpeg args (proxy.rs) on the
// 10-bit gradient, measures the proxy's gradient banding via media_conformance
// --gradient-row, and fails if fidelity regressed past the recorded baseline
// (gradient_baseline.json). The import->proxy e2e hook is deferred (spec), so
// this gate runs at the analyzer level on the proxy-args output.
//
//   node scripts/color-axisB-check.mjs   (exit 0 = OK, 1 = regression, >1 = error)
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..");
const MEDIA = process.env.WEFTCUT_TEST_MEDIA || path.resolve(HERE, "..", "fixtures", "media");
const SRC = path.resolve(MEDIA, "test_1080p_gradient10.mp4");
const PROXY = path.resolve(os.tmpdir(), "weftcut-axisB-proxy.mp4");
const BASE = JSON.parse(readFileSync(path.resolve(HERE, "..", "fixtures", "gradient_baseline.json"), "utf8"));

if (!existsSync(SRC)) {
  console.warn(`[axisB] SKIP: gradient fixture not found at ${SRC} (run: node fixtures/generate-fixtures.mjs)`);
  process.exit(0);
}

// proxy.rs args verbatim (PROXY_HEIGHT_CAP=2160, PROXY_GOP_FRAMES=6).
const p = spawnSync("ffmpeg", [
  "-y", "-hide_banner", "-loglevel", "error", "-i", SRC,
  "-vf", "scale=-2:'min(ih,2160)'", "-c:v", "libx264", "-preset", "fast", "-crf", "18",
  "-profile:v", "high", "-g", "6", "-keyint_min", "6", "-bf", "0", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-f", "mp4", PROXY,
], { encoding: "utf8" });
if (p.status !== 0) { console.error("proxy ffmpeg failed:\n" + p.stderr); process.exit(2); }

const out = spawnSync("cargo", [
  "run", "--manifest-path", "apps/desktop/native/Cargo.toml", "--bin", "media_conformance",
  "--quiet", "--", "--gradient-row", "--output", PROXY, "--source", PROXY,
  "--in-matrix", "bt709", "--in-range", "tv", "--sample", "10",
], { cwd: REPO, encoding: "utf8" });
let report;
try { report = JSON.parse(out.stdout); } catch { console.error("gradient-row failed: " + out.stdout + "\n" + out.stderr); process.exit(2); }

const luma = report.banding[0];
console.log(`[axisB] proxy distinct_levels=${luma.distinct_levels} (floor ${BASE.proxy_distinct_floor}), max_plateau=${luma.max_plateau} (ceiling ${BASE.proxy_max_plateau_ceiling})`);

let failed = false;
if (luma.distinct_levels < BASE.proxy_distinct_floor) {
  console.error(`[axisB] REGRESSION: distinct_levels ${luma.distinct_levels} < floor ${BASE.proxy_distinct_floor} (proxy banding worsened)`);
  failed = true;
}
if (luma.max_plateau > BASE.proxy_max_plateau_ceiling) {
  console.error(`[axisB] REGRESSION: max_plateau ${luma.max_plateau} > ceiling ${BASE.proxy_max_plateau_ceiling} (gradient flattened)`);
  failed = true;
}
if (failed) process.exit(1);
console.log("[axisB] OK — proxy gradient fidelity within baseline");
