import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-image-proj");

// Still-image support matrix in the real WebView2, through the REAL app
// pipeline: import (probe + classify) → ImageOverlay placement → preview
// composite (fetch asset:// → createImageBitmap → Pixi texture). Each format
// places the same color-patch chart at its own timeline window, seeks the
// live preview into that window, and samples patch centers off the composited
// canvas.
//
// tiff is the documented-UNSUPPORTED negative: it imports + classifies as
// Image, but WebView2's createImageBitmap cannot decode TIFF, so the sprite
// stays Texture.EMPTY and the composite stays empty. If this case ever starts
// FAILING, the webview learned TIFF — promote it to the positive matrix.
//
// The animated gif is the routing assertion for probe::detect_kind: multi-
// frame gif must classify as VIDEO (so it animates via the proxy pipeline)
// and must reach an export-ready proxy route.
const STILLS = [
  // tol: per-channel readback tolerance. png/bmp are exact encodings and
  // webp is encoded lossless (small slack for the GPU round-trip); jpg is
  // q:v 2 lossy; gif is palette-quantized (flat saturated patches survive,
  // but with the widest slack).
  { ext: "png", tol: 4 },
  { ext: "jpg", tol: 8 },
  { ext: "webp", tol: 4 },
  { ext: "bmp", tol: 4 },
  { ext: "gif", tol: 12 },
];
// Saturated/extreme patches survive every encoding in the matrix (incl. the
// gif palette); mid-tones would be palette-fragile.
const PATCH_IDS = ["red", "green", "blue", "white", "black"];
const STILL_SPAN_US = 5_000_000; // images default to 3 s on screen — no overlap

const chartPath = (ext) => path.resolve(MEDIA_DIR, `test_chart_320x240.${ext}`);

function patchCenters() {
  const manifest = JSON.parse(
    readFileSync(path.resolve(MEDIA_DIR, "test_chart_320x240_manifest.json"), "utf8"),
  );
  return PATCH_IDS.map((id) => {
    const p = manifest.patches.find((q) => q.id === id);
    if (!p) throw new Error(`manifest missing patch ${id}`);
    return { id, x: p.X ?? p.x, y: p.Y ?? p.y, w: p.W ?? p.w, h: p.H ?? p.h, rgb: p.RGB ?? p.rgb };
  }).map((p) => ({ id: p.id, cx: p.x + Math.floor(p.w / 2), cy: p.y + Math.floor(p.h / 2), rgb: p.rgb }));
}

async function waitForHook(name) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (n) => typeof window.__weftcutTest?.[n] === "function",
        name,
      )) === true,
    { timeout: 30000, timeoutMsg: `${name} never mounted` },
  );
}

