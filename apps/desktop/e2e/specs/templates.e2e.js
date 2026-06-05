// Locks the SVG-template rasterizer's load-bearing platform behavior in the
// REAL WebView2: a PLAIN SVG (gradient rect + anti-aliased <text>, transparent
// background, NO foreignObject) rasterizes to an ImageBitmap that draws to a
// canvas WITHOUT tainting it (getImageData does not throw) and preserves the
// transparent background (corner alpha === 0) while actually painting content
// (an interior pixel inside the gradient rect is opaque).
//
// foreignObject taints the canvas in WebView2 — this test guards the plain-SVG
// path that the production template render relies on instead. The rasterizer
// body is inlined here (verbatim mirror of src/render/templates/svgRaster.ts)
// because browser.execute stringifies the function and injects it into the
// page: it has no closure over node-side bundled modules, so the only way to
// run the real code in-webview is to either put it on `window` or inline it.
// Inlining keeps the spec self-contained (no project/editor setup needed) and
// the commit to the two task files. KEEP IN SYNC with svgRaster.ts.
describe("SVG-template rasterizer (real WebView2)", () => {
  it("rasterizes plain SVG to an UNTAINTED ImageBitmap with a transparent bg", async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30000, timeoutMsg: "never reached readyState=complete" },
    );

    const result = await browser.executeAsync((done) => {
      // --- mirror of src/render/templates/svgRaster.ts (keep in sync) ---
      async function rasterizeSvg(svg) {
        const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        try {
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = () => res();
            img.onerror = () => rej(new Error("svgRaster: <img> failed to load SVG"));
            img.src = url;
          });
          return await createImageBitmap(img);
        } finally {
          URL.revokeObjectURL(url);
        }
      }

      // Plain SVG: a linear-gradient rect inset from the origin (so the corner
      // stays transparent) + anti-aliased text. NO foreignObject. The 480x160
      // viewport has no background fill → it is transparent by default.
      const W = 480;
      const H = 160;
      const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
        `<defs>`,
        `<linearGradient id="g" x1="0" y1="0" x2="1" y2="0">`,
        `<stop offset="0%" stop-color="#0050ff"/>`,
        `<stop offset="100%" stop-color="#ff3050"/>`,
        `</linearGradient>`,
        `</defs>`,
        // Inset rect: leaves the (0,0) corner transparent.
        `<rect x="20" y="20" width="${W - 40}" height="${H - 40}" rx="12" fill="url(#g)"/>`,
        `<text x="${W / 2}" y="${H / 2}" font-family="sans-serif" font-size="36" `,
        `text-anchor="middle" dominant-baseline="middle" fill="#ffffff">WeftCut</text>`,
        `</svg>`,
      ].join("");

      rasterizeSvg(svg)
        .then((bitmap) => {
          const out = {
            ok: true,
            width: bitmap.width,
            height: bitmap.height,
            // The no-throw of getImageData IS the taint check.
            didNotThrow: false,
            cornerAlpha: null,
            interiorAlpha: null,
            error: null,
          };
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(bitmap, 0, 0);
          try {
            // Corner (0,0): transparent region of the SVG.
            const corner = ctx.getImageData(0, 0, 1, 1).data;
            // Center: inside the gradient rect — proves pixels actually drew.
            const interior = ctx.getImageData(
              Math.floor(bitmap.width / 2),
              Math.floor(bitmap.height / 2),
              1,
              1,
            ).data;
            out.didNotThrow = true;
            out.cornerAlpha = corner[3];
            out.interiorAlpha = interior[3];
          } catch (e) {
            // A tainted canvas throws SecurityError here.
            out.didNotThrow = false;
            out.error = String(e);
          }
          bitmap.close?.();
          done(out);
        })
        .catch((e) => done({ ok: false, error: String(e) }));
    });

    if (!result.ok) throw new Error("rasterizeSvg failed: " + result.error);
    // Bitmap decoded at the SVG's declared size.
    expect(result.width).toBe(480);
    expect(result.height).toBe(160);
    // Clean (not tainted): getImageData succeeded.
    expect(result.didNotThrow).toBe(true);
    if (!result.didNotThrow) throw new Error("canvas tainted: " + result.error);
    // Transparent background preserved at the corner.
    expect(result.cornerAlpha).toBe(0);
    // Content actually painted: interior pixel is opaque.
    expect(result.interiorAlpha).toBeGreaterThan(0);
  });
});

// Drives the REAL capture harness (src/render/templates/harness.ts +
// harnessFrame.ts) through the e2e hook `window.__weftcutTest.renderTemplateFrameSvg`.
// `browser.execute` can't import bundled modules, so the harness is constructed
// app-side (Root effect, gated on VITE_WEFTCUT_E2E) and exposed on the hook; the
// spec just calls it. The hook loads the `countdown` built-in (via getTemplate)
// and returns the serialized post-render <svg> for a given time.
//
// countdown shows ceil(dur - t) with dur=5: t=0.5 -> ceil(4.5)=5 (">5<"),
// t=2.5 -> ceil(2.5)=3 (">3<"). Two renders at the same t must be byte-identical
// (Date.now/performance.now/rAF stubbed in the harness => deterministic).
describe("template capture harness (real WebView2)", () => {
  async function renderFrame(tSec) {
    const out = await browser.executeAsync((t, done) => {
      const hook = window.__weftcutTest;
      if (!hook || typeof hook.renderTemplateFrameSvg !== "function") {
        done({ ok: false, error: "renderTemplateFrameSvg hook absent" });
        return;
      }
      hook
        .renderTemplateFrameSvg({ templateId: "countdown", tSec: t, durSec: 5, props: {} })
        .then((svg) => done({ ok: true, svg }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, tSec);
    if (!out.ok) throw new Error("renderTemplateFrameSvg failed: " + out.error);
    return out.svg;
  }

  before(async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30000, timeoutMsg: "never reached readyState=complete" },
    );
    // The hook is installed in an async useEffect (after a dynamic import), so
    // it lands AFTER readyState=complete. Wait for it explicitly.
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () =>
            !!(
              window.__weftcutTest &&
              typeof window.__weftcutTest.renderTemplateFrameSvg === "function"
            ),
        ),
      { timeout: 30000, timeoutMsg: "renderTemplateFrameSvg hook never installed" },
    );
  });

  it("render(t) animates: different t => different <svg> with the right numeral", async () => {
    const early = await renderFrame(0.5);
    const late = await renderFrame(2.5);

    // Script ran + mutated the DOM differently per t.
    expect(early).not.toBe(late);
    // Serialized post-render <svg> (scripts stripped from the clone).
    expect(early).toContain("<svg");
    expect(early).not.toContain("<script");
    // ceil(5 - 0.5) = 5; ceil(5 - 2.5) = 3.
    expect(early).toContain(">5<");
    expect(late).toContain(">3<");
  });

  it("is deterministic: two renders at the same t are byte-identical", async () => {
    const a = await renderFrame(0.5);
    const b = await renderFrame(0.5);
    expect(a).toBe(b);
  });
});
