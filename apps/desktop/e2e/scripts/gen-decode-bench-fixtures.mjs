// Idempotent decode-bench fixture generator. Synthesizes the fixture matrix
// (docs/decode-bench.md §What it measures) with ffmpeg:
// 60 s testsrc2, 30 fps, GOP 240, bt709/limited, no audio. Skips existing
// outputs (delete a file or pass --force to regenerate). Uses $FFMPEG/$FFPROBE
// when set, else ffmpeg + ffprobe on PATH (`npm run ffmpeg:fetch` from
// apps/desktop).
//
// Flags:
//   --force          regenerate outputs that already exist
//   --only a,b       generate just these rows (default: the whole matrix). The
//                    e2e conformance gates that read these fixtures need two of
//                    twelve rows; a CI leg generating the whole matrix would
//                    spend minutes and gigabytes on cells nothing there reads.
//
// Clip length is fixed at 60 s: the specs are written against it (preview-sw-
// families far-seeks to 50 s to strand the ring), and the bench derives its
// expected frame count from `durationUs` below. A shorter cut is not a knob —
// it silently breaks both readers.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BENCH_MEDIA_DIR = path.resolve(HERE, "../fixtures/decode-bench");

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";

const DUR_S = 60;
const COLOR = ["-color_primaries", "bt709", "-color_trc", "bt709",
  "-colorspace", "bt709", "-color_range", "tv"];
const X265_GOP = "keyint=240:min-keyint=240:scenecut=0";

/// One row per matrix line in docs/decode-bench.md §What it measures.
/// `encoder` is checked against `ffmpeg -encoders` so a lean ffmpeg build
/// degrades to a skip, not a crash.
export const BENCH_MATRIX = [
  { name: "h264-1080", ext: "mp4", codec: "h264", width: 1920, height: 1080, pixFmt: "yuv420p", durationUs: DUR_S * 1_000_000, encoder: "libx264",
    args: ["-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-b:v", "12M",
      "-g", "240", "-keyint_min", "240", "-sc_threshold", "0", "-pix_fmt", "yuv420p"] },
  { name: "h264-2160", ext: "mp4", codec: "h264", width: 3840, height: 2160, pixFmt: "yuv420p", durationUs: DUR_S * 1_000_000, encoder: "libx264",
    args: ["-c:v", "libx264", "-preset", "medium", "-profile:v", "high", "-b:v", "40M",
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
  // WebCodecs-only reference row (native N/A: P010 import is blocked).
  { name: "hi10p-1080", ext: "mp4", codec: "hevc", width: 1920, height: 1080, pixFmt: "yuv420p10le", durationUs: DUR_S * 1_000_000, encoder: "libx265",
    args: ["-c:v", "libx265", "-preset", "fast", "-profile:v", "main10", "-b:v", "8M",
      "-x265-params", X265_GOP, "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1"] },
  // preview-sw fixtures: all-intra 10-bit 4:2:2, WebCodecs-blind — decoded
  // only via the ffmpeg engine's software lane (FfmpegSource).
  { name: "prores-1080", ext: "mov", codec: "prores", width: 1920, height: 1080, pixFmt: "yuv422p10le", durationUs: DUR_S * 1_000_000, encoder: "prores_ks",
    args: ["-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le"] },
  { name: "prores-2160", ext: "mov", codec: "prores", width: 3840, height: 2160, pixFmt: "yuv422p10le", durationUs: DUR_S * 1_000_000, encoder: "prores_ks",
    args: ["-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le"] },
  // preview-sw families. DNxHR = intra 8-bit 4:2:2; MPEG-2 = long-GOP 8-bit
  // 4:2:0 (exercises decode-forward-to-target seek). VC-1/WMV3
  // are omitted: ffmpeg has no VC-1/WMV3 encoder, so no synthetic fixture is
  // possible — they are covered by the routing test + codec-agnostic decoder.
  { name: "dnxhr-1080", ext: "mov", codec: "dnxhd", width: 1920, height: 1080, pixFmt: "yuv422p", durationUs: DUR_S * 1_000_000, encoder: "dnxhd",
    args: ["-c:v", "dnxhd", "-profile:v", "dnxhr_hq", "-pix_fmt", "yuv422p"] },
  { name: "mpeg2-1080", ext: "mpg", codec: "mpeg2video", width: 1920, height: 1080, pixFmt: "yuv420p", durationUs: DUR_S * 1_000_000, encoder: "mpeg2video",
    args: ["-c:v", "mpeg2video", "-b:v", "20M", "-g", "15", "-bf", "2", "-pix_fmt", "yuv420p"] },
];

export const benchFixturePath = (name) => {
  const row = BENCH_MATRIX.find((r) => r.name === name);
  if (!row) throw new Error(`unknown fixture ${name}`);
  return path.join(BENCH_MEDIA_DIR, `${row.name}.${row.ext}`);
};

const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

function availableEncoders() {
  const r = run(FFMPEG, ["-hide_banner", "-encoders"]);
  if (r.status !== 0) throw new Error(`${FFMPEG} not runnable — run \`npm run ffmpeg:fetch\` from apps/desktop, or set $FFMPEG`);
  return r.stdout;
}

function validate(row, file) {
  const r = run(FFPROBE, ["-v", "error", "-select_streams", "v:0",
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

/// `--only a,b`, space- or `=`-separated.
export function parseArgs(argv) {
  const eq = argv.find((a) => a.startsWith("--only="));
  const i = argv.indexOf("--only");
  const only = eq ? eq.slice("--only=".length) : i === -1 ? null : argv[i + 1];
  return {
    force: argv.includes("--force"),
    only: only ? only.split(",").map((s) => s.trim()).filter(Boolean) : null,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { force, only } = parseArgs(process.argv.slice(2));
  const unknown = (only ?? []).filter((n) => !BENCH_MATRIX.some((r) => r.name === n));
  if (unknown.length) {
    console.error(`unknown fixture(s): ${unknown.join(", ")}`);
    process.exit(1);
  }
  const rows = only ? BENCH_MATRIX.filter((r) => only.includes(r.name)) : BENCH_MATRIX;
  mkdirSync(BENCH_MEDIA_DIR, { recursive: true });
  const encoders = availableEncoders();
  let failures = 0;
  for (const row of rows) {
    const out = path.join(BENCH_MEDIA_DIR, `${row.name}.${row.ext}`);
    if (existsSync(out) && !force) { console.log(`skip   ${row.name} (exists)`); continue; }
    if (!encoders.includes(row.encoder)) {
      console.warn(`SKIP   ${row.name}: encoder ${row.encoder} not in this ffmpeg build`);
      failures += 1; continue;
    }
    console.log(`encode ${row.name} …`);
    const r = run(FFMPEG, ["-y", "-f", "lavfi",
      "-i", `testsrc2=size=${row.width}x${row.height}:rate=30`,
      "-t", String(DUR_S), "-an", ...row.args, ...COLOR, out]);
    if (r.status !== 0) { console.error(`FAIL   ${row.name}:\n${r.stderr.slice(-2000)}`); rmSync(out, { force: true }); failures += 1; continue; }
    const bad = validate(row, out);
    if (bad) { console.error(`INVALID ${row.name}: ${bad}`); rmSync(out, { force: true }); failures += 1; continue; }
    console.log(`ok     ${row.name}`);
  }
  process.exit(failures === 0 ? 0 : 1);
}
