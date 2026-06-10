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
import os from "node:os";
import path from "node:path";
import { writeUserMotif, removeUserMotif } from "./helpers/userMotifFs.mjs";

const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-motif-watch-proj");
const MOTIF_ID = "e2e-watch";
const RED = "#e02424";
const GREEN = "#1ea64a";

async function waitForHook(name) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        (n) => typeof window.__weftcutTest?.[n] === "function",
        name,
      )) === true,
    { timeout: 30000, timeoutMsg: `${name} hook never mounted` },
  );
}

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

describe("motif file watch (real WebView2)", function () {
  before(async () => {
    await waitForHook("newProjectAndEnter");
  });

  after(() => removeUserMotif(MOTIF_ID));

  it("a disk-placed user Motif renders, and an external rewrite hot-reloads it", async () => {
    // 1) Write the Motif DIRECTLY to disk while the app is running.
    writeUserMotif({ id: MOTIF_ID, version: 1, color: RED });

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
    }, PROJECT_PARENT);
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
    }, MOTIF_ID);
    if (!added.ok) throw new Error("addMotifLayer failed: " + added.error);

    // 4) The placed layer renders the RED box.
    await waitForCenter(
      (p) => p.a > 200 && p.r > 150 && p.g < 100,
      "initial red render",
    );

    // 5) EXTERNAL EDIT: same id, same version, new color. No app command —
    //    only the file watcher can deliver this change.
    writeUserMotif({ id: MOTIF_ID, version: 1, color: GREEN });

    // 6) Hot reload: the composite turns green with NO UI action.
    await waitForCenter(
      (p) => p.a > 200 && p.g > 120 && p.r < 100,
      "hot-reloaded green render",
    );
  });
});
