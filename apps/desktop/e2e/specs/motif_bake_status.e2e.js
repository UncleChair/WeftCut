import os from "node:os";
import path from "node:path";

// Real-WebView2 end-to-end gate for the per-motif-layer bake-status dot.
//
// Asserts that:
//   - Before a pre-bake the .motif-bake-dot span is absent from the DOM
//     (phase is idle → MotifBakeDot returns null).
//   - After prebakeLayerAndWait resolves the span gains .is-ready within 15 s
//     (Compositor.recomputeBakeStatuses picks up the baker's "ready" status and
//     setLayerBakeStatuses → React re-render shows the dot).
//   - No .is-error dot is present after a successful bake.
//
// Harness: WebdriverIO + tauri-driver + msedgedriver (see wdio.conf.mjs).
// Drive: browser.execute / browser.executeAsync via window.__weftcutTest hooks.
//
// "before = 0" robustness: PROJECT_PARENT embeds Date.now() so each run lands
// in a fresh OS-tmp sub-dir. The cacheKey is derived from (motifId,
// canonicalProps, dims) — a fresh parent folder means no PNGs exist on disk
// from prior runs, so the dot is genuinely absent at the start.

const PROJECT_PARENT = path.resolve(
  os.tmpdir(),
  `weftcut-e2e-bakestatus-proj-${Date.now()}`,
);

const MOTIF_ID = "countdown";
const DURATION_US = 5_000_000; // 5 s
const CONTENT_FRAMES = 150;    // Math.round(5 * 30)

describe("motif bake-status dot (real WebView2)", function () {
  let layerId = null;

  // ── helpers ────────────────────────────────────────────────────────────────

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

  // ── suite setup ────────────────────────────────────────────────────────────

  before(async () => {
    await waitForApp();

    // Create a 480×480 / 30 fps project under a per-run unique parent dir so
    // no prior disk bake can make the "before" assertion flaky.
    const r1 = await browser.executeAsync((parent, done) => {
      window.__weftcutTest
        .newProjectAndEnter({
          parentFolder: parent,
          name: "e2e-bakestatus-" + Date.now(),
          canvas: { width: 480, height: 480, fpsNum: 30, fpsDen: 1 },
        })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, PROJECT_PARENT);
    if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);

    // Wait for the editor-mounted hooks before adding a layer.
    await waitForHook("addMotifLayer");
    await waitForHook("prebakeLayerAndWait");

    const r2 = await browser.executeAsync((motifId, durationUs, done) => {
      window.__weftcutTest
        .addMotifLayer({ motifId, durationUs })
        .then((id) => done({ ok: true, id }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, MOTIF_ID, DURATION_US);
    if (!r2.ok) throw new Error("addMotifLayer failed: " + r2.error);

    layerId = r2.id;
    console.log(`[e2e] added countdown motif layer: ${layerId}`);
  });

  // ── TEST: idle → ready ────────────────────────────────────────────────────

  it("shows no dot before pre-bake, then a ready dot after baking", async () => {
    if (!layerId) throw new Error("setup: no layer id");

    // Phase is idle → MotifBakeDot returns null → no span in the DOM.
    const before = await browser.execute(
      () => document.querySelectorAll(".motif-bake-dot").length,
    );
    expect(before).toBe(0);

    // Trigger the bake and wait for all content PNGs to land on disk (≤ 90 s).
    const r = await browser.executeAsync((id, frames, done) => {
      window.__weftcutTest
        .prebakeLayerAndWait({ layerId: id, expectedFrames: frames, timeoutMs: 90000 })
        .then((res) => done({ ok: true, ...res }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, layerId, CONTENT_FRAMES);
    if (!r.ok) throw new Error("prebakeLayerAndWait failed: " + r.error);

    console.log(`[e2e] bake complete: ${r.pngCount} PNGs at ${r.hashDir}`);

    // The baker emits a "ready" status via onStatus → Compositor.bakeStatusByCacheKey
    // → recomputeBakeStatuses → setLayerBakeStatuses → React re-render.
    // The waitUntil (15 s) covers any React scheduling delay.
    await browser.waitUntil(
      async () =>
        await browser.execute(
          () => !!document.querySelector(".motif-bake-dot.is-ready"),
        ),
      { timeout: 15000, timeoutMsg: ".motif-bake-dot.is-ready never appeared" },
    );

    // No error dot should be present.
    const errCount = await browser.execute(
      () => document.querySelectorAll(".motif-bake-dot.is-error").length,
    );
    expect(errCount).toBe(0);

    console.log("[e2e] bake-status dot: is-ready confirmed, no is-error");
  });
});
