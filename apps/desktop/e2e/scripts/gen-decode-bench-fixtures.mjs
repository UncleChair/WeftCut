// Idempotent decode-bench fixture generator. Synthesizes the spec §2 matrix
// (docs/superpowers/specs/2026-07-03-decode-bench-design.md) with ffmpeg:
// 60 s testsrc2, 30 fps, GOP 240, bt709/limited, no audio. Skips existing
// outputs (delete a file or pass --force to regenerate). Requires ffmpeg +
// ffprobe on PATH (`npm run fetch-ffmpeg` from apps/desktop).
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BENCH_MEDIA_DIR = path.resolve(HERE, "../fixtures/decode-bench");

const DUR_S = 60;
const COLOR = ["-color_primaries", "bt709", "-color_trc", "bt709",
  "-colorspace", "bt709", "-color_range", "tv"];
const X265_GOP = "keyint=240:min-keyint=240:scenecut=0";

/// One row per spec §2 matrix line. `encoder` is checked against
/// `ffmpeg -encoders` so a lean ffmpeg build degrades to a skip, not a crash.
export const BENCH_MATRIX = [
  { name: "h264-1080", ext: "mp4", codec: "h264", width: 1920, height: 1080, pixFmt: "yuv420p", durationUs: DUR_S * 1_000_000, encoder: "libx264",
    args: ["-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-b:v", "12M",
      "-g", "240", "-keyint_min", "240", "-sc_threshold", "0", "-pix_fmt", "yuv420p"] },
  { name: "hevc-1080", ext: "mp4", codec: "hevc", width: 1920, height: 1080, pixFmt: "yuv420p", durationUs: DUR_S * 1_000_000, encoder: "libx265",
    args: ["-c:v", "libx265", "-preset", "fast", "-b:v", "8M",
      "-x265-params", X265_GOP, "-pix_fmt", "yuv420p", "-tag:v", "hvc1"] },
  { name: "hevc-2160", ext: "mp4", codec: "hevc", width: 3840, height: 2160, pixFmt: "yuv420p", durationUs: DUR_S * 1_000_000, encoder: "libx265",
    args: ["-c:v", "libx265", "-preset", "fast", "-b:v", "40M",
      "-x265-params", X265_GOP, "-pix_fmt", "yuv420p", "-tag:v", "hvc1"] },
  { name: "vp9-1080", ext: "webm", codec: "vp9", width: 1920, height: 1080, pixFmt: "yuv420p", durationUs: DUR_S * 1_000_000, encoder: "libvpx-vp9",
    args: ["-c:v", "libvpx-vp9", "-b:v", "8M", "-g", "240",
      "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-pix_fmt", "yuv420p"] },
  { name: "av1-1080", ext: "mp4", codec: "av1", width: 1920, height: 1080, pixFmt: "yuv420p", durationUs: DUR_S * 1_000_000, encoder: "libsvtav1",
    args: ["-c:v", "libsvtav1", "-preset", "8", "-b:v", "8M",
      "-svtav1-params", "keyint=240", "-pix_fmt", "yuv420p"] },
  // WebCodecs-only reference row (native N/A: Result-7 P010 import block).
  { name: "hi10p-1080", ext: "mp4", codec: "hevc", width: 1920, height: 1080, pixFmt: "yuv420p10le", durationUs: DUR_S * 1_000_000, encoder: "libx265",
    args: ["-c:v", "libx265", "-preset", "fast", "-profile:v", "main10", "-b:v", "8M",
      "-x265-params", X265_GOP, "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1"] },
];

export const benchFixturePath = (name) => {
  const row = BENCH_MATRIX.find((r) => r.name === name);
  if (!row) throw new Error(`unknown fixture ${name}`);
  return path.join(BENCH_MEDIA_DIR, `${row.name}.${row.ext}`);
};

const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

function availableEncoders() {
  const r = run("ffmpeg", ["-hide_banner", "-encoders"]);
  if (r.status !== 0) throw new Error("ffmpeg not on PATH — run `npm run fetch-ffmpeg` from apps/desktop");
  return r.stdout;
}

function validate(row, file) {
  const r = run("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,pix_fmt", "-show_entries", "format=duration",
    "-of", "json", file]);
  if (r.status !== 0) return `ffprobe failed: ${r.stderr}`;
  const j = JSON.parse(r.stdout);
  const s = j.streams?.[0];
  if (s?.codec_name !== row.codec) return `codec ${s?.codec_name} != ${row.codec}`;
  if (s?.width !== row.width || s?.height !== row.height) return `size ${s?.width}x${s?.height}`;
  if (s?.pix_fmt !== row.pixFmt) return `pix_fmt ${s?.pix_fmt} != ${row.pixFmt}`;
  const dur = Number(j.format?.duration ?? 0);
  if (Math.abs(dur - DUR_S) > 1) return `duration ${dur}s`;
  return null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const force = process.argv.includes("--force");
  mkdirSync(BENCH_MEDIA_DIR, { recursive: true });
  const encoders = availableEncoders();
  let failures = 0;
  for (const row of BENCH_MATRIX) {
    const out = path.join(BENCH_MEDIA_DIR, `${row.name}.${row.ext}`);
    if (existsSync(out) && !force) { console.log(`skip   ${row.name} (exists)`); continue; }
    if (!encoders.includes(row.encoder)) {
      console.warn(`SKIP   ${row.name}: encoder ${row.encoder} not in this ffmpeg build`);
      failures += 1; continue;
    }
    console.log(`encode ${row.name} …`);
    const r = run("ffmpeg", ["-y", "-f", "lavfi",
      "-i", `testsrc2=size=${row.width}x${row.height}:rate=30`,
      "-t", String(DUR_S), "-an", ...row.args, ...COLOR, out]);
    if (r.status !== 0) { console.error(`FAIL   ${row.name}:\n${r.stderr.slice(-2000)}`); rmSync(out, { force: true }); failures += 1; continue; }
    const bad = validate(row, out);
    if (bad) { console.error(`INVALID ${row.name}: ${bad}`); rmSync(out, { force: true }); failures += 1; continue; }
    console.log(`ok     ${row.name}`);
  }
  process.exit(failures === 0 ? 0 : 1);
}
