import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { waitForHook, invokeCmd, newProject, summary, findLayer, findTrackOf } from "../../helpers/app.mjs";
import { sampleAt, waitPreviewBridge } from "../../helpers/preview.mjs";
import { MEDIA_DIR, fixture } from "../../helpers/media.mjs";

// ── Shared canvas / duration constants ──────────────────────────────────────
const CANVAS = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 };
const DEFAULT_DURATION_US = 5_000_000;

// ── add_color_text_layer project parent ─────────────────────────────────────
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-add-layer-proj");

// ── image_support constants ─────────────────────────────────────────────────
const PROJECT_PARENT_IMAGE = path.resolve(os.tmpdir(), "weftcut-e2e-image-proj");

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

const chartPath = (ext) => fixture(`test_chart_320x240.${ext}`);

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

// ── Add-Color/Text-layer feature through the REAL app pipeline in WebView2 ──
// the Insert-menu commands `add_color_layer` / `add_text_layer` (driven here
// straight over the Tauri IPC, the same commands the menu handlers call) →
// actor mutation → `project_summary` readback and, for color, the LIVE Pixi
// composite (ColorSprite). Mirrors the placement rule the Rust unit tests pin
// (`pick_free_overlay_track` / `resolve_overlay_track`) end-to-end: a fresh
// project's reserved A/B rows force a new overlay track, a non-overlapping
// insert reuses it, an overlapping one splits to a new track.
//
// `withGlobalTauri: true` (tauri.conf.json) exposes `window.__TAURI__.core.invoke`
// to the closed-world spec context, so the add commands + summary are invoked
// directly without bundled imports; the render leg uses the existing
// `weftcutSeekUs` / `weftcutSampleComposite` preview hooks.

describe("add color & text layers (real WebView2)", function () {
  before(function () {
    mkdirSync(PROJECT_PARENT, { recursive: true });
  });

  it("adds a Color layer with defaults: full-frame, ~5s, on a role-null overlay track", async function () {
    this.timeout(120000);
    await newProject({ parentFolder: PROJECT_PARENT, canvas: CANVAS });
    const layerId = await invokeCmd("add_color_layer", { tStartUs: 0 });
    expect(typeof layerId).toBe("string");

    const sum = await summary();
    const layer = findLayer(sum, layerId);
    expect(layer).not.toBe(null);
    expect(layer.params.kind).toBe("Color");
    // Default matte covers the whole composition.
    expect(layer.params.width).toBe(CANVAS.width);
    expect(layer.params.height).toBe(CANVAS.height);
    // ~5s default duration (frame-grid snap keeps it within a frame).
    const dur = layer.t_end_us - layer.t_start_us;
    expect(dur).toBeGreaterThanOrEqual(DEFAULT_DURATION_US - 100_000);
    expect(dur).toBeLessThanOrEqual(DEFAULT_DURATION_US + 100_000);
    // Lands on a non-reserved (overlay) track — reserved A/B rows carry a role.
    const track = findTrackOf(sum, layerId);
    expect(track).not.toBe(null);
    expect(track.role == null).toBe(true);
  });

  it("renders the Color layer's chosen color full-frame in the live composite", async function () {
    this.timeout(120000);
    await newProject({ parentFolder: PROJECT_PARENT, canvas: CANVAS });
    // Explicit red distinguishes the layer from any composition background.
    const layerId = await invokeCmd("add_color_layer", {
      tStartUs: 0,
      color: { r: 255, g: 0, b: 0, a: 255 },
    });
    expect(typeof layerId).toBe("string");

    await waitPreviewBridge();
    const cx = Math.floor(CANVAS.width / 2);
    const cy = Math.floor(CANVAS.height / 2);
    // The composite updates asynchronously after the invoke — poll the center
    // until the red lands.
    let s = null;
    const deadline = Date.now() + 20000;
    /* eslint-disable no-await-in-loop */
    while (Date.now() < deadline) {
      s = await sampleAt(2_500_000, cx, cy);
      if (s.a === 255 && s.r > 200 && s.g < 60 && s.b < 60) break;
    }
    /* eslint-enable no-await-in-loop */
    if (!s || s.a !== 255) {
      throw new Error(`color layer never composited (a=${s?.a}, nonTransparent=${s?.nonTransparent})`);
    }
    expect(s.r).toBeGreaterThan(200);
    expect(s.g).toBeLessThan(60);
    expect(s.b).toBeLessThan(60);
    // A corner samples the same color → the matte is full-frame, not a small rect.
    const corner = await sampleAt(2_500_000, 10, 10);
    expect(corner.a).toBe(255);
    expect(corner.r).toBeGreaterThan(200);
    expect(corner.g).toBeLessThan(60);
    expect(corner.b).toBeLessThan(60);
  });

  it("adds a Text layer defaulting to content 'Text'", async function () {
    this.timeout(120000);
    await newProject({ parentFolder: PROJECT_PARENT, canvas: CANVAS });
    const layerId = await invokeCmd("add_text_layer", { tStartUs: 0 });
    expect(typeof layerId).toBe("string");

    const sum = await summary();
    const layer = findLayer(sum, layerId);
    expect(layer).not.toBe(null);
    expect(layer.params.kind).toBe("Text");
    expect(layer.params.content).toBe("Text");
    const track = findTrackOf(sum, layerId);
    expect(track.role == null).toBe(true);
  });

  it("smart placement: reuses a free overlay track, splits to a new one on overlap", async function () {
    this.timeout(120000);
    await newProject({ parentFolder: PROJECT_PARENT, canvas: CANVAS });
    // First insert → a fresh overlay track (reserved A/B can't host it).
    const a = await invokeCmd("add_color_layer", { tStartUs: 0, durationUs: DEFAULT_DURATION_US });
    // Non-overlapping (starts after `a` ends) → reuse the same overlay track.
    const b = await invokeCmd("add_color_layer", { tStartUs: 6_000_000, durationUs: DEFAULT_DURATION_US });
    // Overlaps `a` → can't reuse → split to a new track.
    const c = await invokeCmd("add_color_layer", { tStartUs: 2_000_000, durationUs: DEFAULT_DURATION_US });

    const sum = await summary();
    const ta = findTrackOf(sum, a);
    const tb = findTrackOf(sum, b);
    const tc = findTrackOf(sum, c);
    expect(ta).not.toBe(null);
    expect(tb).not.toBe(null);
    expect(tc).not.toBe(null);
    expect(tb.id).toBe(ta.id); // reused the free overlay track
    expect(tc.id).not.toBe(ta.id); // overlap forced a new track
  });
});

describe("still-image + gif media support (real WebView2)", function () {
  before(function () {
    mkdirSync(PROJECT_PARENT_IMAGE, { recursive: true });
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

    await newProject({
      parentFolder: PROJECT_PARENT_IMAGE,
      name: "e2e-image-" + Date.now(),
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    });
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
    await waitPreviewBridge();

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
    const animPath = fixture("test_1080p_10fps.gif");
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
