import { existsSync, mkdirSync, rmSync } from "node:fs";
import { analyze } from "../../lib/analyze.mjs";
import { newProject } from "../../helpers/app.mjs";
import { driveExport } from "../../helpers/export.mjs";
import { fixture, tmpOut, tmpProjectParent } from "../../helpers/media.mjs";

const SOURCE = fixture("test_1080p_30fps.mp4");
const OUTPUT = tmpOut("weftcut-e2e-out.mp4");
const PROJECT_PARENT = tmpProjectParent("weftcut-e2e-proj");

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
// Now ACTIVE. Beyond the two flush deadlocks, this gate surfaced two more
// issues, both fixed:
//   - FRAME-GRID off-by-one: the export sampled output times as `i*round(1e6/
//     fps)`, whose compounded rounding floor drifted behind the source PTS grid
//     and made `frameAt` repeat a frame (301 frames for 300, output[N]=source
//     [N-1]). Fixed by driving the grid from the exact rational fps
//     (`frameGrid.ts`). (A latent `analyze.mjs` repo-root path bug was fixed too
//     — only reachable once the export stopped hanging.)
//   - COLOR: the fixture was an UNTAGGED BT.601 clip; WeftCut decoded it 709
//     (WebView2's HD default) while ffmpeg read it 601 → a 601/709 mismatch
//     (MSSIM ~0.47). NOT a pipeline bug — the export is internally 709-consistent
//     and respects source tags. Fixed on two fronts: the fixture now emits TRUE
//     709 (generate.go), and untagged sources get a resolution-keyed default
//     matrix on decode (`colorSpaceDefault.ts`, both pools).
// With those, every sample aligns and a faithful export scores ~0.85 MSSIM
// (flat regions pixel-exact; the residual is testsrc2's sharp/saturated content
// through 4:2:0 + a re-encode). The gate is therefore STRICT on alignment +
// a loose 0.80 SSIM floor (see the asserts).
describe("H.264 import -> export conformance (real WebView2)", function () {
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
    // 1) Create a project matching the clip's canvas + enter the editor.
    await newProject({
      parentFolder: PROJECT_PARENT,
      name: "e2e-" + Date.now(),
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    });

    // 2) Kick off import -> place -> export through the real app.
    const r = await driveExport(
      { mediaAbsPath: SOURCE, outputAbsPath: OUTPUT },
      { label: "conformance" },
    );
    if (!r.done.ok) throw new Error("exportClip failed: " + r.done.error);

    // Perf diagnostic (re-seek redundancy): totalDispatched ≫ totalFrames means
    // the source decoder re-decoded packets (the long-GOP re-seek issue).
    const perf = await browser.execute(() => window.__weftcutExportPerf ?? null);
    if (perf) {
      const ratio = (perf.totalDispatched / Math.max(1, perf.totalFrames)).toFixed(2);
      console.log(
        `[e2e] export perf: dispatched=${perf.totalDispatched} for ${perf.totalFrames} frames ` +
          `(${ratio}x) | decode=${perf.decodeMs}ms wait=${perf.waitMs}ms total=${perf.totalMs}ms`,
      );
    }

    // 3) Analyze (Rust): frame alignment + app-only loss at interior frames.
    // Gate STRICTLY on alignment (best == index) — that is the harness's core
    // value: it catches the frame drop/dup/misalignment class this whole effort
    // fixed. The SSIM floor is LOOSE (0.80): testsrc2's sharp, saturated bars +
    // burned-in text + diagonal rainbow, through 4:2:0 chroma and a
    // decode->composite->re-encode round-trip, cap a FAITHFUL export's MSSIM at
    // ~0.85 (flat regions are pixel-exact). The floor still catches gross
    // regressions — the pre-fix BT.601/709 color-matrix bug scored ~0.47.
    const SSIM_FLOOR = 0.8;
    const report = analyze({ output: OUTPUT, source: SOURCE, samples: [30, 150, 270], ssimMin: SSIM_FLOOR });
    console.log("[e2e] conformance report:", JSON.stringify(report));

    const misaligned = report.samples.filter((s) => !s.aligned);
    if (misaligned.length > 0) {
      throw new Error(
        "frames not aligned: " +
          JSON.stringify(misaligned.map((s) => ({ index: s.index, best: s.best_match_index, ssim: s.ssim }))),
      );
    }
    const lowSsim = report.samples.filter((s) => s.ssim < SSIM_FLOOR);
    if (lowSsim.length > 0) {
      throw new Error(
        `SSIM below ${SSIM_FLOOR}: ` +
          JSON.stringify(lowSsim.map((s) => ({ index: s.index, ssim: Number(s.ssim.toFixed(4)) }))),
      );
    }
    expect(report.pass).toBe(true);
  });
});
