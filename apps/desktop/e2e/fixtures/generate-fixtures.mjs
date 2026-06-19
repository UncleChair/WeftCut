// Idempotent fixture generator: defines the matrix (single source of truth) and
// generates any missing clips into `mediaDir` by shelling `go run generate.go`.
// Media is gitignored; the generator + this script are committed, so fixtures
// are reproducible from a checkout. Requires `go` + `ffmpeg` on PATH.
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATOR = path.join(HERE, "generate.go");
const WIDTH_HEIGHT = "1080"; // generate.go is hard-coded 1920x1080

// The fixture matrix. Output filenames MUST match what generate.go writes.
export const MATRIX = [
  // video-only (true BT.709, -an) — the video conformance axis
  { fps: 30, format: "mp4" },
  { fps: 60, format: "mp4" },
  { fps: 120, format: "mp4" },
  { fps: 30, format: "mkv" },
  { fps: 30, format: "prores" }, // emits test_1080p_30fps_prores.mov
  // audio (per-second tone markers) — sources for the audio axis (3 frame rates)
  { fps: 30, format: "mp4", audio: true },
  { fps: 60, format: "mp4", audio: true },
  { fps: 120, format: "mp4", audio: true },
  // EOS-tail geometry (keys at 0s/5s only + audio 1s longer than video) —
  // the export tail-deadlock gate (export_eos_tail.e2e.js)
  { fps: 30, format: "mp4", eostail: true },
  // color charts (flat patches, tagged) — axis A fixtures
  { color: "709ltd" },
  { color: "601ltd" },
  { color: "709full" },
  { color: "601full" },
  // 10-bit BT.709 grayscale ramp (HEVC Main10) — axis B "proxy fidelity on gradients"
  { gradient: true },
  // 10-bit ramps as H.264 High10 (the one 10-bit shape Chromium software-
  // decodes) — the 10-bit export gates (export_10bit.e2e.js): a static 1s ramp
  // (end-to-end fidelity) + a 10s animated long-GOP/B-frame ramp (reorder-tail
  // regression).
  { gradientH264: true },
  { gradientH264Bf: true },
  // 10-bit ramp as AV1 10-bit (SVT-AV1) — the AV1-10 source admission probe +
  // export gate (the second tenBitExportCapable codec).
  { gradientAv1: true },
  // The H.264 High10 ramp at 3840x2160 — the 4K ring-cap export gate
  // (resolution-derived ten-bit high-water clamps to its entry floor).
  { gradientH2644k: true },
  // still-image chart set (png/jpg/webp/bmp/gif/tiff + manifest, one flag) —
  // ui/layers.e2e.js. The png is the canonical existence check; the
  // generator writes the whole set in one run.
  { imageset: true },
  // audio-ONLY per-second tone files — audio/audio.e2e.js. The mp3 embeds
  // attached_pic cover art (regression for the still-image/cover-art
  // classification fix in probe::detect_kind).
  { audiotones: true, aformat: "wav" },
  { audiotones: true, aformat: "mp3" },
  { audiotones: true, aformat: "flac" },
  { audiotones: true, aformat: "m4a" },
  { audiotones: true, aformat: "ogg" },
  // animated gif — classifies as VIDEO (multi-frame) and routes through the
  // full-proxy pipeline; ui/layers.e2e.js asserts that routing.
  { fps: 10, format: "gif" },
];

export function outputName({ fps, format, audio, color, gradient, gradientH264, gradientH264Bf, gradientAv1, gradientH2644k, eostail, imageset, audiotones, aformat }) {
  if (imageset) return "test_chart_320x240.png";
  if (audiotones) return `test_tones_10s.${aformat}`;
  if (color) return `test_${WIDTH_HEIGHT}p_color_${color}.mp4`;
  if (gradient) return `test_${WIDTH_HEIGHT}p_gradient10.mp4`;
  if (gradientH264) return `test_${WIDTH_HEIGHT}p_gradient10_h264.mp4`;
  if (gradientH264Bf) return `test_${WIDTH_HEIGHT}p_gradient10_h264_bf.mp4`;
  if (gradientAv1) return `test_${WIDTH_HEIGHT}p_gradient10_av1.mp4`;
  if (gradientH2644k) return "test_2160p_gradient10_h264.mp4";
  if (format === "prores") return `test_${WIDTH_HEIGHT}p_${fps}fps_prores.mov`;
  if (eostail) return `test_${WIDTH_HEIGHT}p_${fps}fps_eostail.${format}`;
  if (audio) return `test_${WIDTH_HEIGHT}p_${fps}fps_audio.${format}`;
  return `test_${WIDTH_HEIGHT}p_${fps}fps.${format}`;
}

/// Generate any missing matrix clip into `mediaDir`. Existing files are skipped
/// (fast no-op). Throws if a generation fails or produces no file.
export async function ensureFixtures(mediaDir) {
  for (const entry of MATRIX) {
    const name = outputName(entry);
    const dest = path.join(mediaDir, name);
    if (existsSync(dest)) {
      console.log(`[fixtures] skip (exists): ${name}`);
      continue;
    }
    const args = entry.imageset
      ? ["run", GENERATOR, "--imageset"]
      : entry.audiotones
        ? ["run", GENERATOR, "--audiotones", "--aformat", entry.aformat]
        : entry.color
          ? ["run", GENERATOR, "--color", entry.color]
          : entry.gradient
            ? ["run", GENERATOR, "--gradient"]
            : entry.gradientH264
              ? ["run", GENERATOR, "--gradient-h264"]
              : entry.gradientH264Bf
                ? ["run", GENERATOR, "--gradient-h264-bf"]
                : entry.gradientAv1
                  ? ["run", GENERATOR, "--gradient-av1"]
                  : entry.gradientH2644k
                    ? ["run", GENERATOR, "--gradient-h264-4k"]
                    : ["run", GENERATOR, "--fps", String(entry.fps), "--format", entry.format];
    if (entry.audio) args.push("--audio");
    if (entry.eostail) args.push("--eostail");
    console.log(`[fixtures] generating ${name} ...`);
    const r = spawnSync("go", args, { cwd: mediaDir, stdio: "inherit", shell: true });
    if (r.status !== 0) {
      throw new Error(`generate.go failed for ${name} (exit ${r.status})`);
    }
    if (!existsSync(dest)) {
      throw new Error(`generate.go ran but did not produce ${dest}`);
    }
  }
}

// Standalone: `node generate-fixtures.mjs [mediaDir]`
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const mediaDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, "media");
  ensureFixtures(mediaDir)
    .then(() => console.log("[fixtures] done"))
    .catch((e) => {
      console.error("[fixtures]", e.message);
      process.exit(1);
    });
}
