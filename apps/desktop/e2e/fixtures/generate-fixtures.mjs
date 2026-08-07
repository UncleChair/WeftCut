// Idempotent fixture generator: defines the matrix (single source of truth) and
// generates missing clips through the dependency-free Node generator. Media is
// gitignored; both scripts are committed, so a checkout only needs Node +
// ffmpeg to reproduce the fixtures.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateFixture, outputName } from "./generate.mjs";

export { outputName } from "./generate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The fixture matrix. Output filenames MUST match what generate.mjs writes.
export const MATRIX = [
  // video-only (true BT.709, -an) — the video conformance axis
  { fps: 30, format: "mp4" },
  { fps: 60, format: "mp4" },
  { fps: 120, format: "mp4" },
  { fps: 30, format: "mkv" },
  { fps: 30, format: "prores" }, // emits test_1080p_30fps_prores.mov
  // short standard clip (6s, pinned 2s GOPs) — the codec-shape export smokes
  // (export_codecs.spec.ts). The 10s clips owe their second keyframe to x264's
  // default keyint=250; the explicit -g 60 keeps mid-GOP and cross-GOP sample
  // geometry alive at the shorter runtime.
  { fps: 30, format: "mp4", seconds: 6, gop: 60 },
  // audio (per-second tone markers) — sources for the audio axis (3 frame rates)
  { fps: 30, format: "mp4", audio: true },
  { fps: 60, format: "mp4", audio: true },
  { fps: 120, format: "mp4", audio: true },
  // EOS-tail geometry (keys at 0s/5s only + audio 1s longer than video) —
  // the export tail-deadlock gate (export_eos_tail.spec.ts)
  { fps: 30, format: "mp4", eostail: true },
  // color charts (flat patches, tagged) — axis A fixtures
  { color: "709ltd" },
  { color: "601ltd" },
  { color: "709full" },
  { color: "601full" },
  // the 709ltd chart as color-tagged 10-bit ProRes 422 HQ — the export
  // decode-engine ProRes fidelity gate (export-prores-fidelity.spec.ts)
  { colorProres: true },
  // the same chart 601-tagged — the preview native-SW color gate's
  // no-over-correction leg (preview-sw-color.spec.ts)
  { colorProres: true, colorProresEnc: "601ltd" },
  // 10-bit BT.709 grayscale ramp (HEVC Main10) — axis B "proxy fidelity on gradients"
  { gradient: true },
  // 10-bit ramps as H.264 High10 (the one 10-bit shape Chromium software-
  // decodes) — the 10-bit export gates (export_codecs.spec.ts): a static 1s ramp
  // (end-to-end fidelity) + a 10s animated long-GOP/B-frame ramp (reorder-tail
  // regression).
  { gradientH264: true },
  { gradientH264Bf: true },
  // 10-bit ramp as AV1 10-bit — the AV1-10 source admission probe + export
  // gate (the second tenBitExportCapable codec). Encoder choice and its
  // fallback: `pickAv1Encoder` in generate.mjs.
  { gradientAv1: true },
  // The H.264 High10 ramp at 3840x2160 — the 4K ring-cap export gate
  // (resolution-derived ten-bit high-water clamps to its entry floor).
  { gradientH2644k: true },
  // 8-bit interframe H.264 (1080p30, 1s GOPs) — the lane-parameterized preview
  // HW conformance gates (preview-hw-conformance.spec.ts: NVDEC/VAAPI/d3d11va/
  // VideoToolbox).
  { h264Interframe: true },
  // still-image chart set (png/jpg/webp/bmp/gif/tiff + manifest, one flag) —
  // media-import.spec.ts. The png is the canonical existence check; the
  // generator writes the whole set in one run.
  { imageset: true },
  // audio-ONLY per-second tone files — audio.spec.ts. The mp3 embeds
  // attached_pic cover art (regression for the still-image/cover-art
  // classification fix in probe::detect_kind).
  { audiotones: true, aformat: "wav" },
  { audiotones: true, aformat: "mp3" },
  { audiotones: true, aformat: "flac" },
  { audiotones: true, aformat: "m4a" },
  { audiotones: true, aformat: "ogg" },
  // Sparse sound islands at known source times. The pair differs only by a
  // shared A/V first-PTS offset, isolating PTS normalization from waveform
  // generation/loading and the preview clock.
  { audioTiming: true, ptsOffsetMs: 0 },
  { audioTiming: true, ptsOffsetMs: 375 },
  // Long sparse marker fixture: catches accumulated timebase drift at the
  // 62/15/7-ish peaks/s LODs selected by 80/15/8 px/s timelines.
  { audioTimingLong: true },
  // animated gif — multi-frame, so probe::detect_kind classifies it IMAGE (an
  // animated image the renderer loops; no proxy); media-gif-animated.spec.ts
  // asserts that routing plus the animate/loop/export behavior.
  { fps: 10, format: "gif" },
];

/// Generate any missing matrix clip into `mediaDir`. Existing files are skipped
/// (fast no-op). Throws if a generation fails or produces no file.
export async function ensureFixtures(mediaDir, {
  matrix = MATRIX,
  generate = generateFixture,
} = {}) {
  mkdirSync(mediaDir, { recursive: true });

  for (const entry of matrix) {
    const name = outputName(entry);
    const dest = path.join(mediaDir, name);
    if (existsSync(dest)) {
      console.log(`[fixtures] skip (exists): ${name}`);
      continue;
    }
    console.log(`[fixtures] generating ${name} ...`);
    await generate(entry, { outputDir: mediaDir });
    if (!existsSync(dest)) {
      throw new Error(`generate.mjs ran but did not produce ${dest}`);
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
