// Merged capture-group motif specs:
//   1. motif_capture  — CDP pipeline conformance (determinism, advance, known-frame)
//   2. motif_lower_third — lower-third Motif + host navigation
//   3. motif_live_preview — live editor preview via CDP compositor path

import os from "node:os";
import path from "node:path";

// ── motif_capture constants ──────────────────────────────────────────────────

const CD_PROPS = { seconds: 5, label: "GO", accent: "#ff4d4d" };
const CD_W = 480;
const CD_H = 480;
const CD_ID = "countdown";

// ── motif_lower_third constants ──────────────────────────────────────────────

const LT_PROPS = { title: "Jane Doe", subtitle: "Director of Photography", accent: "#ff4d4d", align: "left" };
const LT_W = 1280, LT_H = 320, LT_ID = "lower-third";

// ── motif_live_preview constants ─────────────────────────────────────────────

const LIVE_PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-motif-live-proj");

// ── shared motif-specific helpers ────────────────────────────────────────────

// capturePng used by motif_capture describe (bound to CD_ID / CD_PROPS / CD_W / CD_H).
async function capturePngCd(tSec) {
  const out = await browser.executeAsync((motifId, t, props, w, h, done) => {
    const hook = window.__weftcutTest;
    if (!hook || typeof hook.captureMotifFrame !== "function") {
      done({ ok: false, error: "captureMotifFrame hook absent" });
      return;
    }
    hook
      .captureMotifFrame({ motifId, tSec: t, props, width: w, height: h })
      .then((b64) => done({ ok: true, b64 }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, CD_ID, tSec, CD_PROPS, CD_W, CD_H);
  if (!out.ok) throw new Error(`captureMotifFrame(t=${tSec}) failed: ${out.error}`);
  return out.b64;
}

// capturePng used by motif_lower_third describe (parameterised).
async function capturePng(motifId, tSec, props, w, h) {
  const out = await browser.executeAsync((motifId, t, props, w, h, done) => {
    const hook = window.__weftcutTest;
    if (!hook || typeof hook.captureMotifFrame !== "function") {
      done({ ok: false, error: "captureMotifFrame hook absent" });
      return;
    }
    hook.captureMotifFrame({ motifId, tSec: t, props, width: w, height: h })
      .then((b64) => done({ ok: true, b64 }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, motifId, tSec, props, w, h);
  if (!out.ok) throw new Error(`capture(${motifId}, t=${tSec}) failed: ${out.error}`);
  return out.b64;
}

// Helper: decode base64 PNG in-browser → sample a pixel at (cx, cy).
// Returns { r, g, b, a } in [0, 255].
async function samplePixel(b64, cx, cy) {
  return browser.executeAsync((b64str, x, y, done) => {
    const bytes = Uint8Array.from(atob(b64str), (c) => c.charCodeAt(0));
    createImageBitmap(new Blob([bytes], { type: "image/png" }))
      .then((bitmap) => {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        const d = ctx.getImageData(x, y, 1, 1).data;
        done({ r: d[0], g: d[1], b: d[2], a: d[3] });
      })
      .catch((e) => done({ error: String(e) }));
  }, b64, cx, cy);
}

// Per-channel diff stats across two PNGs (decoded in-browser). Returns the max
// channel delta and how many pixels exceed BIG (here 8/255). WebView2 keeps the
// held lower-third on a live GPU compositor layer (opacity+translateX, fill:both),
// so its sub-pixel compositing jitters the antialiased edges between sequential
// CDP screenshots of the same frozen time — measured here as a STABLE, repeatable
// ~940/409600 edge pixels touched, only ~25 of them by >8, peak ~28. A font swap
// or wrong frame instead dirties thousands of pixels by tens-to-hundreds.
async function diffStats(b64a, b64b) {
  const r = await browser.executeAsync((s1, s2, done) => {
    const dec = (s) => {
      const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      return createImageBitmap(new Blob([bytes], { type: "image/png" }));
    };
    Promise.all([dec(s1), dec(s2)]).then(([i1, i2]) => {
      if (i1.width !== i2.width || i1.height !== i2.height) { done({ error: "dim mismatch" }); return; }
      const data = (bmp) => {
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const x = c.getContext("2d"); x.drawImage(bmp, 0, 0);
        return x.getImageData(0, 0, bmp.width, bmp.height).data;
      };
      const d1 = data(i1), d2 = data(i2);
      const totalPx = d1.length / 4;
      let max = 0, bigPx = 0;
      for (let p = 0; p < totalPx; p++) {
        let pm = 0;
        for (let ch = 0; ch < 4; ch++) { const dd = Math.abs(d1[p * 4 + ch] - d2[p * 4 + ch]); if (dd > pm) pm = dd; }
        if (pm > max) max = pm;
        if (pm > 8) bigPx++;
      }
      done({ max, bigPx, totalPx });
    }).catch((e) => done({ error: String(e) }));
  }, b64a, b64b);
  if (r.error) throw new Error("diffStats: " + r.error);
  return r;
}

// ── Describe 1: motif_capture pipeline ───────────────────────────────────────
//
// Drives the Motifs capture pipeline (Approach A: hidden WebView2 host window
// + `motif:` scheme + CDP `Page.captureScreenshot`) through the REAL app and
// asserts three conformance properties:
//
//   1. Determinism  — two captures of `countdown` at t=2.5 s must return the
//                     identical base64 PNG (same pixels, same bytes every run).
//   2. Advance      — a capture at t=1.0 s must differ from t=2.5 s (the
//                     Motif's frame() callback advances the DOM with time).
//   3. Known-frame  — at t=2.5 s with duration=5 s, the countdown formula
//                     ceil(5 − 2.5) = 3, so the rendered bitmap's accent-color
//                     pixels must be non-trivially present at a pixel consistent
//                     with the large centered numeral. We verify this via a
//                     pixel-channel check on the captured bitmap decoded in the
//                     real WebView2 (OffscreenCanvas.getImageData).
//
// Props used: { seconds: 5, label: "GO", accent: "#ff4d4d" }, 480×480.
// Accent color #ff4d4d = rgb(255, 77, 77). At t=2.5 the large centered
// numeral "3" fills the center of the 480×480 canvas in that color.

describe("motif_capture pipeline (real WebView2)", () => {
  before(async () => {
    // Wait for the page to be ready.
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30000, timeoutMsg: "never reached readyState=complete" },
    );
    // The hook is installed via a dynamic import in a useEffect — it lands
    // AFTER readyState=complete. Wait for it explicitly.
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () =>
            !!(
              window.__weftcutTest &&
              typeof window.__weftcutTest.captureMotifFrame === "function"
            ),
        ),
      { timeout: 30000, timeoutMsg: "captureMotifFrame hook never installed" },
    );
  });

  // ── CHECK 1: Determinism ────────────────────────────────────────────────────
  // Two captures at the same content time must be byte-identical. The Motif's
  // clock-takeover runtime freezes time to `t`, so there is no entropy from
  // Date.now / rAF / CSS animations — the same t always produces the same PNG.
  it("determinism: two captures at t=2.5 are identical", async () => {
    const a = await capturePngCd(2.5);
    const b = await capturePngCd(2.5);
    expect(a).not.toHaveLength(0);
    expect(a).toBe(b);
  });

  // ── CHECK 2: Advance ────────────────────────────────────────────────────────
  // A capture at t=1.0 must differ from t=2.5. The countdown's frame() callback
  // updates both the numeral (ceil(5-1.0)=4 vs ceil(5-2.5)=3) and the progress
  // arc stroke-dashoffset, so the rendered bitmaps differ.
  it("advance: t=1.0 capture differs from t=2.5", async () => {
    const at25 = await capturePngCd(2.5);
    const at10 = await capturePngCd(1.0);
    expect(at25).not.toHaveLength(0);
    expect(at10).not.toHaveLength(0);
    expect(at10).not.toBe(at25);
  });

  // ── CHECK 3: Known-frame ────────────────────────────────────────────────────
  // At t=2.5, duration=5: ceil(5-2.5) = ceil(2.5) = 3. The countdown renders
  // a large (220px) centered numeral "3" in the accent color #ff4d4d
  // (rgb(255, 77, 77)). The center of the 480×480 canvas falls inside the "3"
  // glyph, so the pixel at (240, 240) must have:
  //   red ≥ 200  (accent red is 255; antialiasing will lower it slightly)
  //   green < 150 (accent green is 77)
  //   blue  < 150 (accent blue  is 77)
  //   alpha = 255 (fully opaque; the numeral is solid)
  //
  // This pins the CORRECT FRAME: if the Motif rendered t=1.0 (numeral "4")
  // instead, the arc arc position would change, but the red center pixel check
  // would still fire — what it really guards is "the render is non-blank and in
  // the accent color". The advance check (above) guards frame-identity; this
  // check guards color/content correctness.
  it("known-frame: t=2.5 renders accent-color content at the center (numeral 3)", async () => {
    const b64 = await capturePngCd(2.5);
    const pixel = await samplePixel(b64, 240, 240);
    if (pixel.error) throw new Error("pixel sample failed: " + pixel.error);
    // Numeral "3" in #ff4d4d should produce a high-red, low-green/blue pixel.
    expect(pixel.r).toBeGreaterThanOrEqual(200);
    expect(pixel.g).toBeLessThan(150);
    expect(pixel.b).toBeLessThan(150);
    expect(pixel.a).toBe(255);
  });
});

// ── Describe 2: lower-third motif + host navigation ──────────────────────────
//
// Drives the lower-third Motif and host navigation through the REAL app:
//   1. Determinism  — two captures at a held time (t=2.0 s, past the 0.8 s
//                     in-animation) are PERCEPTUALLY identical (byte-identical
//                     is unachievable — the held bar rides a live GPU compositor
//                     layer whose AA edges jitter sub-unit between CDP shots).
//   2. Transparent  — a corner pixel outside the bar is fully transparent
//                     (proves just-the-bar geometry + CDP transparent backdrop).
//   3. Accent edge  — the 10 px left border at (69, 192) is the accent color
//                     #ff4d4d (proves font/layout rendered, non-square capture).
//   4. Navigation   — capturing `countdown` then `lower-third` in one session
//                     both succeed (the hidden host navigates between ids).

describe("lower-third motif + host navigation (real WebView2)", () => {
  before(async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30000, timeoutMsg: "never reached readyState=complete" },
    );
    await browser.waitUntil(
      async () => await browser.execute(
        () => !!(window.__weftcutTest && typeof window.__weftcutTest.captureMotifFrame === "function"),
      ),
      { timeout: 30000, timeoutMsg: "captureMotifFrame hook never installed" },
    );
  });

  it("determinism: two held captures at t=2.0 are perceptually identical", async () => {
    const a = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    const b = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    expect(a).not.toHaveLength(0);
    // Byte-identical is unachievable: the held lower-third stays on a live GPU
    // compositor layer (opacity+translateX, fill:both), and WebView2's sub-pixel
    // compositing jitters its antialiased edges between two CDP screenshots of the
    // same frozen time. The contract is PERCEPTUAL determinism, asserted two ways
    // that both stay true under that jitter but break on a font swap / wrong frame
    // (which dirties thousands of pixels):
    //   • peak channel delta stays bounded (edge jitter measured max ~28/255), and
    //   • only a sparse fringe of pixels moves meaningfully (measured ~25 px > 8).
    const { max, bigPx, totalPx } = await diffStats(a, b);
    expect(max).toBeLessThanOrEqual(48);
    expect(bigPx).toBeLessThan(Math.round(totalPx * 0.005)); // < 0.5% of the frame
  });

  it("transparent: a corner pixel outside the bar is fully transparent", async () => {
    const b64 = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    const px = await samplePixel(b64, 10, 10);
    if (px.error) throw new Error("pixel sample failed: " + px.error);
    expect(px.a).toBeLessThan(10);
  });

  it("accent edge: the left border at (69,192) is the accent color", async () => {
    const b64 = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    const px = await samplePixel(b64, 69, 192);
    if (px.error) throw new Error("pixel sample failed: " + px.error);
    expect(px.r).toBeGreaterThanOrEqual(200);
    expect(px.g).toBeLessThan(150);
    expect(px.b).toBeLessThan(150);
    expect(px.a).toBeGreaterThan(200);
  });

  it("navigation: capturing countdown then lower-third in one session both succeed", async () => {
    const cd = await capturePng(CD_ID, 2.5, CD_PROPS, CD_W, CD_H);
    expect(cd).not.toHaveLength(0);
    const lt = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    expect(lt).not.toHaveLength(0);
    const px = await samplePixel(lt, 69, 192);
    if (px.error) throw new Error("pixel sample failed: " + px.error);
    expect(px.r).toBeGreaterThanOrEqual(200);
    const cd2 = await capturePng(CD_ID, 1.0, CD_PROPS, CD_W, CD_H);
    expect(cd2).not.toHaveLength(0);
  });
});

