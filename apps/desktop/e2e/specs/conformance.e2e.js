import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { analyze } from "../lib/analyze.mjs";

const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA || "C:/Users/iClass/Desktop/learning/testfile";
const SOURCE = path.resolve(MEDIA_DIR, "test_1080p_30fps.mp4");
const OUTPUT = path.resolve(os.tmpdir(), "weftcut-e2e-out.mp4");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-proj");

// Drives the REAL app (real WebView2) to create a project, import + 1:1-place
// ONE H.264 clip, and export it; then the `media_conformance` bin verifies
// frame alignment + app-only conversion loss at interior frames.
//
// STILL SKIPPED — but a layer deeper than before. This test surfaced the
// long-GOP DirectExport hang. ROUND 1 (FIXED + verified): a chunk needing
// frames far past a GOP key re-decoded from the key, exhausting the WebCodecs
// VideoFrame pool while the encode loop was parked in `waitForPts` → deadlock
// frozen at frame 250. Fixed by `ExportFrameStore.freeBehindWaiters` + the
// `waitForPts` kick (unit-covered in ExportFrameStore.test.ts) — the export now
// advances 250 → ~299 (verified via the worker-diag run).
// ROUND 2 (STILL OPEN): the export then hangs at the LAST frame — the source's
// trailing B-frames sit in the decoder's reorder buffer, which the chunked
// `decodeRange` never `flush()`es ("no flush between ranges"), so frames
// ~286..299 are never emitted. Needs an end-of-stream flush that (a) only runs
// with a pending waiter so `freeBehindWaiters` keeps the pool bounded, and
// (b) accounts for WebCodecs flush-then-continue semantics. Separately, the
// re-seek-every-chunk dispatch redundantly re-decodes the whole GOP (queue grew
// to ~1052) — a perf follow-up. Un-skip once the trailing-frame flush lands.
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
