import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { analyzeAudioEnvelope, analyzeAudioPan } from "../lib/analyze.mjs";

// Audio-engine conformance (docs/audio.md §Testing): the deterministic Rust
// mixer upgrades audio assertions from perceptual (Goertzel tones) to
// ANALYTIC — windowed-RMS envelopes against closed-form expectations, the
// alimiter ceiling, and the equal-power pan law's L/R energy ratio.
//
// Keyframed-gain note: there is no keyframe IPC/hook surface to drive yet,
// so the keyframed-gain case is locked at the math level instead (the
// cross-language envelope goldens + `audio::mix` unit tests); the fade
// scenarios here exercise the same sampled-envelope pipeline end-to-end.
const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-audio-env-proj");

// The 30fps tone-marker fixture (shared with audio_conformance).
const SOURCE = path.resolve(MEDIA_DIR, "test_1080p_30fps_audio.mp4");

/// Boot a fresh 30fps project and run exportClip with audio patches.
async function bootAndExport({ output, audioPatches, settings }) {
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
        name: "e2e-audio-env-" + Date.now(),
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
    (media, out, patches, s) => {
      window.__e2eExportDone = null;
      const args = { mediaAbsPath: media, outputAbsPath: out };
      if (patches) args.audioPatches = patches;
      if (s) args.settings = s;
      window.__weftcutTest
        .exportClip(args)
        .then(() => { window.__e2eExportDone = { ok: true }; })
        .catch((e) => { window.__e2eExportDone = { ok: false, error: String(e) }; });
    },
    SOURCE,
    output,
    audioPatches ?? null,
    settings ?? null,
  );

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
          };
        });
        if (snap.kind != null) lastKind = snap.kind;
        if (snap.detail != null) lastDetail = snap.detail;
        if (snap.done) { settled = snap.done; return true; }
        return false;
      },
      { timeout: 170000, interval: 1000 },
    );
  } catch (e) {
    throw new Error(
      `export never settled (kind=${lastKind}, detail=${lastDetail}): ${e.message}`,
    );
  }
  if (!settled.ok) {
    throw new Error(
      `exportClip failed: ${settled.error} | exportState kind=${lastKind} detail=${lastDetail}`,
    );
  }
}

describe("audio envelope conformance (real WebView2)", function () {
  before(function () {
    if (!existsSync(SOURCE)) {
      console.warn(`[e2e] SKIP suite: source not found at ${SOURCE}`);
      this.skip();
    }
    mkdirSync(PROJECT_PARENT, { recursive: true });
  });

  it("fade-in shapes the exported RMS envelope analytically", async function () {
    // 1 s linear fade-in at unity gain: window RMS deltas vs the loudest
    // window are 20·log10(t) — −12.04 dB at 0.25 s, −6.02 at 0.5 s,
    // −2.50 at 0.75 s, 0 in the body. ±1.5 dB bound absorbs AAC + the
    // −1 dB limiter ceiling on a hot fixture.
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-fadein.mp4");
    rmSync(output, { force: true });

    await bootAndExport({
      output,
      audioPatches: [{ fade_in_us: 1_000_000 }],
    });

    const report = analyzeAudioEnvelope({
      output,
      expects: [
        { t_s: 0.25, expect_rms_db_delta: -12.04 },
        { t_s: 0.5, expect_rms_db_delta: -6.02 },
        { t_s: 0.75, expect_rms_db_delta: -2.5 },
        { t_s: 5.0, expect_rms_db_delta: 0.0 },
      ],
    });
    console.log("[e2e] fade-in envelope report:", JSON.stringify(report));
    expect(report.pass).toBe(true);
  });

  it("fade-out shapes the tail and static gain offsets the body", async function () {
    // −6 dB static gain + 1 s fade-out on a 10 s clip: the loudest window
    // is the body (the gain is uniform, so deltas are gain-independent);
    // the tail ramps down −6.02 dB at 9.5 s, −12.04 dB at 9.75 s.
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-fadeout.mp4");
    rmSync(output, { force: true });

    await bootAndExport({
      output,
      audioPatches: [{ gain_db: -6, fade_out_us: 1_000_000 }],
    });

    const report = analyzeAudioEnvelope({
      output,
      expects: [
        { t_s: 5.0, expect_rms_db_delta: 0.0 },
        { t_s: 9.5, expect_rms_db_delta: -6.02 },
        { t_s: 9.75, expect_rms_db_delta: -12.04 },
      ],
    });
    console.log("[e2e] fade-out envelope report:", JSON.stringify(report));
    expect(report.pass).toBe(true);
  });

  it("two overlapping layers sum and the limiter holds the -1 dB ceiling", async function () {
    // The same clip stacked twice (0 dB + −6 dB). Whatever the fixture's
    // own level, the summed peak must never exceed the alimiter ceiling
    // (−1 dB ≈ −0.9 dBFS with codec slop).
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-overlap.mp4");
    rmSync(output, { force: true });

    await bootAndExport({
      output,
      audioPatches: [{}, { gain_db: -6 }],
    });

    const report = analyzeAudioEnvelope({
      output,
      expects: [{ t_s: 5.0, expect_rms_db_delta: 0.0 }],
      peakMaxDb: -0.9,
    });
    console.log("[e2e] overlap+limiter report:", JSON.stringify(report));
    expect(report.peak_ceiling_pass).toBe(true);
    expect(report.pass).toBe(true);
  });

  it("pan -0.8 lands the equal-power L/R energy ratio", async function () {
    // Equal-power law with correlated channels collapses to
    // cot(x·π/2 / 2)… concretely for pan = −0.8: L−R = 20·log10(cot(0.05π))
    // ≈ +16.0 dB. (Mono and stereo inputs agree for identical-channel
    // content — the cross-bleed term makes the stereo law collapse to the
    // mono law's ratio.)
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-pan.mp4");
    rmSync(output, { force: true });

    await bootAndExport({
      output,
      audioPatches: [{ pan: -0.8 }],
    });

    const report = analyzeAudioPan({ output, expectLrDb: 16.0 });
    console.log("[e2e] pan report:", JSON.stringify(report));
    expect(report.pass).toBe(true);
  });
});