async function importAndPlace(mediaAbsPath, tStartUs) {
  const r = await browser.executeAsync((p, t, done) => {
    window.__weftcutTest
      .importAndPlaceMedia({ mediaAbsPath: p, tStartUs: t })
      .then((res) => done({ ok: true, ...res }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, mediaAbsPath, tStartUs);
  if (!r.ok) throw new Error(`importAndPlaceMedia(${mediaAbsPath}) failed: ${r.error}`);
  return r;
}

async function sampleAt(tUs, x, y) {
  // Re-seek before each sample so a paused stale frame can't mask the
  // async bitmap bind (ensureImage → loadFromAsset → scheduleRepaint).
  await browser.execute((t) => window.__weftcutTest.weftcutSeekUs(t), tUs);
  await browser.pause(300);
  const r = await browser.executeAsync((px, py, done) => {
    window.__weftcutTest
      .weftcutSampleComposite(px, py)
      .then((p) => done({ ok: true, p }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, x, y);
  if (!r.ok) throw new Error(`weftcutSampleComposite failed: ${r.error}`);
  return r.p;
}

describe("still-image + gif media support (real WebView2)", function () {
  before(function () {
    mkdirSync(PROJECT_PARENT, { recursive: true });
  });

  it("renders every dialog-offered still format through the live composite; tiff stays empty; animated gif routes to Video", async function () {
    // 5 stills × (async-bind poll + 5 patch samples) + the animated gif's
    // full-proxy wait — well past the suite's 180 s default.
    this.timeout(420000);
    if (!existsSync(chartPath("png"))) {
      console.warn(`[e2e] SKIP: image fixtures not found at ${chartPath("png")}`);
      this.skip();
    }
    const centers = patchCenters();

    await waitForHook("newProjectAndEnter");
    const r1 = await browser.executeAsync((parent, done) => {
      window.__weftcutTest
        .newProjectAndEnter({
          parentFolder: parent,
          name: "e2e-image-" + Date.now(),
          canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
        })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, PROJECT_PARENT);
    if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);
    await waitForHook("importAndPlaceMedia");
    await waitForHook("weftcutSampleComposite");

    // ---- positive matrix: each still at its own window ----
    for (let i = 0; i < STILLS.length; i++) {
      const { ext } = STILLS[i];
      const placed = await importAndPlace(chartPath(ext), i * STILL_SPAN_US);
      expect(placed.kind).toBe("Image");
    }

    // The sample hook exists from boot, but its preview BRIDGE only registers
    // once PixiPreview mounts — and PreviewSurface renders a placeholder (no
    // PixiPreview) while the timeline is EMPTY. So wait for the bridge only
    // after the placements above made the timeline non-empty.
    await browser.waitUntil(
      async () =>
        (await browser.executeAsync((done) => {
          window.__weftcutTest
            .weftcutSampleComposite(0, 0)
            .then(() => done(true))
            .catch(() => done(false));
        })) === true,
      { timeout: 30000, timeoutMsg: "preview bridge never registered" },
    );

    /* eslint-disable no-await-in-loop */
    for (let i = 0; i < STILLS.length; i++) {
      const { ext, tol } = STILLS[i];
      const tUs = i * STILL_SPAN_US + 1_000_000;
      // The bitmap binds asynchronously after the first seek into the layer's
      // window — poll the red patch until content appears.
      const red = centers.find((c) => c.id === "red");
      let s = null;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        s = await sampleAt(tUs, red.cx, red.cy);
        if (s.a > 0) break;
      }
      if (!s || s.a === 0) {
        throw new Error(
          `${ext}: image never composited (nonTransparent=${s?.nonTransparent}, maxA=${s?.maxA})`,
        );
      }
      for (const c of centers) {
        const p = await sampleAt(tUs, c.cx, c.cy);
        const diff = [Math.abs(p.r - c.rgb[0]), Math.abs(p.g - c.rgb[1]), Math.abs(p.b - c.rgb[2])];
        console.log(
          `[e2e] ${ext} patch ${c.id}@(${c.cx},${c.cy}): got (${p.r},${p.g},${p.b}) want (${c.rgb}) tol=${tol}`,
        );
        expect(p.a).toBe(255);
        for (const d of diff) expect(d).toBeLessThanOrEqual(tol);
      }
    }
    /* eslint-enable no-await-in-loop */

    // ---- negative: tiff imports as Image but composites nothing ----
    const tiffT = STILLS.length * STILL_SPAN_US;
    const tiff = await importAndPlace(chartPath("tiff"), tiffT);
    expect(tiff.kind).toBe("Image");
    // Give the (failing) decode a generous beat, then assert the whole frame
    // stayed empty at the tiff's window.
    await browser.pause(3000);
    const s = await sampleAt(tiffT + 1_000_000, 160, 120);
    console.log(`[e2e] tiff window diag: nonTransparent=${s.nonTransparent} maxA=${s.maxA}`);
    expect(s.nonTransparent).toBe(0);

    // ---- routing: animated gif is VIDEO and reaches an export-ready route ----
    const animPath = path.resolve(MEDIA_DIR, "test_1080p_10fps.gif");
    if (!existsSync(animPath)) {
      console.warn(`[e2e] SKIP animated-gif leg: ${animPath} missing`);
      return;
    }
    const anim = await importAndPlace(animPath, (STILLS.length + 1) * STILL_SPAN_US);
    expect(anim.kind).toBe("Video");
    const ready = await browser.executeAsync((mediaId, done) => {
      window.__weftcutTest
        .waitMediaExportReady({ mediaId, timeoutMs: 120000 })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, anim.mediaId);
    if (!ready.ok) {
      throw new Error("animated gif never became export-ready (proxy route): " + ready.error);
    }
  });
});
