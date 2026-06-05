import os from "node:os";
import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import { analyzeSelf } from "../lib/analyze.mjs";

const OUTPUT = path.resolve(os.tmpdir(), "weftcut-e2e-template-out.mp4");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-template-proj");

// Drives the REAL app (real WebView2) to create a template-only project (a
// `countdown` Template layer, no video clip) and export it, then verifies the
// template ANIMATES in the exported file.
//
// This is the gate for "templates render in EXPORT". Templates were SILENTLY
// ABSENT in export before: the export Worker has no DOM, so the SVG capture
// harness threw (caught + logged), the texture stayed EMPTY, and the template
// never reached the stage → a static black frame. The fix bakes each Template
// layer's frames on the MAIN thread (`exportBake.ts`), transfers them into the
// Worker, and `TemplateSprite` binds them by comp-frame index.
//
// Assertion: two output frames in DIFFERENT seconds DIFFER (self-SSIM well
// below 1.0). The countdown's numeral changes at 1-second boundaries and its
// progress arc sweeps every frame, so an animating template makes the frames
// differ; a skipped template (static black) would make them near-identical
// (ssim ~1.0) and fail. Frames-differ is both reliable (no OCR) and a strictly
// stronger proof than "visible/non-blank".
describe("template renders + animates in export (real WebView2)", function () {
  before(function () {
    rmSync(OUTPUT, { force: true });
  });

  it("exports a countdown template whose frames differ across seconds", async () => {
    // Hooks install via async dynamic import — wait for each before use.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => typeof window.__weftcutTest?.newProjectAndEnter === "function",
        )) === true,
      { timeout: 30000, timeoutMsg: "newProjectAndEnter never mounted" },
    );

    // 1) Create a 1920x1080 @ 30fps project and enter the editor.
    const r1 = await browser.executeAsync((parent, done) => {
      window.__weftcutTest
        .newProjectAndEnter({
          parentFolder: parent,
          name: "e2e-tmpl-" + Date.now(),
          canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
        })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, PROJECT_PARENT);
    if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);

    // 2) Wait for the App-mounted exportTemplateClip (editor loaded).
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => typeof window.__weftcutTest?.exportTemplateClip === "function",
        )) === true,
      { timeout: 30000, timeoutMsg: "exportTemplateClip never mounted (editor didn't load?)" },
    );

    // 3) Add a 2s countdown template (60 frames @ 30fps) and export it, FIRE-
    //    AND-FORGET so we can poll the live phase/frame counter for hang
    //    diagnostics (same pattern as conformance.e2e.js).
    await browser.execute((output) => {
      window.__e2eTemplateDone = null;
      window.__weftcutTest
        .exportTemplateClip({
          templateId: "countdown",
          outputAbsPath: output,
          durationUs: 2_000_000,
        })
        .then(() => {
          window.__e2eTemplateDone = { ok: true };
        })
        .catch((e) => {
          window.__e2eTemplateDone = { ok: false, error: String(e) };
        });
    }, OUTPUT);

    // 4) Poll until settled. The phase passes through preparing (the template
    //    bake) → progress (encode) → complete; logging each advance turns a
    //    regression into "stalled at frame N" rather than a blind timeout.
    let lastFrame = -1;
    let lastKind = null;
    let settled = null;
    try {
      await browser.waitUntil(
        async () => {
          const snap = await browser.execute(() => {
            const st = window.__weftcutExportState;
            return {
              done: window.__e2eTemplateDone,
              kind: st?.kind ?? null,
              phase: st?.progress?.phase ?? null,
              frame: st?.progress?.frame ?? null,
            };
          });
          if (snap.frame != null && snap.frame !== lastFrame) {
            lastFrame = snap.frame;
            console.log(
              `[e2e] template export ${snap.kind}/${snap.phase ?? "-"} frame=${snap.frame}`,
            );
          }
          if (snap.kind && snap.kind !== lastKind) {
            lastKind = snap.kind;
            console.log(`[e2e] template export phase -> ${snap.kind}`);
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
        `template export never settled (last kind=${lastKind}, last frame=${lastFrame}): ${e.message}`,
      );
    }
    if (!settled.ok) throw new Error("exportTemplateClip failed: " + settled.error);

    if (!existsSync(OUTPUT)) throw new Error(`no output written at ${OUTPUT}`);

    // 5) Self-SSIM (Rust): two output frames in DIFFERENT seconds must differ.
    //    frame 10 ≈ 0.33s (numeral 2), frame 50 ≈ 1.67s (numeral 1): the numeral
    //    AND the swept arc both change. Threshold 0.99: a static black skipped
    //    template would score ~1.0; the animated template scores far lower.
    const report = analyzeSelf({ output: OUTPUT, samples: [10, 50], ssimMax: 0.99 });
    console.log("[e2e] template self-ssim report:", JSON.stringify(report));

    const pair = report.pairs[0];
    if (!pair) throw new Error("no self-ssim pair returned: " + JSON.stringify(report));
    if (!pair.differ) {
      throw new Error(
        `template frames did NOT differ (ssim ${pair.ssim.toFixed(4)} >= 0.99) — ` +
          `the template likely rendered static/black (skipped) in export`,
      );
    }
    expect(report.pass).toBe(true);
  });
});