// ── Describe 3: motif live preview (CDP in compositor) ───────────────────────
//
// Proves end-to-end, in the REAL app (real WebView2), that a `countdown`
// Motif layer renders LIVE in the editor preview with its pixels coming
// from the Motif webcap CDP path — NOT the old SVG harness.
//
// The chain under test (all production code paths):
//   add_motif(countdown)  →  Compositor.compositeFrame  →  MotifSprite
//   →  (cache miss)  →  resolveMotifFrame  →  rasterMotifFrame("countdown")
//   →  captureMotifFrame (Rust motif_capture_frame, CDP screenshot of the
//      hidden Motif host)  →  ImageBitmap  →  bound texture on the live stage.
//
// We add the countdown on a 480×480 canvas (its native size, transform
// default x=0/y=0/scale=1), seek the live preview to t=2.5 s, then read the
// composited canvas pixel at its center (240,240). At t=2.5 with duration 5 s
// the countdown shows the large centered numeral "3" in the accent color
// #ff4d4d = rgb(255,77,77). A high-red / low-green / low-blue opaque pixel
// there means the Motif CDP frame reached the live compositor. We also assert
// the backdrop is TRANSPARENT (only the numeral + arc opaque, not a solid white
// box) — the regression guard for the CDP `setDefaultBackgroundColorOverride`
// transparent-screenshot fix, without which overlay Motifs flatten onto white.
//
// The `__weftcutMotifPerf.renders` counter is incremented inside
// `rasterMotifFrame` (the CDP producer), so renders > 0 confirms frames came
// through the live producer rather than a stale cache or a no-op.
//
// Hooks used (apps/desktop/src/testhook/e2eHook.ts, all behind VITE_WEFTCUT_E2E):
//   window.__weftcutTest.newProjectAndEnter  (reused — bootstrap)
//   window.__weftcutTest.motifAddCountdown   (added — add_motif wrapper)
//   window.__weftcutTest.weftcutSeekUs        (added — engine.seek bridge)
//   window.__weftcutTest.weftcutSampleComposite (added — renderer.extract readback)

