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
const MOTIF_ID = "countdown";
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
    await waitForHook("addMotifLayer");
    await waitForHook("prebakeLayerAndWait");

    // 3) Add a countdown template layer and record its layerId.
    const r2 = await browser.executeAsync((motifId, durationUs, done) => {
      window.__weftcutTest
        .addMotifLayer({ motifId, durationUs })
        .then((layerId) => done({ ok: true, layerId }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, MOTIF_ID, DURATION_US);

    if (!r2.ok) throw new Error("addMotifLayer failed: " + r2.error);
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

    // Exactly the content-frame count — the baker writes one PNG per frame.
    expect(r.pngCount).toBe(CONTENT_FRAMES);

    // The hash dir name is an 8-char lowercase hex string (FNV-1a 32-bit).
    expect(r.hashName).toMatch(/^[0-9a-f]{8}$/);

    console.log(`[e2e] bake wrote ${r.pngCount} PNGs to ${r.hashDir}`);
  });

  // ── TEST 2: disk hit skips re-raster ─────────────────────────────────────

  it("reload reads from disk without re-rastering", async () => {
    if (!projectLayerId) throw new Error("setup: no layer id");
    if (!firstHashName) throw new Error("test 1 must pass first (bake not confirmed on disk)");

    // Step A: resolve the cacheKey for this layer (needed for the L0 eviction
    // and baked-index assertion below).
    const keyR = await browser.executeAsync((layerId, done) => {
      window.__weftcutTest
        .cacheKeyForLayer(layerId)
        .then((ck) => done({ ok: true, cacheKey: ck }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, projectLayerId);

    if (!keyR.ok) throw new Error("cacheKeyForLayer failed: " + keyR.error);
    if (!keyR.cacheKey) throw new Error("cacheKeyForLayer returned null — layer not found");

    const cacheKey = keyR.cacheKey;
    console.log(`[e2e] disk-hit check: cacheKey resolved (len=${cacheKey.length})`);

    // Step B: evict every L0 (in-RAM) frame for this cacheKey. Without this,
    // the baker's `warm` pass already filled L0 with all 150 frames (cap 240),
    // so the renders===0 assertion would be satisfied by L0 hits — never
    // exercising the actual disk read path. After this call, a resolve MUST
    // either read from disk (L2) or trigger a fresh raster.
    const evictR = await browser.execute((ck) => {
      try {
        window.__weftcutTest.clearMotifCacheKey(ck);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, cacheKey);

    if (!evictR.ok) throw new Error("clearMotifCacheKey failed: " + evictR.error);
    console.log("[e2e] L0 evicted for cacheKey");

    // Step C: assert the baked-key index marks this cacheKey as baked. If it
    // doesn't, the `resolveMotifFrame` disk branch is never entered and the
    // test would rely on fallback rasters — a loud fail here is correct.
    const indexR = await browser.execute((ck) => {
      return window.__weftcutTest.bakedIndexHas(ck);
    }, cacheKey);

    if (!indexR) {
      throw new Error(
        "bakedIndexHas returned false — sharedBakedKeyIndex was not populated by the baker. " +
          "The disk-read branch in resolveMotifFrame cannot be entered. " +
          "This is a real product bug: the baked-key index is not being updated after writePng."
      );
    }
    console.log("[e2e] baked-key index confirms cacheKey is marked baked");

    // Step D: arm the raster counter, then resolve frames. With L0 cleared and
    // the baked-key index populated, resolveMotifFrame MUST take the disk
    // path (readPng → createImageBitmap). Any fresh raster (renders > 0) means
    // the disk read path is broken.
    //
    // The async settle: renderMotifSpriteFrames already awaits each
    // captureAndBind to completion before resolving its promise (it polls until
    // the sprite's texture resource changes or onLoaded fires, with a 10 s
    // deadline). With L0 cleared the bind is always async (disk read), so the
    // per-time waiter inside that hook guarantees all disk reads finish before
    // the promise resolves — reads the counter only after all frames settle.
    const r = await browser.executeAsync((done) => {
      // Arm the raster counter BEFORE resolving.
      window.__weftcutMotifPerf = { renders: 0 };

      // Drive the REAL TemplateSprite update path (same function the compositor
      // calls) across 5 distinct layer-relative times. Each call internally
      // reaches resolveMotifFrame → disk PNG → createImageBitmap.
      window.__weftcutTest
        .renderMotifSpriteFrames({
          motifId: "countdown",
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
          const renders = window.__weftcutMotifPerf?.renders ?? -1;
          window.__weftcutMotifPerf = undefined;
          done({ ok: true, renders, frameCount: frames.length });
        })
        .catch((e) => {
          window.__weftcutMotifPerf = undefined;
          done({ ok: false, error: String(e) });
        });
    });

    if (!r.ok) throw new Error("renderMotifSpriteFrames (disk-hit check) failed: " + r.error);

    expect(r.frameCount).toBe(5);
    // Any fresh raster is a regression: L0 was cleared and the baked-key index
    // confirmed the frames are on disk — renders > 0 means disk reads are broken.
    expect(r.renders).toBe(0);

    console.log(`[e2e] disk-hit check: ${r.renders} fresh rasters for ${r.frameCount} frames (expected 0, L0 was cleared)`);
  });

  // ── TEST 3: GC removes orphan hash dir after a prop change ────────────────

  it("GC removes orphan hash dir after a template prop change", async () => {
    if (!projectLayerId) throw new Error("setup: no layer id");
    if (!firstHashName) throw new Error("test 1 must pass first (firstHashName not recorded)");

    // Change the `accent` prop — it's part of `canonicalProps` in the cacheKey
    // input, so the FNV-1a hash of the new key will differ from `firstHashName`.
    const patchR = await browser.executeAsync((layerId, done) => {
      window.__weftcutTest
        .patchMotifLayerProps({ layerId, props: { accent: "#00ff99" } })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, projectLayerId);

    if (!patchR.ok) throw new Error("patchMotifLayerProps failed: " + patchR.error);

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
