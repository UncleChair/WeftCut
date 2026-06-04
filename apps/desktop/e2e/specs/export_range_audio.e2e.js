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

function toneHz(second) {
  return 400 + 120 * second;
}

/// Boot a fresh 30fps project, then drive `exportClip` and wait for it to
/// settle. Returns { settled, perf, lastKind, lastDetail }. `perf` is the
/// worker's `window.__weftcutExportPerf` (E2E-only), carrying `totalFrames`.
async function bootAndExport({ output, settings, range }) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => typeof window.__weftcutTest?.newProjectAndEnter === "function",
      )) === true,
    { timeout: 30000, timeoutMsg: "newProjectAndEnter never mounted" },
  );
  const r1 = await browser.executeAsync((parent, done) => {
    window.__weftcutTest
      .newProjectAndEnter({
        parentFolder: parent,
        name: "e2e-range-audio-" + Date.now(),
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      .then(() => done({ ok: true }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, PROJECT_PARENT);
  if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);

  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => typeof window.__weftcutTest?.exportClip === "function",
      )) === true,
    { timeout: 30000, timeoutMsg: "exportClip never mounted" },
  );

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
    SOURCE,
    output,
    settings ?? null,
    range ?? null,
  );

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
      { timeout: 170000, interval: 1000 },
    );
  } catch (e) {
    throw new Error(
      `export never settled (last frame=${lastFrame}, kind=${lastKind}, detail=${lastDetail}): ${e.message}`,
    );
  }
  if (!settled.ok) {
    throw new Error(
      `exportClip failed: ${settled.error} | exportState kind=${lastKind} detail=${lastDetail} (last frame=${lastFrame})`,
    );
  }
  const perf = await browser.execute(() => window.__weftcutExportPerf ?? null);
  return { settled, perf, lastKind, lastDetail };
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

    // Audio: each output second carries the In-shifted source tone.
    const report = analyze({ output, source: SOURCE, samples: [0], audio: true });
    console.log("[e2e] range audio report:", JSON.stringify(report));
    const s0 = report.samples.find((s) => s.second === 0);
    const s1 = report.samples.find((s) => s.second === 1);
    expect(s0).toBeDefined();
    expect(s1).toBeDefined();
    expect(Math.abs(s0.detected_freq - toneHz(1))).toBeLessThanOrEqual(40);
    expect(Math.abs(s1.detected_freq - toneHz(2))).toBeLessThanOrEqual(40);
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
});