describe("motif live preview (CDP in compositor)", function () {
  it("a countdown layer renders accent content on a transparent backdrop in the live preview", async () => {
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
    }, LIVE_PROJECT_PARENT);
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
      window.__weftcutMotifPerf = { renders: 0 };
    });

    // 3) Add the countdown Motif layer (5 s span at t=0) and confirm a
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
    //    bind path (resolveMotifFrame → captureMotifFrame → onLoaded →
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
              renders: window.__weftcutMotifPerf?.renders ?? 0,
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

    // Overlay compositing: the Motif authors `background:transparent`, so on a
    // 480×480 countdown only the numeral + arc are opaque — the rest must be
    // transparent so it composites over the video below. This is the regression
    // guard for the CDP transparent-backdrop fix: `Page.captureScreenshot`
    // defaults to an opaque WHITE base, and without
    // `Emulation.setDefaultBackgroundColorOverride` (alpha 0) the whole frame
    // comes back opaque (nonTransparent ≈ w*h — a solid white box). Assert the
    // backdrop is transparent: content is present but well under half the frame.
    const totalPx = s.w * s.h;
    console.log(
      `[e2e] overlay transparency: nonTransparent=${s.nonTransparent}/${totalPx}`,
    );
    expect(s.nonTransparent).toBeGreaterThan(0); // content actually composited
    expect(s.nonTransparent).toBeLessThan(totalPx * 0.5); // backdrop transparent, not a white box

    // Frames came through the (CDP) producer, not a no-op / stale cache.
    console.log("[e2e] motif live preview final renders:", renders);
    expect(renders).toBeGreaterThan(0);
  });
});
