// Locks the SVG-template rasterizer's load-bearing platform behavior in the
// REAL WebView2: a PLAIN SVG (gradient rect + anti-aliased <text>, transparent
// background, NO foreignObject) rasterizes to an ImageBitmap that draws to a
// canvas WITHOUT tainting it (getImageData does not throw) and preserves the
// transparent background (corner alpha === 0) while actually painting content
// (an interior pixel inside the gradient rect is opaque).
//
// foreignObject taints the canvas in WebView2 — this test guards the plain-SVG
// path that the production template render relies on instead. What's being
// pinned here is the WebView2 PLATFORM behavior (a plain SVG → ImageBitmap →
// canvas stays untainted and keeps its transparent background), not the
// identity of any particular module. So the rasterizer body is inlined as a
// verbatim mirror of src/render/templates/svgRaster.ts: browser.execute
// stringifies the function and runs it in the page with no closure over
// node-side bundled modules, and inlining keeps the spec self-contained (no
// project/editor setup). KEEP IN SYNC with svgRaster.ts.
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
    // Clean (not tainted): getImageData succeeded. Guard-throw first so a taint
    // failure reports WHY (the SecurityError text) instead of a bare
    // `expected false to be true` (jest's expect has no message argument).
    if (!result.didNotThrow) throw new Error("canvas tainted: " + result.error);
    expect(result.didNotThrow).toBe(true);
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
    // The binding guard for the strip is THIS assertion: the fixture has a
    // <script> CHILD of the <svg>, so the captured clone containing no <script
    // proves the strip removed an actually-present one.
    expect(result.svg).not.toContain("<script");
    // rasterizeOk is a SEPARATE check — it proves the stripped markup is still
    // well-formed XML (rasterizeSvg resolved), NOT that the script was stripped.
    expect(result.rasterizeOk).toBe(true);
  });

  it("font: declared @font-face injected with embedded woff2 data URL", () => {
    expect(result.svg).toContain("@font-face");
    expect(result.svg).toContain("HarnessTestFont");
    expect(result.svg).toContain("data:font/woff2;base64,");
  });
});

// Drives the REAL TemplateSprite (Task A: SVG-render path wired into the live
// compositor) through `window.__weftcutTest.renderTemplateSpriteFrames`. The
// hook constructs the actual `TemplateSprite`, calls `update(view, tInLayerUs,
// durationUs)` at two layer-relative times, awaits each async bind, and reads
// back a checksum of the bound raster. This exercises the sprite's full chain
// in real WebView2: tInLayerUs → frame index → frameTimeSec → harness
// render(tSec) → rasterizeSvg → bound Texture.
//
// countdown is 480x480, dur shown = ceil(durationSec - tSec). With
// durationUs = 5_000_000 (5 s) @ 30 fps (150 frames):
//   tInLayerUs=0        -> frame 0  -> tSec 0   -> ceil(5)   = numeral 5
//   tInLayerUs=2_500_000-> frame 75 -> tSec 2.5 -> ceil(2.5) = numeral 3
// The numeral AND the sweeping progress arc both change, so the two frames'
// pixel checksums must differ. (The exact numerals are asserted by the harness
// spec above; here we prove the SPRITE selects + binds a DIFFERENT frame as
// the layer-relative playhead advances.)
describe("template sprite frame selection (real WebView2)", () => {
  before(async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30000, timeoutMsg: "never reached readyState=complete" },
    );
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () =>
            !!(
              window.__weftcutTest &&
              typeof window.__weftcutTest.renderTemplateSpriteFrames === "function"
            ),
        ),
      { timeout: 30000, timeoutMsg: "renderTemplateSpriteFrames hook never installed" },
    );
  });

  it("binds a different raster as the layer-relative playhead advances", async () => {
    const out = await browser.executeAsync((done) => {
      window.__weftcutTest
        .renderTemplateSpriteFrames({
          templateId: "countdown",
          fpsNum: 30,
          fpsDen: 1,
          durationUs: 5_000_000,
          times: [{ tInLayerUs: 0 }, { tInLayerUs: 2_500_000 }],
          props: {},
        })
        .then((frames) => done({ ok: true, frames }))
        .catch((e) => done({ ok: false, error: String(e) }));
    });
    if (!out.ok) throw new Error("renderTemplateSpriteFrames failed: " + out.error);

    const [early, late] = out.frames;
    // Both rasters captured at the template's natural size.
    expect(early.width).toBe(480);
    expect(early.height).toBe(480);
    expect(late.width).toBe(480);
    expect(late.height).toBe(480);
    // Each frame actually painted content (a blank/transparent 480x480 would
    // checksum to 0).
    expect(early.checksum).toBeGreaterThan(0);
    expect(late.checksum).toBeGreaterThan(0);
    // The sprite selected + bound a DIFFERENT frame for the two times.
    expect(early.checksum).not.toBe(late.checksum);
  });
});
