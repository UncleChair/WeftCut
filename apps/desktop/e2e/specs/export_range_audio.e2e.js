import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { analyze } from "../lib/analyze.mjs";

// Runtime smoke for the export-range + audio-settings feature, end-to-end
// through the real WebView2 + real ffmpeg mux. Reuses the per-second
// tone-marker audio fixture (F_k = 400 + 120k Hz at output second k) so the
// `media_conformance --audio` Goertzel can read which source-second each
// output-second carries — the key to proving the audio trim.
const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-range-audio-proj");

// The 30fps tone-marker fixture (shared with audio_conformance). Output fps
// follows the 30fps composition, so source second k -> tone F_k = 400 + 120k.
const SOURCE = path.resolve(MEDIA_DIR, "test_1080p_30fps_audio.mp4");
// Burned-in-counter video fixture (no audio) — used for the software-encode
// case, where the check is video frame-alignment + SSIM (hwAccel only affects
// the video encoder; audio is Rust-side and unaffected).
const VIDEO_SOURCE = path.resolve(MEDIA_DIR, "test_1080p_30fps.mp4");

function toneHz(second) {
  return 400 + 120 * second;
}

/// Boot a fresh 30fps project at `<PROJECT_PARENT>/<namePrefix><now>/` and
/// wait for the editor hooks to mount.
async function bootProject(namePrefix) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => typeof window.__weftcutTest?.newProjectAndEnter === "function",
      )) === true,
    { timeout: 30000, timeoutMsg: "newProjectAndEnter never mounted" },
  );
  const r1 = await browser.executeAsync((parent, name, done) => {
    window.__weftcutTest
      .newProjectAndEnter({
        parentFolder: parent,
        name,
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      .then(() => done({ ok: true }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, PROJECT_PARENT, namePrefix + Date.now());
  if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);

  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => typeof window.__weftcutTest?.exportClip === "function",
      )) === true,
    { timeout: 30000, timeoutMsg: "exportClip never mounted" },
  );
}

/// Poll an export started via `window.__e2eExportDone` to settlement,
/// surfacing the last export-state snapshot in any failure message.
async function waitExportSettled(timeout = 170000) {
  let lastFrame = -1;
  let lastKind = null;
  let lastDetail = null;
  let settled = null;
  try {
    await browser.waitUntil(
      async () => {
        const snap = await browser.execute(() => {
          const st = window.__weftcutExportState;
          return {
            done: window.__e2eExportDone,
            kind: st?.kind ?? null,
            detail: st?.detail ?? null,
            frame: st?.progress?.frame ?? null,
          };
        });
        if (snap.frame != null && snap.frame !== lastFrame) lastFrame = snap.frame;
        if (snap.kind != null) lastKind = snap.kind;
        if (snap.detail != null) lastDetail = snap.detail;
        if (snap.done) { settled = snap.done; return true; }
        return false;
      },
      { timeout, interval: 1000 },
    );
  } catch (e) {
    throw new Error(
      `export never settled (last frame=${lastFrame}, kind=${lastKind}, detail=${lastDetail}): ${e.message}`,
    );
  }
  if (!settled.ok) {
    throw new Error(
      `export failed: ${settled.error} | exportState kind=${lastKind} detail=${lastDetail} (last frame=${lastFrame})`,
    );
  }
  return { settled, lastKind, lastDetail };
}

/// Boot a fresh 30fps project, then drive `exportClip` and wait for it to
/// settle. Returns { settled, perf, lastKind, lastDetail }. `perf` is the
/// worker's `window.__weftcutExportPerf` (E2E-only), carrying `totalFrames`.
async function bootAndExport({ output, settings, range, source = SOURCE }) {
  await bootProject("e2e-range-audio-");

  await browser.execute(
    (media, out, s, rng) => {
      window.__e2eExportDone = null;
      window.__weftcutExportPerf = null;
      const args = { mediaAbsPath: media, outputAbsPath: out };
      if (s) args.settings = s;
      if (rng) args.range = rng;
      window.__weftcutTest
        .exportClip(args)
        .then(() => { window.__e2eExportDone = { ok: true }; })
        .catch((e) => { window.__e2eExportDone = { ok: false, error: String(e) }; });
    },
    source,
    output,
    settings ?? null,
    range ?? null,
  );

  const { settled, lastKind, lastDetail } = await waitExportSettled();
  const perf = await browser.execute(() => window.__weftcutExportPerf ?? null);
  return { settled, perf, lastKind, lastDetail };
}

