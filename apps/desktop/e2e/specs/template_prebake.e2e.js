import os from "node:os";
import path from "node:path";

// Real-WebView2 end-to-end gate for the L2 persisted template pre-bake.
//
// Three tests that cannot run in the vitest environment (OffscreenCanvas and
// the Tauri fs plugin are absent there):
//
//   1. Bake writes PNGs — add a countdown layer, request a pre-bake via the
//      prebakeBus hook, assert PNG files appear under Cache/raster/<hash>/.
//   2. Reload reads from disk without re-rastering — set the raster-count
//      instrument to zero, force a re-resolve of the same frames, assert the
//      count stays 0 (disk hits or L0 hits, no fresh raster).
//   3. GC removes an orphan hash dir — change the layer's color prop (which
//      changes the cacheKey → new hash dir), run gcRasterDirs with only the
//      new key, assert the old dir is gone from disk.
//
// Harness: WebdriverIO + tauri-driver + msedgedriver (see wdio.conf.mjs).
// Drive: browser.execute / browser.executeAsync via window.__weftcutTest hooks
// (installed only when VITE_WEFTCUT_E2E=1; see src/testhook/e2eHook.ts).
// Workspace: created under os.tmpdir() and discarded on next OS reboot.

const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-prebake-proj");

// Countdown template: 480×480, 5 s at 30 fps → 150 content frames.
// A full bake writes exactly `contentDurationFrames` PNGs.
const TEMPLATE_ID = "countdown";
const DURATION_US = 5_000_000; // 5 s
const CONTENT_FRAMES = 150; // Math.round(5 * 30)

