// §7-B cross-project staleness through the REAL app in real WebView2:
//   project P1 places a user Motif at v1 → the Motif's island version is
//   bumped to v2 ON DISK (the state an Update from another project leaves
//   behind) → reopening P1 surfaces the one-time MotifStaleDialog (v1 → v2,
//   2 layers) → dismissing acknowledges (markers bump in one undo entry,
//   then the reopen-hook's save persists them) → reopening again is quiet.
import os from "node:os";
import path from "node:path";
import { writeUserMotif, removeUserMotif } from "./helpers/userMotifFs.mjs";

const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-motif-stale-proj");
const MOTIF_ID = "e2e-stale";
const DIALOG = ".motif-stale-dialog";

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

async function reopen(projectPath) {
  const r = await browser.executeAsync((p, done) => {
    window.__weftcutTest
      .motifReopenProject({ path: p })
      .then(() => done({ ok: true }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, projectPath);
  if (!r.ok) throw new Error("motifReopenProject failed: " + r.error);
}

describe("motif staleness notice (real WebView2)", function () {
  before(async () => {
    await waitForHook("newProjectAndEnter");
  });

  after(() => removeUserMotif(MOTIF_ID));

  it("v1-placed layers surface v1→v2 on reopen; dismiss acknowledges once", async () => {
    writeUserMotif({ id: MOTIF_ID, version: 1, color: "#e02424" });

    const projectName = "e2e-motif-stale-" + Date.now();
    const projectPath = path.join(PROJECT_PARENT, projectName);
    const r1 = await browser.executeAsync((parent, name, done) => {
      window.__weftcutTest
        .newProjectAndEnter({
          parentFolder: parent,
          name,
          canvas: { width: 320, height: 320, fpsNum: 30, fpsDen: 1 },
        })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, PROJECT_PARENT, projectName);
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
      }, MOTIF_ID);
      if (!a.ok) throw new Error("addMotifLayer failed: " + a.error);
    }

    // Freshly placed = current version → no dialog now.
    expect(await $(DIALOG).isExisting()).toBe(false);

    // The "another project updated it" moment: the version bumps on disk.
    writeUserMotif({ id: MOTIF_ID, version: 2, color: "#1ea64a" });

    // Reopen P1 → App remounts → the on-mount check fires → dialog.
    await reopen(projectPath);
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
    await reopen(projectPath);
    await waitForHook("addMotifLayer");
    await browser.pause(3000);
    expect(await $(DIALOG).isExisting()).toBe(false);
  });
});
