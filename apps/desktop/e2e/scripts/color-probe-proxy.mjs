// Axis-B probe (one-shot diagnostic, NOT a gate). Runs the proxy's transcode
// args (apps/desktop/native/src/jobs/proxy.rs) on the 10-bit gradient
// and reports what the 10->8 reduction does: proxy tags, pix_fmt, dither
// (distinct-level recovery + noise), banding (plateau widening), and the 10->16
// decode scaling. Findings feed the axis-B baseline (gradient_baseline.json).
//
//   node scripts/color-probe-proxy.mjs
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..");
const MEDIA = process.env.WEFTCUT_TEST_MEDIA || path.resolve(HERE, "..", "fixtures", "media");
const SRC = path.resolve(MEDIA, "test_1080p_gradient10.mp4");
const PROXY = path.resolve(os.tmpdir(), "weftcut-probe-proxy.mp4");

// proxy.rs scale/codec/GOP args only (proxy.rs also asserts the source's color
// tags via `source_color_args` + `+write_colr`; this probe does not).
// CAP = PROXY_HEIGHT_CAP (2160), GOP = PROXY_GOP_FRAMES (6).
const CAP = 2160;
const GOP = 6;
const proxyArgs = [
  "-y", "-hide_banner", "-loglevel", "error", "-i", SRC,
  "-vf", `scale=-2:'min(ih,${CAP})'`, "-c:v", "libx264", "-preset", "fast", "-crf", "18",
  "-profile:v", "high", "-g", String(GOP), "-keyint_min", String(GOP), "-bf", "0",
  "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-f", "mp4", PROXY,
];
const p = spawnSync("ffmpeg", proxyArgs, { encoding: "utf8" });
if (p.status !== 0) {
  console.error("proxy ffmpeg failed:\n" + p.stderr);
  process.exit(1);
}

const tag = (f) =>
  spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=pix_fmt,color_space,color_range,color_transfer,color_primaries", "-of", "default", f],
    { encoding: "utf8" },
  ).stdout;
console.log("=== SOURCE TAGS ===\n" + tag(SRC));
console.log("=== PROXY TAGS ===\n" + tag(PROXY));

const grad = (f) =>
  spawnSync(
    "cargo",
    ["run", "--manifest-path", "apps/desktop/native/Cargo.toml", "--bin", "media_conformance",
      "--quiet", "--", "--gradient-row", "--output", f, "--source", f,
      "--in-matrix", "bt709", "--in-range", "tv", "--sample", "10"],
    { cwd: REPO, encoding: "utf8" },
  ).stdout;
console.log("=== SOURCE gradient (10-bit) ===\n" + grad(SRC));
console.log("=== PROXY gradient (8-bit, post libx264 -crf 18) ===\n" + grad(PROXY));
console.log(
  "NOTE: 10->16 decode scaling — source probe_mid[0]/512 ~= 65535/1023 (full-scale), NOT <<6 (64).",
);
