import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { analyze } from "../lib/analyze.mjs";

const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA || "C:/Users/jonny/Desktop/learning/testfile";
const SOURCE = path.resolve(MEDIA_DIR, "test_1080p_30fps_audio.mp4");
const OUTPUT = path.resolve(os.tmpdir(), "weftcut-e2e-audio-out.mp4");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-audio-proj");

// Audio conformance: import + 1:1-place a clip whose audio is a per-second
// frequency-stepped tone (F_k = 400 + 120k Hz), export (video=WebCodecs,
// audio=Rust ffmpeg->AAC, then mux), and verify per-second alignment + A/V sync
// drift + tone fidelity via `media_conformance --audio`. Independent of the
// video axis (its own fixture + spec). describe.skip until first-run validated.
describe.skip("audio import -> export conformance (real WebView2)", function () {
  before(function () {
    if (!existsSync(SOURCE)) {
      console.warn(`[e2e] SKIP: audio source not found at ${SOURCE}`);
      this.skip();
    }
    mkdirSync(PROJECT_PARENT, { recursive: true });
    rmSync(OUTPUT, { force: true });
  });

  it("exports audio that stays aligned + synced + faithful", async () => {
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
          name: "e2e-audio-" + Date.now(),
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
      (media, output) => {
        window.__e2eExportDone = null;
        window.__weftcutTest
          .exportClip({ mediaAbsPath: media, outputAbsPath: output })
          .then(() => { window.__e2eExportDone = { ok: true }; })
          .catch((e) => { window.__e2eExportDone = { ok: false, error: String(e) }; });
      },
      SOURCE,
      OUTPUT,
    );

    let lastFrame = -1;
    let settled = null;
    try {
      await browser.waitUntil(
        async () => {
          const snap = await browser.execute(() => {
            const st = window.__weftcutExportState;
            return { done: window.__e2eExportDone, kind: st?.kind ?? null, frame: st?.progress?.frame ?? null };
          });
          if (snap.frame != null && snap.frame !== lastFrame) {
            lastFrame = snap.frame;
            console.log(`[e2e] audio export ${snap.kind} frame=${snap.frame}`);
          }
          if (snap.done) { settled = snap.done; return true; }
          return false;
        },
        { timeout: 170000, interval: 1000 },
      );
    } catch (e) {
      throw new Error(`export never settled (last frame=${lastFrame}): ${e.message}`);
    }
    if (!settled.ok) throw new Error("exportClip failed: " + settled.error);

    const report = analyze({ output: OUTPUT, source: SOURCE, samples: [0], audio: true });
    console.log("[e2e] audio report:", JSON.stringify(report));

    const misaligned = report.samples.filter((s) => !s.aligned);
    if (misaligned.length > 0) {
      throw new Error("audio seconds misaligned: " +
        JSON.stringify(misaligned.map((s) => ({ second: s.second, detected: s.detected_freq }))));
    }
    expect(Math.abs(report.drift_slope - 1)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(report.offset_ms)).toBeLessThanOrEqual(66);
    expect(report.pass).toBe(true);
  });
});
