// Merged state-group motif specs:
//   1. motif_staleness   — cross-project staleness notice (MotifStaleDialog)
//   2. motif_bake_status — per-layer bake-status dot (idle → ready)
//   3. motif_filewatch   — file watch hot reload (place-after-boot + hot-reload)

import os from "node:os";
import path from "node:path";
import { waitForHook } from "../../helpers/app.mjs";
import { writeUserMotif, removeUserMotif } from "../helpers/userMotifFs.mjs";

// ── motif_staleness constants ─────────────────────────────────────────────────

const STALE_PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-motif-stale-proj");
const STALE_MOTIF_ID = "e2e-stale";
const DIALOG = ".motif-stale-dialog";

// ── motif_bake_status constants ───────────────────────────────────────────────

const BAKE_PROJECT_PARENT = path.resolve(
  os.tmpdir(),
  `weftcut-e2e-bakestatus-proj-${Date.now()}`,
);
const BAKE_MOTIF_ID = "countdown";
const DURATION_US = 5_000_000; // 5 s
const CONTENT_FRAMES = 150;    // Math.round(5 * 30)

// ── motif_filewatch constants ─────────────────────────────────────────────────

const WATCH_PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-motif-watch-proj");
const WATCH_MOTIF_ID = "e2e-watch";
const RED = "#e02424";
const GREEN = "#1ea64a";

// ── Describe 1: motif staleness notice ───────────────────────────────────────
//
// §7-B cross-project staleness through the REAL app in real WebView2:
//   project P1 places a user Motif at v1 → the Motif's island version is
//   bumped to v2 ON DISK (the state an Update from another project leaves
//   behind) → reopening P1 surfaces the one-time MotifStaleDialog (v1 → v2,
//   2 layers) → dismissing acknowledges (markers bump in one undo entry,
//   then the reopen-hook's save persists them) → reopening again is quiet.