describe("L2 template pre-bake disk round-trip (real WebView2)", function () {
  let projectLayerId = null;
  let firstHashName = null;

  // ── helpers ───────────────────────────────────────────────────────────────

  async function waitForHook(hookName) {
    await browser.waitUntil(
      async () =>
        await browser.execute(
          (n) => typeof window.__weftcutTest?.[n] === "function",
          hookName,
        ),
      { timeout: 30000, timeoutMsg: `hook ${hookName} never installed` },
    );
  }

  async function waitForApp() {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30000, timeoutMsg: "never reached readyState=complete" },
    );
    // Bootstrap hook is installed first via the Root useEffect.
    await waitForHook("newProjectAndEnter");
  }

  // ── suite setup ───────────────────────────────────────────────────────────

  before(async () => {
    await waitForApp();

    // 1) Create a 480×480 / 30 fps project (matches countdown's natural size).
    const r1 = await browser.executeAsync((parent, done) => {
      window.__weftcutTest
        .newProjectAndEnter({
          parentFolder: parent,
          name: "e2e-prebake-" + Date.now(),
          canvas: { width: 480, height: 480, fpsNum: 30, fpsDen: 1 },
        })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, PROJECT_PARENT);
    if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);

    // 2) Wait for the App-side hooks (installed after the editor mounts).
    await waitForHook("addTemplateLayer");
    await waitForHook("prebakeLayerAndWait");

    // 3) Add a countdown template layer and record its layerId.
    const r2 = await browser.executeAsync((templateId, durationUs, done) => {
      window.__weftcutTest
        .addTemplateLayer({ templateId, durationUs })
        .then((layerId) => done({ ok: true, layerId }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, TEMPLATE_ID, DURATION_US);

    if (!r2.ok) throw new Error("addTemplateLayer failed: " + r2.error);
    projectLayerId = r2.layerId;
    console.log(`[e2e] added countdown template layer: ${projectLayerId}`);
  });

  // ── TEST 1: bake writes PNGs ───────────────────────────────────────────────

  it("bake writes PNG files to Cache/raster/<hash>/ on disk", async () => {
    if (!projectLayerId) throw new Error("setup: no layer id");

    // Request the bake and wait for ALL content frames to appear.
    // The baker's idle loop runs in batches of 2 per tick; 150 frames will
    // take ~75 idle callbacks. The 90 s timeout is generous for slow machines.
    const r = await browser.executeAsync((layerId, expectedFrames, done) => {
      window.__weftcutTest
        .prebakeLayerAndWait({ layerId, expectedFrames, timeoutMs: 90000 })
        .then((result) => done({ ok: true, ...result }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, projectLayerId, CONTENT_FRAMES);

    if (!r.ok) throw new Error("prebakeLayerAndWait failed: " + r.error);

    firstHashName = r.hashName;

    // All content frames baked.
    expect(r.pngCount).toBeGreaterThanOrEqual(CONTENT_FRAMES);

    // The hash dir name is an 8-char lowercase hex string (FNV-1a 32-bit).
    expect(r.hashName).toMatch(/^[0-9a-f]{8}$/);

    console.log(`[e2e] bake wrote ${r.pngCount} PNGs to ${r.hashDir}`);
  });

  // ── TEST 2: disk hit skips re-raster ─────────────────────────────────────

  it("re-resolving baked frames reads from disk/L0 without fresh rasters", async () => {
    if (!projectLayerId) throw new Error("setup: no layer id");
    if (!firstHashName) throw new Error("test 1 must pass first (bake not confirmed on disk)");

    // The raster-count instrument (`window.__weftcutTemplatePerf`) counts every
    // call to the real `rasterTemplateFrame` (harness render + SVG rasterize).
    // After a bake the frames are in L0 (baker calls `warm`) OR on disk (baker
    // calls `persist`). Either path — L0 hit or disk PNG → `createImageBitmap`
    // — must NOT call `rasterTemplateFrame`. We set the counter to 0, resolve
    // several frames via the sprite path, and assert the counter stays at 0.

    const r = await browser.executeAsync((done) => {
      // Arm the raster counter BEFORE resolving.
      window.__weftcutTemplatePerf = { renders: 0 };

      // Drive the REAL TemplateSprite update path (same function the compositor
      // calls) across 5 distinct layer-relative times. Each call internally
      // reaches resolveTemplateFrame → disk-first or L0; neither calls
      // rasterTemplateFrame for a frame that's already baked/cached.
      window.__weftcutTest
        .renderTemplateSpriteFrames({
          templateId: "countdown",
          fpsNum: 30,
          fpsDen: 1,
          durationUs: 5_000_000,
          times: [
            { tInLayerUs: 0 },
            { tInLayerUs: 500_000 },
            { tInLayerUs: 1_000_000 },
            { tInLayerUs: 2_500_000 },
            { tInLayerUs: 4_000_000 },
          ],
          props: {},
        })
        .then((frames) => {
          const renders = window.__weftcutTemplatePerf?.renders ?? -1;
          window.__weftcutTemplatePerf = undefined;
          done({ ok: true, renders, frameCount: frames.length });
        })
        .catch((e) => {
          window.__weftcutTemplatePerf = undefined;
          done({ ok: false, error: String(e) });
        });
    });

    if (!r.ok) throw new Error("renderTemplateSpriteFrames (disk-hit check) failed: " + r.error);

    expect(r.frameCount).toBe(5);
    // Any fresh raster is a regression: it means a frame was neither in L0
    // nor read from the baked PNGs on disk.
    expect(r.renders).toBe(0);

    console.log(`[e2e] disk-hit check: ${r.renders} fresh rasters for ${r.frameCount} frames (expected 0)`);
  });

  // ── TEST 3: GC removes orphan hash dir after a prop change ────────────────

  it("GC removes orphan hash dir after a template prop change", async () => {
    if (!projectLayerId) throw new Error("setup: no layer id");
    if (!firstHashName) throw new Error("test 1 must pass first (firstHashName not recorded)");

    // Change the `color` prop — it's part of `canonicalProps` in the cacheKey
    // input, so the FNV-1a hash of the new key will differ from `firstHashName`.
    const patchR = await browser.executeAsync((layerId, done) => {
      window.__weftcutTest
        .patchTemplateLayerProps({ layerId, props: { color: "#00ff99" } })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, projectLayerId);

    if (!patchR.ok) throw new Error("patchTemplateLayerProps failed: " + patchR.error);

    // Compute the new cacheKey (after the prop change).
    const newKeyR = await browser.executeAsync((layerId, done) => {
      window.__weftcutTest
        .cacheKeyForLayer(layerId)
        .then((ck) => done({ ok: true, cacheKey: ck }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, projectLayerId);

    if (!newKeyR.ok) throw new Error("cacheKeyForLayer failed: " + newKeyR.error);
    if (!newKeyR.cacheKey) throw new Error("cacheKeyForLayer returned null");

    console.log(`[e2e] GC test: old hash=${firstHashName}, new cacheKey computed`);

    // Run GC with ONLY the new cacheKey as active. The old `firstHashName` dir
    // is now unreferenced → it should be removed.
    const gcR = await browser.executeAsync((newCacheKey, done) => {
      window.__weftcutTest
        .gcRasterDirs([newCacheKey])
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, newKeyR.cacheKey);

    if (!gcR.ok) throw new Error("gcRasterDirs failed: " + gcR.error);

    // Assert the old hash dir is gone.
    const afterR = await browser.executeAsync((done) => {
      window.__weftcutTest
        .listBakedHashDirs()
        .then((dirs) => done({ ok: true, dirs }))
        .catch((e) => done({ ok: false, error: String(e) }));
    });

    if (!afterR.ok) throw new Error("listBakedHashDirs failed: " + afterR.error);

    console.log(`[e2e] GC: dirs after = ${JSON.stringify(afterR.dirs)}, evicted = ${firstHashName}`);

    // The old hash dir must be absent after GC.
    expect(afterR.dirs).not.toContain(firstHashName);

    // Note: the new hash dir doesn't exist yet (no bake was triggered for the
    // new cacheKey). That's expected — this test only asserts GC correctness.
  });
});
