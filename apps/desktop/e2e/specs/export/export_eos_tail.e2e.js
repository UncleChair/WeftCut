import { existsSync, mkdirSync, rmSync } from "node:fs";
import { analyze } from "../../lib/analyze.mjs";
import { newProject } from "../../helpers/app.mjs";
import { driveExport } from "../../helpers/export.mjs";
import { fixture, tmpOut, tmpProjectParent } from "../../helpers/media.mjs";

const SOURCE = fixture("test_1080p_30fps_eostail.mp4");
const OUTPUT = tmpOut("weftcut-e2e-eostail-out.mp4");
const PROJECT_PARENT = tmpProjectParent("weftcut-e2e-eostail-proj");

// Export EOS-tail gate. The plain conformance fixture can never catch the
// end-of-stream deadlock class: its x264-default GOPs put the last keyframe
// ~50 frames before the end, so EOS lands inside the FINAL 60-frame chunk and
// the drain finishes while that chunk consumes. This fixture is built so the
// tail is adversarial in BOTH ways the class needs (see generate.go --eostail):
//
//   - Keys at 0s and 5s ONLY (-g 150, scenecut off). The chunk covering
//     [4s..6s) dispatches looking for a key past 6s, finds none, and runs to
//     true EOS at 10s — so the decoder's reorder tail (frames 6s..10s, two
//     full chunks) must drain across chunk boundaries while later chunks skip
//     dispatch. Pre-fix, the next chunk's decodeRange awaited the pool-stalled
//     flush before the consumer loop ran → circular wait, export frozen at
//     frame 180 (the user-repro shape frozen at 12660/12731).
//
//   - The tone track runs 11s against the video's 10s. Media duration is the
//     ffprobe max across streams, so the placed clip + composition are 11s =
//     330 frames and output frames 300..329 map PAST the final video frame.
//     Pre-fix, once the drain completed (or per-frame eviction emptied the
//     ring) those waits could never resolve → frozen at ~99%. Post-fix the
//     ring finalizes at flush completion and clamps them to the held last
//     frame (hold-last).
//
// The gate: the export COMPLETES (the deadlocks pinned the polled frame
// counter), reports the audio-extended 330-frame plan, and the drained tail
// region stays frame-aligned with the source (no dup/drop from the drain).
describe("EOS-tail export (final GOP spans chunks + audio overhang, real WebView2)", function () {
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

  it("completes the export and keeps the drained tail frame-aligned", async () => {
    await newProject({
      parentFolder: PROJECT_PARENT,
      name: "e2e-eostail-" + Date.now(),
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    });

    // Fire-and-forget export; poll the mirrored frame counter so a regression
    // hang reports its exact stall frame (the EOS deadlock class pins it at a
    // chunk boundary — frame 180 here — instead of timing out blind).
    const r = await driveExport(
      { mediaAbsPath: SOURCE, outputAbsPath: OUTPUT },
      { label: "export_eos_tail" },
    );
    if (!r.done.ok) throw new Error("exportClip failed: " + r.done.error);

    // The audio overhang must have armed: an 11s composition at 30fps plans
    // 330 output frames (300 video + 30 clamp-held). 300 here would mean the
    // fixture's geometry silently stopped covering the overhang wedge.
    const perf = await browser.execute(() => window.__weftcutExportPerf ?? null);
    if (perf) {
      const ratio = (perf.totalDispatched / Math.max(1, perf.totalFrames)).toFixed(2);
      console.log(
        `[e2e] export perf: dispatched=${perf.totalDispatched} for ${perf.totalFrames} frames ` +
          `(${ratio}x) | decode=${perf.decodeMs}ms wait=${perf.waitMs}ms total=${perf.totalMs}ms`,
      );
      if (perf.totalFrames !== 330) {
        throw new Error(
          `expected 330 planned frames (11s audio-extended composition), got ${perf.totalFrames}`,
        );
      }
    }

    // Alignment gate. Samples 200 + 270 sit INSIDE the EOS drain region
    // (frames 180..299 arrive via the floated flush, not normal dispatch) —
    // they prove drained frames land on the right output indices, not as
    // dups/drops. Keep samples below 300: the clamp-held overhang frames are
    // last-frame dups BY DESIGN and would "misalign" against the source.
    const SSIM_FLOOR = 0.8;
    const report = analyze({
      output: OUTPUT,
      source: SOURCE,
      samples: [30, 150, 200, 270],
      ssimMin: SSIM_FLOOR,
    });
    console.log("[e2e] eos-tail conformance report:", JSON.stringify(report));

    const misaligned = report.samples.filter((s) => !s.aligned);
    if (misaligned.length > 0) {
      throw new Error(
        "frames not aligned: " +
          JSON.stringify(
            misaligned.map((s) => ({ index: s.index, best: s.best_match_index, ssim: s.ssim })),
          ),
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
