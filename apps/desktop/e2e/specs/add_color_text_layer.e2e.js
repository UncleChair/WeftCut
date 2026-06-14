import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

// Add-Color/Text-layer feature through the REAL app pipeline in WebView2:
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

const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-add-layer-proj");
const CANVAS = { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 };
const DEFAULT_DURATION_US = 5_000_000;

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

async function newProject() {
  await waitForHook("newProjectAndEnter");
  const r = await browser.executeAsync(
    (parent, canvas, done) => {
      window.__weftcutTest
        .newProjectAndEnter({ parentFolder: parent, name: "e2e-add-" + Date.now(), canvas })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    },
    PROJECT_PARENT,
    canvasArg(),
  );
  if (!r.ok) throw new Error("newProjectAndEnter failed: " + r.error);
}

// `browser.executeAsync` serializes args structurally; pass a plain clone.
function canvasArg() {
  return { ...CANVAS };
}

async function invokeCmd(cmd, args) {
  const r = await browser.executeAsync(
    (c, a, done) => {
      window.__TAURI__.core
        .invoke(c, a)
        .then((res) => done({ ok: true, res }))
        .catch((e) => done({ ok: false, error: String(e) }));
    },
    cmd,
    args ?? {},
  );
  if (!r.ok) throw new Error(`invoke ${cmd} failed: ${r.error}`);
  return r.res;
}

const summary = () => invokeCmd("project_summary");

function findLayer(sum, layerId) {
  for (const t of sum.tracks) {
    const l = t.layers.find((x) => x.id === layerId);
    if (l) return l;
  }
  return null;
}

function findTrackOf(sum, layerId) {
  return sum.tracks.find((t) => t.layers.some((l) => l.id === layerId)) ?? null;
}

// Re-seek before each sample so a paused stale frame can't mask the async
// composite update (the actor mutation reaches the preview via the
// project:changed bridge a beat after the invoke resolves).
async function sampleAt(tUs, x, y) {
  await browser.execute((t) => window.__weftcutTest.weftcutSeekUs(t), tUs);
  await browser.pause(300);
  const r = await browser.executeAsync(
    (px, py, done) => {
      window.__weftcutTest
        .weftcutSampleComposite(px, py)
        .then((p) => done({ ok: true, p }))
        .catch((e) => done({ ok: false, error: String(e) }));
    },
    x,
    y,
  );
  if (!r.ok) throw new Error(`weftcutSampleComposite failed: ${r.error}`);
  return r.p;
}

// The preview bridge only registers once PixiPreview mounts, which only happens
// once the timeline is non-empty — so call this AFTER a layer has been added.
async function waitPreviewBridge() {
  await browser.waitUntil(
    async () =>
      (await browser.executeAsync((done) => {
        if (typeof window.__weftcutTest?.weftcutSampleComposite !== "function") {
          return done(false);
        }
        window.__weftcutTest
          .weftcutSampleComposite(0, 0)
          .then(() => done(true))
          .catch(() => done(false));
      })) === true,
    { timeout: 30000, timeoutMsg: "preview bridge never registered" },
  );
}

describe("add color & text layers (real WebView2)", function () {
  before(function () {
    mkdirSync(PROJECT_PARENT, { recursive: true });
  });

  it("adds a Color layer with defaults: full-frame, ~5s, on a role-null overlay track", async function () {
    this.timeout(120000);
    await newProject();
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
    await newProject();
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
    await newProject();
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
    await newProject();
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
