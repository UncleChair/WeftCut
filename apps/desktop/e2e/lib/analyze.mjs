import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", "..");

// Runs the media_conformance bin and returns the parsed JSON report. The bin
// prints the report on stdout for exit 0 (pass) AND 1 (regression); exit 2/3
// (bad args / hard error) print only to stderr. So we parse stdout first and
// only throw when there's no parseable report.
export function analyze({ output, source, samples, ssimMin, audio, window }) {
  const args = [
    "run", "--manifest-path", "apps/desktop/native/Cargo.toml",
    "--bin", "media_conformance", "--features", "jobs,export", "--quiet", "--",
    "--output", output, "--source", source, "--samples", samples.join(","),
  ];
  if (ssimMin != null) args.push("--ssim-min", String(ssimMin));
  if (window != null) args.push("--window", String(window));
  if (audio) args.push("--audio");
  const r = spawnSync("cargo", args, { cwd: REPO, encoding: "utf8" });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `media_conformance exit ${r.status}: ${r.stdout}\n${r.stderr}`,
    );
  }
}

// Self-SSIM: compare pairs of indices WITHIN one output video (no source).
// `samples` is read as consecutive pairs [a0,b0,a1,b1,...]. Returns the parsed
// `{ output, ssim_max, pairs:[{a,b,ssim,differ}], pass }`. Used by the motif-
// export e2e to prove an animated motif makes two output frames DIFFER (a
// skipped motif would render static black → near-identical → fail).
export function analyzeSelf({ output, samples, ssimMax }) {
  const args = [
    "run", "--manifest-path", "apps/desktop/native/Cargo.toml",
    "--bin", "media_conformance", "--features", "jobs,export", "--quiet", "--",
    "--self-ssim", "--output", output, "--samples", samples.join(","),
  ];
  if (ssimMax != null) args.push("--ssim-max", String(ssimMax));
  const r = spawnSync("cargo", args, { cwd: REPO, encoding: "utf8" });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `media_conformance --self-ssim exit ${r.status}: ${r.stdout}\n${r.stderr}`,
    );
  }
}

// Windowed-RMS envelope assertions (fades / keyframed gain / limiter ceiling)
// against the deterministic Rust mixer's output. `expects` is
// [{ t_s, expect_rms_db_delta }] — deltas relative to the file's loudest
// 100 ms window. `peakMaxDb` additionally asserts the file's sample peak
// stays at/below the given dBFS (the alimiter ceiling check).
export function analyzeAudioEnvelope({ output, expects, peakMaxDb }) {
  const args = [
    "run", "--manifest-path", "apps/desktop/native/Cargo.toml",
    "--bin", "media_conformance", "--features", "jobs,export", "--quiet", "--",
    "--audio-envelope", JSON.stringify(expects), "--output", output,
  ];
  if (peakMaxDb != null) args.push("--peak-max", String(peakMaxDb));
  const r = spawnSync("cargo", args, { cwd: REPO, encoding: "utf8" });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `media_conformance --audio-envelope exit ${r.status}: ${r.stdout}\n${r.stderr}`,
    );
  }
}

// Whole-file per-channel RMS ratio vs the expected L−R dB delta (pan law).
export function analyzeAudioPan({ output, expectLrDb }) {
  const args = [
    "run", "--manifest-path", "apps/desktop/native/Cargo.toml",
    "--bin", "media_conformance", "--features", "jobs,export", "--quiet", "--",
    "--audio-pan", "--expect-lr-db", String(expectLrDb), "--output", output,
  ];
  const r = spawnSync("cargo", args, { cwd: REPO, encoding: "utf8" });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `media_conformance --audio-pan exit ${r.status}: ${r.stdout}\n${r.stderr}`,
    );
  }
}

// Gradient-row banding probe (--gradient-row): decode frame `sample` of
// `output` as 16-bit RGB under the FORCED `inMatrix`/`inRange` interpretation
// and report per-channel banding over the mid-row (the row is fixed at
// height/2 by the bin — the ramp fixtures vary along X only). Returns the
// parsed `{ sample, row_y, banding: [{distinct_levels, max_plateau} x3 RGB],
// probe_x0, probe_mid }`. No `pass` field — callers assert thresholds (the
// 10-bit ramp gate: distinct_levels > 600 of 1023). The bin's arg guard
// requires `--source` even though gradient mode reads only `--output`, so we
// satisfy it with the output path.
export function analyzeGradientRow({ output, sample, inMatrix, inRange }) {
  const args = [
    "run", "--manifest-path", "apps/desktop/native/Cargo.toml",
    "--bin", "media_conformance", "--features", "jobs,export", "--quiet", "--",
    "--gradient-row", "--output", output, "--source", output,
    "--in-matrix", inMatrix, "--in-range", inRange,
  ];
  if (sample != null) args.push("--sample", String(sample));
  const r = spawnSync("cargo", args, { cwd: REPO, encoding: "utf8" });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `media_conformance --gradient-row exit ${r.status}: ${r.stdout}\n${r.stderr}`,
    );
  }
}

export function analyzeColor({ output, source, manifest, inMatrix, inRange, sample }) {
  const args = [
    "run", "--manifest-path", "apps/desktop/native/Cargo.toml",
    "--bin", "media_conformance", "--features", "jobs,export", "--quiet", "--",
    "--color", "--output", output, "--source", source,
    "--manifest", manifest, "--in-matrix", inMatrix, "--in-range", inRange,
    "--sample", String(sample ?? 10),
  ];
  const r = spawnSync("cargo", args, { cwd: REPO, encoding: "utf8" });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`media_conformance --color exit ${r.status}: ${r.stdout}\n${r.stderr}`);
  }
}
