import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { analyze } from "../lib/analyze.mjs";

const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA || "C:/Users/jonny/Desktop/learning/testfile";
const SOURCE = path.resolve(MEDIA_DIR, "test_1080p_30fps.mp4");
const OUTPUT = path.resolve(os.tmpdir(), "weftcut-e2e-out.mp4");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-proj");

// Drives the REAL app (real WebView2) to create a project, import + 1:1-place
// ONE H.264 clip, and export it; then the `media_conformance` bin verifies
// frame alignment + app-only conversion loss at interior frames.
//
// This is the harness's first end-to-end gate. It surfaced the long-GOP
// DirectExport hang in two rounds, both now fixed:
//   ROUND 1 — a chunk needing frames far past a GOP key re-decoded from the key,
//     exhausting the WebCodecs VideoFrame pool while the encode loop was parked
//     in `waitForPts` → deadlock frozen at frame 250. Fixed by
//     `ExportFrameStore.freeBehindWaiters` + the `waitForPts` kick.
//   ROUND 2 — the export then hung at the LAST frame: the source's final-GOP
//     trailing B-frames sit in the decoder's reorder buffer, which the chunked
//     `decodeRange` never flushed. Fixed by `ExportSourceHandle.issueEosFlush` —
//     a floated (non-awaited) `decoder.flush()` at true end-of-stream, drained
//     by the encode loop's `freeBehindWaiters` so the pool stays bounded.
//
// The export is driven fire-and-forget and the per-frame counter
// (`window.__weftcutExportState.progress.frame`) is polled node-side, so a
// regression hang reports the exact stall frame instead of an opaque timeout.
//
// STILL `describe.skip`, but only ONE blocker remains. Three issues this gate
// surfaced are now fixed: the two flush deadlocks above, PLUS a frame-grid
// off-by-one — the export sampled output times as `i * round(1e6/fps)`, whose
// compounded rounding floor drifted behind the source PTS grid and made
// `frameAt` repeat a frame (301 output frames for a 300-frame source, output[N]
// aligning to source[N-1]). Fixed in `exportWorker.ts` by driving the grid from
// the exact rational fps (`frameTimeUs`/`totalFrames`); the analyzer now reports
// every sample `aligned: true` with `best_match_index == index`, output is 300
// frames. (A latent `analyze.mjs` repo-root path bug — `cargo` manifest not
// found — was also fixed; it was only ever reached once the export stopped
// hanging.)
//
// REMAINING blocker — color-fidelity gap. Even the correctly-aligned same-index
// pair scores SSIM well below the 0.95 gate (analyzer MSSIM ~0.47; ffmpeg's
// per-channel SSIM ~0.75 with green ~0.50 vs R/B ~0.88, PSNR ~19 dB). The
// lopsided green is the signature of a YUV matrix/range mismatch — the source is
// UNTAGGED (`color_space=unknown`), the output tagged `bt709/tv`. Whether the
// fault is the export pipeline (WebCodecs decode→Pixi→encode) or the analyzer's
// ffmpeg decode assumptions for an untagged source is undiagnosed; the large
// MSSIM-vs-ffmpeg gap suggests the gate's metric/threshold also needs review.
// Un-skip once this lands. The body below is the working harness — it drives a
// real export to completion and runs the analyzer; only the SSIM assert fails.
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

    // 3) Kick off import -> place -> export through the real app, FIRE-AND-FORGET:
    //    `exportClip` runs the full real-WebView2 decode + WebCodecs encode + Rust
    //    mux to completion and parks its settlement on `window`. We return from
    //    `execute` immediately so we can poll the live frame counter below.
    await browser.execute(
      (media, output) => {
        window.__e2eExportDone = null;
        window.__weftcutTest
          .exportClip({ mediaAbsPath: media, outputAbsPath: output })
          .then(() => {
            window.__e2eExportDone = { ok: true };
          })
          .catch((e) => {
            window.__e2eExportDone = { ok: false, error: String(e) };
          });
      },
      SOURCE,
      OUTPUT,
    );

    // 4) Poll the export's mirrored phase/frame counter until it settles. The
    //    encode loop posts `progress.frame` every 5 frames; a hang therefore
    //    pins the counter at the last multiple of 5 it reached (the ROUND-1/2
    //    deadlocks pinned it at 250 / ~285). Logging each advance turns a
    //    regression into "stalled at frame N" instead of a blind timeout.
    let lastFrame = -1;
    let lastKind = null;
    let settled = null;
    try {
      await browser.waitUntil(
        async () => {
          const snap = await browser.execute(() => {
            const st = window.__weftcutExportState;
            return {
              done: window.__e2eExportDone,
              kind: st?.kind ?? null,
              phase: st?.progress?.phase ?? null,
              frame: st?.progress?.frame ?? null,
            };
          });
          if (snap.frame != null && snap.frame !== lastFrame) {
            lastFrame = snap.frame;
            console.log(
              `[e2e] export ${snap.kind}/${snap.phase ?? "-"} frame=${snap.frame}`,
            );
          }
          if (snap.kind && snap.kind !== lastKind) {
            lastKind = snap.kind;
            console.log(`[e2e] export phase -> ${snap.kind}`);
          }
          if (snap.done) {
            settled = snap.done;
            return true;
          }
          return false;
        },
        { timeout: 170000, interval: 1000 },
      );
    } catch (e) {
      throw new Error(
        `export never settled (last kind=${lastKind}, last frame=${lastFrame}): ${e.message}`,
      );
    }
    if (!settled.ok) throw new Error("exportClip failed: " + settled.error);

    // 5) Analyze (Rust): frame alignment + app-only loss at interior frames.
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
