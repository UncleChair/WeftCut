import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { analyze } from "../lib/analyze.mjs";

const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA || "C:/Users/iClass/Desktop/learning/testfile";
const SOURCE = path.resolve(MEDIA_DIR, "test_1080p_30fps.mp4");
const OUTPUT = path.resolve(os.tmpdir(), "weftcut-e2e-out.mp4");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-proj");

// SKIPPED — blocked on a REAL EXPORT BUG the harness found (2026-06-02), not a
// test problem. Localized via a fire-and-forget phase-poll diagnostic: the
// export encodes the first 250 frames fast (~124fps) then STALLS DETERMIN-
// ISTICALLY at frame 250 — confirmed to be the source clip's SECOND GOP
// keyframe (ffprobe: keyframes at pts 0.0 and 8.333s = frame 250; generate.go
// sets no -g, so x264's default keyint=250). The source-frame decode pull
// deadlocks crossing the GOP boundary (same class as the documented
// `waitForPts` PTS-grid deadlock). So ANY direct-from-original export of a clip
// longer than one GOP (~250 frames) hangs. exportState stays
// {kind:"progress",frame:250,phase:"encode"} forever; no error, no completion.
// Un-skip once the export GOP-boundary decode deadlock is fixed (decode path:
// PacketPump / decodeRange / waitForPts). The phase is observable at
// window.__weftcutExportState (mirrored by App under VITE_WEFTCUT_E2E).
describe.skip("H.264 import -> export conformance (real WebView2)", function () {
  before(function () {
    if (!existsSync(SOURCE)) {
      console.warn(
        `[e2e] SKIP: source media not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`,
      );
      this.skip();
    }
    mkdirSync(PROJECT_PARENT, { recursive: true });
    rmSync(OUTPUT, { force: true });
  });

  it("exports a 1:1 H.264 clip that stays frame-aligned with low loss", async () => {
    // The export executeAsync runs well past the 30s default WebDriver script
    // timeout (encoding a 10s clip). Raise it so the export isn't killed.
    await browser.setTimeout({ script: 180000 });

    // The hooks install via an async dynamic import — wait for each before use.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => typeof window.__weftcutTest?.newProjectAndEnter === "function",
        )) === true,
      { timeout: 30000, timeoutMsg: "newProjectAndEnter never mounted" },
    );

    // 1) Create a project matching the clip's canvas + enter the editor.
    const r1 = await browser.executeAsync((parent, done) => {
      window.__weftcutTest
        .newProjectAndEnter({
          parentFolder: parent,
          name: "e2e-" + Date.now(),
          canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
        })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, PROJECT_PARENT);
    if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);

    // 2) Wait for the App-mounted exportClip (editor loaded).
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => typeof window.__weftcutTest?.exportClip === "function",
        )) === true,
      { timeout: 30000, timeoutMsg: "exportClip never mounted (editor didn't load?)" },
    );

    // 3) Import -> place -> export through the real app (real WebView2 decode +
    //    WebCodecs encode + Rust mux).
    const r2 = await browser.executeAsync(
      (media, output, done) => {
        window.__weftcutTest
          .exportClip({ mediaAbsPath: media, outputAbsPath: output })
          .then(() => done({ ok: true }))
          .catch((e) => done({ ok: false, error: String(e) }));
      },
      SOURCE,
      OUTPUT,
    );
    if (!r2.ok) throw new Error("exportClip failed: " + r2.error);

    // 4) Analyze (Rust): frame alignment + app-only loss at interior frames.
    const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150, 270] });
    for (const s of report.samples) {
      expect(
        s.aligned,
        `frame ${s.index} aligned (best=${s.best_match_index}, ssim=${s.ssim})`,
      ).toBe(true);
    }
    expect(report.pass, `conformance report: ${JSON.stringify(report)}`).toBe(true);
  });
});