/// Decode a file's audio to mono s16le PCM and return it as a Float32Array in
/// [-1, 1]. Used to verify trimmed-export tones directly — `media_conformance
/// --audio` can't: its candidate tone set is `400 + 120*outputSecondIndex`, so
/// a range export (whose tones are shifted by the In point) falls outside the
/// candidates and mis-detects. A direct Goertzel against the true shifted tones
/// is the right tool here.
function extractPcm(file, sr = 48000) {
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-ac", "1", "-ar", String(sr), "-f", "s16le", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) {
    throw new Error(`ffmpeg PCM extract failed (${r.status}): ${r.stderr ?? ""}`);
  }
  const n = r.stdout.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = r.stdout.readInt16LE(i * 2) / 32768;
  return out;
}

/// Goertzel power at `freq` over `samples`.
function goertzelPower(samples, freq, sr) {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sr);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/// Dominant candidate tone in the 1-second window at `second`.
function dominantTone(pcm, second, candidates, sr = 48000) {
  const seg = pcm.subarray(second * sr, (second + 1) * sr);
  let bestF = null;
  let bestP = -Infinity;
  for (const f of candidates) {
    const p = goertzelPower(seg, f, sr);
    if (p > bestP) {
      bestP = p;
      bestF = f;
    }
  }
  return bestF;
}

/// ffprobe a file's video keyframe timestamps (seconds, sorted). Returns null
/// when ffprobe isn't on PATH (soft-skip). `-skip_frame nokey` decodes only
/// keyframes, so `frame=pts_time` lists their presentation times.
function keyframeTimestamps(file) {
  const r = spawnSync(
    "ffprobe",
    [
      "-v", "error", "-select_streams", "v", "-skip_frame", "nokey",
      "-show_entries", "frame=pts_time", "-of", "csv=p=0", file,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.error) return null; // ffprobe not found
  if (r.status !== 0) throw new Error(`ffprobe keyframes failed: ${r.stderr ?? ""}`);
  return r.stdout
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
}

/// ffprobe a file for audio streams. Returns true/false, or null when ffprobe
/// isn't on PATH (so the caller can soft-skip rather than fail on tooling).
function hasAudioStream(file) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  if (r.error) return null; // ffprobe not found
  return r.stdout.trim().length > 0;
}