describe("motif staleness notice (real WebView2)", function () {
  before(async () => {
    await waitForHook("newProjectAndEnter");
  });

  after(() => removeUserMotif(STALE_MOTIF_ID));

  it("v1-placed layers surface v1→v2 on reopen; dismiss acknowledges once", async () => {
    writeUserMotif({ id: STALE_MOTIF_ID, version: 1, color: "#e02424" });

    const projectName = "e2e-motif-stale-" + Date.now();
    const projectPath = path.join(STALE_PROJECT_PARENT, projectName);
    const r1 = await browser.executeAsync((parent, name, done) => {
      window.__weftcutTest
        .newProjectAndEnter({
          parentFolder: parent,
          name,
          canvas: { width: 320, height: 320, fpsNum: 30, fpsDen: 1 },
        })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, STALE_PROJECT_PARENT, projectName);
    if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);
    await waitForHook("addMotifLayer");
    await waitForHook("motifReopenProject");

    // Two layers at v1 (each add_motif call gets its own Overlay track, so
    // t=0 twice doesn't collide) → the report should read "2 layers".
    for (let i = 0; i < 2; i++) {
      const a = await browser.executeAsync((id, done) => {
        window.__weftcutTest
          .addMotifLayer({ motifId: id, durationUs: 2_000_000 })
          .then((layerId) => done({ ok: true, layerId }))
          .catch((e) => done({ ok: false, error: String(e) }));
      }, STALE_MOTIF_ID);
      if (!a.ok) throw new Error("addMotifLayer failed: " + a.error);
    }

    // Freshly placed = current version → no dialog now.
    expect(await $(DIALOG).isExisting()).toBe(false);

    // The "another project updated it" moment: the version bumps on disk.
    writeUserMotif({ id: STALE_MOTIF_ID, version: 2, color: "#1ea64a" });

    // Reopen P1 → App remounts → the on-mount check fires → dialog.
    const rr = await browser.executeAsync((p, done) => {
      window.__weftcutTest
        .motifReopenProject({ path: p })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, projectPath);
    if (!rr.ok) throw new Error("motifReopenProject failed: " + rr.error);
    await browser.waitUntil(async () => $(DIALOG).isExisting(), {
      timeout: 20000,
      timeoutMsg: "stale dialog never appeared",
    });
    const text = await $(DIALOG).getText();
    if (!/v1\s*→\s*v2/.test(text)) {
      throw new Error("dialog text missing v1 → v2: " + text);
    }
    if (!text.includes("2")) {
      throw new Error("dialog text missing the layer count: " + text);
    }

    // Dismiss = acknowledge. The dialog awaits the ack IPC before closing,
    // so its disappearance means the markers are bumped in the actor.
    await $(`${DIALOG} header button`).click();
    await browser.waitUntil(async () => !(await $(DIALOG).isExisting()), {
      timeout: 10000,
      timeoutMsg: "stale dialog never dismissed",
    });

    // Reopen again (the hook saves first → bumped markers are on disk):
    // acknowledged → quiet. Give the on-mount check a beat to (not) fire.
    const rr2 = await browser.executeAsync((p, done) => {
      window.__weftcutTest
        .motifReopenProject({ path: p })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, projectPath);
    if (!rr2.ok) throw new Error("motifReopenProject failed: " + rr2.error);
    await waitForHook("addMotifLayer");
    await browser.pause(3000);
    expect(await $(DIALOG).isExisting()).toBe(false);
  });
});

// ── Describe 2: motif bake-status dot ────────────────────────────────────────
//
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
// "before = 0" robustness: BAKE_PROJECT_PARENT embeds Date.now() so each run
// lands in a fresh OS-tmp sub-dir. The cacheKey is derived from (motifId,
// canonicalProps, dims) — a fresh parent folder means no PNGs exist on disk
// from prior runs, so the dot is genuinely absent at the start.

describe("motif bake-status dot (real WebView2)", function () {
  let layerId = null;

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
    }, BAKE_PROJECT_PARENT);
    if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);

    // Wait for the editor-mounted hooks before adding a layer.
    await waitForHook("addMotifLayer");
    await waitForHook("prebakeLayerAndWait");

    const r2 = await browser.executeAsync((motifId, durationUs, done) => {
      window.__weftcutTest
        .addMotifLayer({ motifId, durationUs })
        .then((id) => done({ ok: true, id }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, BAKE_MOTIF_ID, DURATION_US);
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

// ── Describe 3: motif file watch ──────────────────────────────────────────────
//
// Stage-5 file watch (hot reload) through the REAL app in real WebView2:
//   1. Place-after-boot — a user Motif written DIRECTLY to disk (no app
//      command) while the app runs becomes placeable AND renders in the live
//      preview. The disk write reaches the TS catalog via: notify watcher →
//      debounced `motifs:changed` → syncCatalog. (Before Stage 5 this needed
//      a picker visit to refresh the catalog.)
//   2. Hot reload — rewriting the SAME file on disk (same id, same version,
//      new color) re-renders the placed layer with no UI action:
//      watcher → motifs:changed → content_hash changes → frame-cache bust +
//      `?v=` host reload → CDP recapture.

describe("motif file watch (real WebView2)", function () {
  async function sampleCenter() {
    return browser.executeAsync((done) => {
      window.__weftcutTest
        .weftcutSampleComposite(160, 160)
        .then((p) => done({ ok: true, r: p.r, g: p.g, b: p.b, a: p.a }))
        .catch((e) => done({ ok: false, error: String(e) }));
    });
  }

  /// Poll the live composite until `predicate(px)` holds. Re-seek each round:
  /// cold CDP capture (~11 fps single host) + the async bind path need a real
  /// settle window, and a paused stale frame must not starve the bind. The seek
  /// hook throws synchronously until PixiPreview registers its bridge (it
  /// mounts async after App) — swallow that and keep polling.
  async function waitForCenter(predicate, label) {
    const deadline = Date.now() + 60000;
    let last = null;
    while (Date.now() < deadline) {
      await browser.execute(() => {
        try {
          window.__weftcutTest.weftcutSeekUs(500_000);
        } catch {
          // preview bridge not registered yet — next round retries
        }
      });
      await browser.pause(800);
      last = await sampleCenter();
      if (last.ok && predicate(last)) return last;
    }
    throw new Error(`${label}: composite never matched; last=${JSON.stringify(last)}`);
  }

  before(async () => {
    await waitForHook("newProjectAndEnter");
  });

  after(() => removeUserMotif(WATCH_MOTIF_ID));

  it("a disk-placed user Motif renders, and an external rewrite hot-reloads it", async () => {
    // 1) Write the Motif DIRECTLY to disk while the app is running.
    writeUserMotif({ id: WATCH_MOTIF_ID, version: 1, color: RED });

    // 2) 320×320 project so the Motif fills the frame (center pixel = box).
    const r1 = await browser.executeAsync((parent, done) => {
      window.__weftcutTest
        .newProjectAndEnter({
          parentFolder: parent,
          name: "e2e-motif-watch-" + Date.now(),
          canvas: { width: 320, height: 320, fpsNum: 30, fpsDen: 1 },
        })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, WATCH_PROJECT_PARENT);
    if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);
    await waitForHook("addMotifLayer");
    await waitForHook("weftcutSampleComposite");

    // 3) Place it. `add_motif` resolves the id straight from the Rust store
    //    (disk read), and the TS frame math knows it because the watcher's
    //    motifs:changed already synced the runtime catalog — no picker visit.
    const added = await browser.executeAsync((id, done) => {
      window.__weftcutTest
        .addMotifLayer({ motifId: id, durationUs: 2_000_000 })
        .then((layerId) => done({ ok: true, layerId }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, WATCH_MOTIF_ID);
    if (!added.ok) throw new Error("addMotifLayer failed: " + added.error);

    // 4) The placed layer renders the RED box.
    await waitForCenter(
      (p) => p.a > 200 && p.r > 150 && p.g < 100,
      "initial red render",
    );

    // 5) EXTERNAL EDIT: same id, same version, new color. No app command —
    //    only the file watcher can deliver this change.
    writeUserMotif({ id: WATCH_MOTIF_ID, version: 1, color: GREEN });

    // 6) Hot reload: the composite turns green with NO UI action.
    await waitForCenter(
      (p) => p.a > 200 && p.g > 120 && p.r < 100,
      "hot-reloaded green render",
    );
  });
});
