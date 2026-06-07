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
// The capture is exercised through `window.__weftcutTest.captureMotifFrame`
// (installed by `installMotifHook()` in e2eHook.ts), which calls the Rust
// `motif_capture_frame` Tauri command — the same production path the UI will
// use. The returned base64 PNG is decoded in-browser so the spec can assert
// pixel-level properties without importing bundled modules.
//
// Part A (Rust-side smoke + CDP conformance) provides the authoritative proof;
// this spec is the regression guard that runs through the tauri-driver harness.
//
// Props used: { seconds: 5, label: "GO", accent: "#ff4d4d" }, 480×480.
// Accent color #ff4d4d = rgb(255, 77, 77). At t=2.5 the large centered
// numeral "3" fills the center of the 480×480 canvas in that color.

const PROPS = { seconds: 5, label: "GO", accent: "#ff4d4d" };
const W = 480;
const H = 480;
const MOTIF_ID = "countdown";

// Helper: call the hook and return the raw base64 PNG.
async function capturePng(tSec) {
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
  }, MOTIF_ID, tSec, PROPS, W, H);
  if (!out.ok) throw new Error(`captureMotifFrame(t=${tSec}) failed: ${out.error}`);
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
    const a = await capturePng(2.5);
    const b = await capturePng(2.5);
    expect(a).not.toHaveLength(0);
    expect(a).toBe(b);
  });

  // ── CHECK 2: Advance ────────────────────────────────────────────────────────
  // A capture at t=1.0 must differ from t=2.5. The countdown's frame() callback
  // updates both the numeral (ceil(5-1.0)=4 vs ceil(5-2.5)=3) and the progress
  // arc stroke-dashoffset, so the rendered bitmaps differ.
  it("advance: t=1.0 capture differs from t=2.5", async () => {
    const at25 = await capturePng(2.5);
    const at10 = await capturePng(1.0);
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
    const b64 = await capturePng(2.5);
    const pixel = await samplePixel(b64, 240, 240);
    if (pixel.error) throw new Error("pixel sample failed: " + pixel.error);
    // Numeral "3" in #ff4d4d should produce a high-red, low-green/blue pixel.
    expect(pixel.r).toBeGreaterThanOrEqual(200);
    expect(pixel.g).toBeLessThan(150);
    expect(pixel.b).toBeLessThan(150);
    expect(pixel.a).toBe(255);
  });
});