describe("export range + audio settings (real WebView2)", function () {
  before(function () {
    if (!existsSync(SOURCE)) {
      console.warn(`[e2e] SKIP suite: source not found at ${SOURCE}`);
      this.skip();
    }
    mkdirSync(PROJECT_PARENT, { recursive: true });
  });

  it("sub-range export trims both video frame count and audio to the window", async function () {
    // Window [1s, 3s): 2 s at the 30fps composition = 60 output frames. Audio
    // output-second 0 should carry the source's 1 s tone (520 Hz), second 1 the
    // 2 s tone (640 Hz) — proving the audio was trimmed to the In point and
    // rebased to PTS 0, not exported from the start.
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-range.mp4");
    rmSync(output, { force: true });

    const { perf } = await bootAndExport({
      output,
      range: { startUs: 1_000_000, endUs: 3_000_000 },
    });

    // Video: exactly the windowed frame count (not the whole clip).
    expect(perf).not.toBe(null);
    expect(perf.totalFrames).toBe(60);

    // Audio: each output second carries the In-shifted source tone, proving the
    // audio was trimmed to the In point AND rebased to 0 (not exported from the
    // start, not truncated). Direct Goertzel against the candidate tones — the
    // In-second tone (520) must dominate second 0 and the next (640) second 1.
    const pcm = extractPcm(output);
    const cands = [toneHz(0), toneHz(1), toneHz(2), toneHz(3)]; // 400/520/640/760
    expect(dominantTone(pcm, 0, cands)).toBe(toneHz(1)); // source 1 s -> 520 Hz
    expect(dominantTone(pcm, 1, cands)).toBe(toneHz(2)); // source 2 s -> 640 Hz
  });

  it("Opus-in-MKV export is produced and stays audio-faithful", async function () {
    // Whole-clip export to MKV with the Opus audio codec: exercises the real
    // libopus encode -> .mka -> stream-copy into .mkv path end to end.
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-opus.mkv");
    rmSync(output, { force: true });

    await bootAndExport({
      output,
      settings: { container: "mkv", audio: { codec: "opus" } },
    });

    const report = analyze({ output, source: SOURCE, samples: [0], audio: true });
    console.log("[e2e] opus audio report:", JSON.stringify(report));
    const misaligned = report.samples.filter((s) => !s.aligned);
    expect(misaligned).toHaveLength(0);
    expect(Math.abs(report.drift_slope - 1)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(report.offset_ms)).toBeLessThanOrEqual(66);
    expect(report.pass).toBe(true);
  });

  it("mute export produces a video file with no audio track", async function () {
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-mute.mp4");
    rmSync(output, { force: true });

    // bootAndExport asserts the file was written (the hook's exists() check).
    await bootAndExport({
      output,
      settings: { audio: { include: false } },
    });

    const audio = hasAudioStream(output);
    if (audio === null) {
      console.warn("[e2e] ffprobe not on PATH — skipping the no-audio-track assertion");
      return;
    }
    expect(audio).toBe(false);
  });

  it("keyframe interval setting controls the GOP cadence", async function () {
    // Whole-clip export with a 2 s keyframe interval. The WebCodecs path forces
    // a keyframe every round(fps×2) frames, so ffprobe should see keyframes
    // ~2 s apart — clearly not the 1 s default. Proves the setting reaches the
    // real encoder, not just the unit-level gopFrames math.
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-gop.mp4");
    rmSync(output, { force: true });

    await bootAndExport({ output, settings: { keyframeIntervalSec: 2 } });

    const kf = keyframeTimestamps(output);
    if (kf === null) {
      console.warn("[e2e] ffprobe not on PATH — skipping the keyframe-spacing assertion");
      return;
    }
    console.log("[e2e] keyframe timestamps (s):", JSON.stringify(kf));
    expect(kf.length).toBeGreaterThanOrEqual(3); // enough gaps to measure
    const gaps = kf.slice(1).map((t, i) => t - kf[i]).sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)];
    // ~2 s cadence, clearly not the 1 s default (~1 s) or 5 s.
    expect(medianGap).toBeGreaterThan(1.5);
    expect(medianGap).toBeLessThan(2.5);
  });

  it("range export re-conforms only in-range audio after cache invalidation", async function () {
    // Two distinct audio-only sources: A in the export range, B outside it.
    // Deleting both VCONF files while the store still carries conform_path
    // reproduces the stale-cache shape (e.g. a cleared Cache dir). The
    // export's audio gate must detect A's invalid cache (cached_ok, not the
    // store path), re-conform it, and hold the export until it lands; it must
    // NOT touch B — the Rust mix plan window-skips layers the export never
    // reads, where it previously hard-errored ConformMissing project-wide.
    const WAV = path.resolve(MEDIA_DIR, "test_tones_10s.wav");
    const MP3 = path.resolve(MEDIA_DIR, "test_tones_10s.mp3");
    if (!existsSync(WAV) || !existsSync(MP3)) {
      console.warn(`[e2e] SKIP: tone fixtures not found under ${MEDIA_DIR}`);
      this.skip();
    }
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-range-conform.mp4");
    rmSync(output, { force: true });

    await bootProject("e2e-range-conform-");

    const place = async (mediaAbsPath, tStartUs) => {
      const r = await browser.executeAsync((p, t, done) => {
        window.__weftcutTest
          .importAndPlaceMedia({ mediaAbsPath: p, tStartUs: t })
          .then((x) => done({ ok: true, ...x }))
          .catch((e) => done({ ok: false, error: String(e) }));
      }, mediaAbsPath, tStartUs);
      if (!r.ok) throw new Error(`importAndPlaceMedia failed: ${r.error}`);
      expect(r.kind).toBe("Audio");
      return r.mediaId;
    };
    const inRangeId = await place(WAV, 0);
    const outOfRangeId = await place(MP3, 12_000_000);

    // Import-time conform jobs land for both.
    await browser.waitUntil(
      async () =>
        await browser.execute(
          (a, b) =>
            window.__weftcutTest.mediaConformPath({ mediaId: a }) != null &&
            window.__weftcutTest.mediaConformPath({ mediaId: b }) != null,
          inRangeId,
          outOfRangeId,
        ),
      { timeout: 60000, timeoutMsg: "import-time conform never landed" },
    );
    const conformOf = (id) =>
      browser.execute(
        (m) => window.__weftcutTest.mediaConformPath({ mediaId: m }),
        id,
      );
    const inRangeConform = await conformOf(inRangeId);
    const outOfRangeConform = await conformOf(outOfRangeId);

    // Invalidate BOTH caches on disk; the store still says "conformed".
    // Retried: a preview Range read can hold the file open for a moment.
    const rmWithRetry = async (file) => {
      for (let i = 0; ; i++) {
        try {
          rmSync(file, { force: true });
          return;
        } catch (e) {
          if (i >= 20) throw e;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    };
    await rmWithRetry(inRangeConform);
    await rmWithRetry(outOfRangeConform);
    expect(existsSync(inRangeConform)).toBe(false);
    expect(existsSync(outOfRangeConform)).toBe(false);

    // Range export [0, 2s) — covers only A.
    await browser.execute(
      (out, rng) => {
        window.__e2eExportDone = null;
        window.__weftcutTest
          .exportTimeline({ outputAbsPath: out, range: rng })
          .then(() => { window.__e2eExportDone = { ok: true }; })
          .catch((e) => { window.__e2eExportDone = { ok: false, error: String(e) }; });
      },
      output,
      { startUs: 0, endUs: 2_000_000 },
    );
    await waitExportSettled();

    // The gate re-conformed the in-range media (regenerated at the same
    // hash-keyed path); the out-of-range media stayed untouched.
    expect(existsSync(inRangeConform)).toBe(true);
    expect(existsSync(outOfRangeConform)).toBe(false);

    // And the audio really rendered from the regenerated conform — the WAV's
    // per-second tone markers (F_k = 400 + 120k Hz) survive into the output.
    const pcm = extractPcm(output);
    const cands = [toneHz(0), toneHz(1), toneHz(2)];
    expect(dominantTone(pcm, 0, cands)).toBe(toneHz(0));
    expect(dominantTone(pcm, 1, cands)).toBe(toneHz(1));
  });

  it("software encoder export stays frame-aligned with low loss", async function () {
    // hwAccel:"software" forces the WebCodecs prefer-software H.264 path (the
    // default codec). Assert it actually works in real WebView2 and the output
    // stays frame-aligned + faithful (video SSIM) — i.e. the software path is
    // wired and doesn't break frames/color. Uses the burned-in-counter video
    // fixture so the conformance analyzer can align frames.
    if (!existsSync(VIDEO_SOURCE)) {
      console.warn(`[e2e] SKIP: video source not found at ${VIDEO_SOURCE}`);
      this.skip();
    }
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-sw.mp4");
    rmSync(output, { force: true });

    await bootAndExport({ output, source: VIDEO_SOURCE, settings: { hwAccel: "software" } });

    const SSIM_FLOOR = 0.8;
    const report = analyze({
      output,
      source: VIDEO_SOURCE,
      samples: [30, 150, 270],
      ssimMin: SSIM_FLOOR,
    });
    console.log("[e2e] software-encode report:", JSON.stringify(report));
    const misaligned = report.samples.filter((s) => !s.aligned);
    expect(misaligned).toHaveLength(0);
    const lowSsim = report.samples.filter((s) => s.ssim < SSIM_FLOOR);
    expect(lowSsim).toHaveLength(0);
    expect(report.pass).toBe(true);
  });
});
