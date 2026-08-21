// Idempotent fixture generator: defines the matrix (single source of truth) and
// brings the media on disk up to date with the recipes in generate.mjs. Media is
// gitignored; both scripts are committed, so a checkout only needs Node +
// ffmpeg to reproduce the fixtures.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateFixture, outputName, recipeOf, writeFileAtomic } from "./generate.mjs";

export { outputName } from "./generate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MANIFEST_NAME = "manifest.json";
/// Bump when the manifest's own shape changes: an unreadable version means
/// nothing on disk is accounted for, so the whole matrix is regenerated.
const MANIFEST_VERSION = 1;
/// Committed to keep the gitignored media directory in the tree, so it is never
/// an unclaimed file.
const KEEP_FILE = ".gitkeep";

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
  // media-import.spec.ts. The generator writes the whole set in one run, and
  // the manifest claims all seven, so losing any one of them regenerates it.
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

/// The `{ hash, files }` an earlier pass recorded per entry. Absent, truncated
/// or version-mismatched all mean the same thing — nothing on disk is accounted
/// for, so every entry is stale. There is deliberately no way to declare the
/// media trustworthy instead: an escape hatch from this check would be reached
/// for exactly when an unexplained regeneration is inconvenient, which is the
/// case it exists to catch.
function readManifest(manifestPath) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (parsed?.version !== MANIFEST_VERSION || !parsed.entries) return {};
    return parsed.entries;
  } catch {
    return {};
  }
}

/// Bring `mediaDir` up to date with the recipes and record what it now holds.
/// Existence is not evidence — an edited recipe leaves the old file in place
/// under its old name, and an entry that writes seven files (the imageset) still
/// has one canonical name — so each entry is checked against its `recipeOf`
/// hash and its complete file set, and only the entries that disagree are
/// deleted and regenerated. Throws if a generation fails or leaves a claimed
/// file missing.
export async function ensureFixtures(mediaDir, {
  matrix = MATRIX,
  generate = generateFixture,
} = {}) {
  mkdirSync(mediaDir, { recursive: true });
  const manifestPath = path.join(mediaDir, MANIFEST_NAME);
  const recorded = readManifest(manifestPath);
  const entries = {};

  try {
    for (const entry of matrix) {
      const name = outputName(entry);
      const { hash, files } = recipeOf(entry);
      const previous = recorded[name];
      const missing = files.filter((file) => !existsSync(path.join(mediaDir, file)));

      if (previous?.hash === hash && missing.length === 0) {
        console.log(`[fixtures] skip (recipe matches): ${name}`);
        entries[name] = { hash, files };
        continue;
      }

      const reason = previous === undefined
        ? "unrecorded"
        : previous.hash === hash
          ? `missing ${missing.join(", ")}`
          : "recipe moved";
      console.log(`[fixtures] generating ${name} (${reason}) ...`);
      for (const file of files) rmSync(path.join(mediaDir, file), { force: true });
      await generate(entry, { outputDir: mediaDir });

      const absent = files.filter((file) => !existsSync(path.join(mediaDir, file)));
      if (absent.length > 0) {
        throw new Error(`generate.mjs ran but did not produce ${absent.join(", ")} in ${mediaDir}`);
      }
      entries[name] = { hash, files };
    }
  } finally {
    // Recorded even when an entry throws, so a failure halfway through a cold
    // 4-minute pass does not cost the retry everything that already verified.
    // An entry only reaches `entries` after its files are on disk, so a partial
    // manifest is still only ever a claim about media that exists.
    writeFileAtomic(
      manifestPath,
      `${JSON.stringify({ version: MANIFEST_VERSION, entries }, null, 2)}\n`,
    );
  }

  reportUnclaimed(mediaDir, entries);
}

/// Name the files no entry claims. Reported, never deleted: a sweep would take
/// the committed `.gitkeep`, and the value here is surfacing unregistered output
/// (a recipe writing a file the manifest cannot see), not tidiness.
function reportUnclaimed(mediaDir, entries) {
  const claimed = new Set([MANIFEST_NAME, KEEP_FILE]);
  for (const { files } of Object.values(entries)) {
    for (const file of files) claimed.add(file);
  }

  const unclaimed = readdirSync(mediaDir).filter((name) => !claimed.has(name));
  if (unclaimed.length > 0) {
    console.log(`[fixtures] unclaimed, kept: ${unclaimed.join(", ")}`);
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
