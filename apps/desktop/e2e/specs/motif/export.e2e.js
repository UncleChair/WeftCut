import { existsSync, rmSync } from "node:fs";
import { analyzeSelf } from "../../lib/analyze.mjs";
import { newProject } from "../../helpers/app.mjs";
import { driveExport } from "../../helpers/export.mjs";
import { tmpOut, tmpProjectParent } from "../../helpers/media.mjs";

const OUTPUT = tmpOut("weftcut-e2e-motif-out.mp4");
const PROJECT_PARENT = tmpProjectParent("weftcut-e2e-motif-proj");

// Drives the REAL app (real WebView2) to create a motif-only project (a
// `countdown` Motif layer, no video clip) and export it, then verifies the
// motif ANIMATES in the exported file.
//
// This is the gate for "motifs render in EXPORT". Motifs were SILENTLY
// ABSENT in export before: the export Worker has no DOM, so the SVG capture
// harness threw (caught + logged), the texture stayed EMPTY, and the motif
// never reached the stage → a static black frame. The fix bakes each Motif
// layer's frames on the MAIN thread (`exportBake.ts`), transfers them into the
// Worker, and `MotifSprite` binds them by comp-frame index.
//
// Assertion: two output frames in DIFFERENT seconds DIFFER (self-SSIM well
// below 1.0). The countdown's numeral changes at 1-second boundaries and its
// progress arc sweeps every frame, so an animating motif makes the frames
// differ; a skipped motif (static black) would make them near-identical
// (ssim ~1.0) and fail. Frames-differ is both reliable (no OCR) and a strictly
// stronger proof than "visible/non-blank".
describe("motif renders + animates in export (real WebView2)", function () {
  before(function () {
    rmSync(OUTPUT, { force: true });
  });

  it("exports a countdown motif whose frames differ across seconds", async () => {
    // 1) Create a 480x480 @ 30fps project and enter the editor. Matching the
    //    countdown's native size (480x480) makes the motif FILL the frame,
    //    so a differing pair scores far below the 0.99 threshold (~0.6-0.8) and
    //    the differ/static gate has a wide margin. A larger canvas would let a
    //    big static-black border dilute the global MSSIM toward 1.0, making the
    //    test flaky against encoder/GPU noise.
    await newProject({
      parentFolder: PROJECT_PARENT,
      name: "e2e-tmpl-" + Date.now(),
      canvas: { width: 480, height: 480, fpsNum: 30, fpsDen: 1 },
    });

    // 2) Add a 2s countdown motif (60 frames @ 30fps) and export it.
    //    driveExport waits for the exportMotifClip hook, fires-and-forgets, then
    //    polls the live phase/frame counter for hang diagnostics (same pattern as
    //    conformance.e2e.js). Phase passes through preparing (the motif bake) →
    //    progress (encode) → complete.
    const r = await driveExport(
      {
        motifId: "countdown",
        outputAbsPath: OUTPUT,
        durationUs: 2_000_000,
      },
      { hook: "exportMotifClip", label: "motif" },
    );
    if (!r.done.ok) throw new Error("exportMotifClip failed: " + r.done.error);

    if (!existsSync(OUTPUT)) throw new Error(`no output written at ${OUTPUT}`);

    // 3) Self-SSIM (Rust): two output frames in DIFFERENT seconds must differ.
    //    frame 10 ≈ 0.33s (numeral 2), frame 50 ≈ 1.67s (numeral 1): the numeral
    //    AND the swept arc both change. Threshold 0.99: a static black skipped
    //    motif would score ~1.0; the animated motif scores far lower.
    const report = analyzeSelf({ output: OUTPUT, samples: [10, 50], ssimMax: 0.99 });
    console.log("[e2e] motif self-ssim report:", JSON.stringify(report));

    const pair = report.pairs[0];
    if (!pair) throw new Error("no self-ssim pair returned: " + JSON.stringify(report));
    if (!pair.differ) {
      throw new Error(
        `motif frames did NOT differ (ssim ${pair.ssim.toFixed(4)} >= 0.99) — ` +
          `the motif likely rendered static/black (skipped) in export`,
      );
    }
    expect(report.pass).toBe(true);
  });
});
