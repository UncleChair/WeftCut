import os from "node:os";
import path from "node:path";

const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-motif-live-proj");

// Proves end-to-end, in the REAL app (real WebView2), that a `countdown`
// Template layer renders LIVE in the editor preview with its pixels coming
// from the Motif webcap CDP path — NOT the old SVG harness.
//
// The chain under test (all production code paths):
//   add_motif(countdown)  →  Compositor.compositeFrame  →  MotifSprite
//   →  (cache miss)  →  resolveTemplateFrame  →  rasterMotifFrame("countdown")
//   →  captureMotifFrame (Rust motif_capture_frame, CDP screenshot of the
//      hidden Motif host)  →  ImageBitmap  →  bound texture on the live stage.
//
// We add the countdown on a 480×480 canvas (its native size, transform
// default x=0/y=0/scale=1), seek the live preview to t=2.5 s, then read the
// composited canvas pixel at its center (240,240). At t=2.5 with duration 5 s
// the countdown shows the large centered numeral "3" in the accent color
// #ff4d4d = rgb(255,77,77). A high-red / low-green / low-blue opaque pixel
// there means the Motif CDP frame reached the live compositor.
//
// The `__weftcutTemplatePerf.renders` counter is incremented inside
// `rasterMotifFrame` (the CDP producer), so renders > 0 confirms frames came
// through the live producer rather than a stale cache or a no-op.
//
// Hooks used (apps/desktop/src/testhook/e2eHook.ts, all behind VITE_WEFTCUT_E2E):
//   window.__weftcutTest.newProjectAndEnter  (reused — bootstrap)
//   window.__weftcutTest.motifAddCountdown   (added — add_motif wrapper)
//   window.__weftcutTest.weftcutSeekUs        (added — engine.seek bridge)
//   window.__weftcutTest.weftcutSampleComposite (added — renderer.extract readback)

describe("motif live preview (CDP in compositor)", function () {
  it("a countdown layer renders accent-colored content in the live preview", async () => {
    // Hooks install via async dynamic import — wait for the bootstrap one.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => typeof window.__weftcutTest?.newProjectAndEnter === "function",
        )) === true,
      { timeout: 30000, timeoutMsg: "newProjectAndEnter never mounted" },
    );

    // 1) Create a 480×480 @ 30fps project (countdown native size → fills the
    //    frame, so the center pixel lands inside the numeral) and enter the
    //    editor (which mounts the Pixi preview + its e2e bridge).
    const r1 = await browser.executeAsync((parent, done) => {
      window.__weftcutTest
        .newProjectAndEnter({
          parentFolder: parent,
          name: "e2e-motif-live-" + Date.now(),
          canvas: { width: 480, height: 480, fpsNum: 30, fpsDen: 1 },
        })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, PROJECT_PARENT);
    if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);

    // 2) Wait for the preview bridge (registered when PixiPreview mounts in the
    //    editor) AND the motif hooks.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            typeof window.__weftcutTest?.motifAddCountdown === "function" &&
            typeof window.__weftcutTest?.weftcutSeekUs === "function" &&
            typeof window.__weftcutTest?.weftcutSampleComposite === "function",
        )) === true,
      { timeout: 30000, timeoutMsg: "motif live-preview hooks never mounted" },
    );

    // Reset the live render counter (incremented by the CDP producer).
    await browser.execute(() => {
      window.__weftcutTemplatePerf = { renders: 0 };
    });

    // 3) Add the countdown Template layer (5 s span at t=0) and confirm a
    //    layer id came back.
    const addRes = await browser.executeAsync((done) => {
      window.__weftcutTest
        .motifAddCountdown()
        .then((id) => done({ ok: true, id }))
        .catch((e) => done({ ok: false, error: String(e) }));
    });
    if (!addRes.ok) throw new Error("motifAddCountdown failed: " + addRes.error);
    expect(typeof addRes.id).toBe("string");
    expect(addRes.id.length).toBeGreaterThan(0);

    // 4) Seek the live preview to t=2.5 s (numeral "3"). The summary→compositor
    //    propagation after add_motif is async (project:changed bridge); give
    //    it a beat, then seek.
    await browser.pause(500);
    await browser.execute(() => window.__weftcutTest.weftcutSeekUs(2_500_000));

    // 5) Cold CDP capture (~11 fps single-Motif host) + the compositor's async
    //    bind path (resolveTemplateFrame → captureMotifFrame → onLoaded →
    //    scheduleRepaint) need a real settle window — genuine latency, not a
    //    smell. Poll the live composite until accent-colored content appears
    //    (or a hard deadline). Re-seek each poll so a stale paused frame can't
    //    starve the bind, and read renders so a failure is diagnosable.
    //
    //    We assert on `accentCount` (number of #ff4d4d opaque pixels across the
    //    whole composite) rather than one fixed pixel: the countdown's numeral
    //    "3" + progress arc are accent-colored, but the exact geometric center
    //    (240,240) falls in the "3"'s transparent hollow, so a single-point
    //    sample is glyph-geometry-fragile. The whole-frame accent count is the
    //    robust proof that accent-colored Motif pixels reached the live
    //    compositor. `(x,y)` passed to the hook is only the per-pixel readback;
    //    the scan it performs is what we assert on.
    let s = null;
    let renders = 0;
    const deadline = Date.now() + 25000;
    /* eslint-disable no-await-in-loop */
    while (Date.now() < deadline) {
      await browser.execute(() => window.__weftcutTest.weftcutSeekUs(2_500_000));
      await browser.pause(800);
      const snap = await browser.executeAsync((done) => {
        window.__weftcutTest
          .weftcutSampleComposite(240, 240)
          .then((p) =>
            done({
              ok: true,
              p,
              renders: window.__weftcutTemplatePerf?.renders ?? 0,
            }),
          )
          .catch((e) => done({ ok: false, error: String(e) }));
      });
      if (!snap.ok) throw new Error("weftcutSampleComposite failed: " + snap.error);
      s = snap.p;
      renders = snap.renders;
      console.log(
        `[e2e] composite diag: ${s.w}x${s.h} nonTransparent=${s.nonTransparent} ` +
          `maxA=${s.maxA} accentCount=${s.accentCount} ` +
          `accent=(${s.accentR},${s.accentG},${s.accentB}) renders=${renders}`,
      );
      // Enough accent-colored pixels to be unambiguous content, not noise.
      if (s.accentCount > 200) break;
    }
    /* eslint-enable no-await-in-loop */
    if (!s) throw new Error("never sampled the composite");

    // The countdown's accent #ff4d4d (rgb 255,77,77) numeral + arc are present
    // on the LIVE composite: a non-trivial count of opaque high-red/low-other
    // pixels, and a representative accent pixel matching the accent color.
    expect(s.accentCount).toBeGreaterThan(200);
    expect(s.accentR).toBeGreaterThan(180);
    expect(s.accentG).toBeLessThan(150);
    expect(s.accentB).toBeLessThan(150);

    // Frames came through the (CDP) producer, not a no-op / stale cache.
    console.log("[e2e] motif live preview final renders:", renders);
    expect(renders).toBeGreaterThan(0);
  });
});
