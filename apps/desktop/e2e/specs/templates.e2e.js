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

// Drives the REAL harness through a SYNTHETIC, test-only fixture (built inline
// in the e2e hook, NOT in the shipping catalog) that closes three coverage gaps
// the only built-in (`countdown`) can't reach — it has no font, no clock read,
// and its `<script>` is a SIBLING of the `<svg>`:
//   1. clock stub — the fixture's render() writes String(Date.now()) into a
//      <text id="clock">. The harness stubs Date.now()->0, so the capture must
//      show the stubbed `>0<`, NOT a real 13-digit epoch.
//   2. in-<svg> <script> strip — the fixture puts a <script> as a CHILD of the
//      <svg>; the captured clone must contain no `<script`, and the stripped
//      markup must rasterize cleanly (well-formed XML).
//   3. bundled font — the fixture declares a @font-face family with embedded
//      woff2 bytes; the harness must inject it into the captured markup.
// The hook returns { svg, rasterizeOk } (it owns the bundled rasterizeSvg,
// which browser.execute can't import).
describe("template harness coverage gaps (real WebView2, synthetic fixture)", () => {
  let result;

  before(async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30000, timeoutMsg: "never reached readyState=complete" },
    );
    // Installed in the same async useEffect as renderTemplateFrameSvg; wait for
    // it explicitly (it lands after readyState=complete).
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () =>
            !!(
              window.__weftcutTest &&
              typeof window.__weftcutTest.renderTestFixtureSvg === "function"
            ),
        ),
      { timeout: 30000, timeoutMsg: "renderTestFixtureSvg hook never installed" },
    );

    const out = await browser.executeAsync((done) => {
      const hook = window.__weftcutTest;
      hook
        .renderTestFixtureSvg({ tSec: 0.5, durSec: 3, props: {} })
        .then((r) => done({ ok: true, svg: r.svg, rasterizeOk: r.rasterizeOk }))
        .catch((e) => done({ ok: false, error: String(e) }));
    });
    if (!out.ok) throw new Error("renderTestFixtureSvg failed: " + out.error);
    result = out;
  });

  it("clock-stub: stubbed Date.now()->0 lands in #clock (no real epoch)", () => {
    // render() wrote String(Date.now()); the harness stubs Date.now()->0, so
    // the #clock text node must be `0`. >0< is the serialized text node.
    expect(result.svg).toContain(">0<");
    // And NOT a real 13-digit epoch ms in a text node. The `>`-anchored form
    // avoids false-positives from long digit runs in the embedded base64 woff2
    // (base64 contains no `>`/`<`, so only actual text nodes can match).
    expect(result.svg).not.toMatch(/>\d{13}</);
  });

  it("script-strip: in-<svg> <script> removed + markup rasterizes clean", () => {
    // The fixture has a <script> CHILD of the <svg>; the captured clone must
    // contain no <script (proves the strip removed an actually-present one).
    expect(result.svg).not.toContain("<script");
    // Stripped markup is well-formed XML: rasterizeSvg(svg) resolved.
    expect(result.rasterizeOk).toBe(true);
  });

  it("font: declared @font-face injected with embedded woff2 data URL", () => {
    expect(result.svg).toContain("@font-face");
    expect(result.svg).toContain("HarnessTestFont");
    expect(result.svg).toContain("data:font/woff2;base64,");
  });
});
