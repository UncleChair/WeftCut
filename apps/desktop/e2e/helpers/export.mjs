import { waitForHook } from "./app.mjs";

/// Drive window.__weftcutTest.exportClip(args) fire-and-forget and poll the
/// mirrored export state until it settles. Returns { done, lastFrame, lastKind,
/// lastDetail } WITHOUT throwing on export failure. `args` is forwarded verbatim
/// to exportClip. Logs each frame/phase advance so a hang reports the exact
/// stall frame instead of a blind timeout.
export async function driveExport(args, { timeout = 170000, label = "" } = {}) {
  await waitForHook("exportClip");
  await browser.execute((a) => {
    window.__e2eExportDone = null;
    window.__weftcutTest
      .exportClip(a)
      .then(() => {
        window.__e2eExportDone = { ok: true };
      })
      .catch((e) => {
        window.__e2eExportDone = { ok: false, error: String(e) };
      });
  }, args);

  const tag = label ? " " + label : "";
  let lastFrame = -1;
  let lastKind = null;
  let lastDetail = null;
  let settled = null;
  try {
    await browser.waitUntil(
      async () => {
        const snap = await browser.execute(() => {
          const st = window.__weftcutExportState;
          return {
            done: window.__e2eExportDone,
            kind: st?.kind ?? null,
            phase: st?.progress?.phase ?? null,
            frame: st?.progress?.frame ?? null,
            detail: st?.detail ?? null,
          };
        });
        if (snap.frame != null && snap.frame !== lastFrame) {
          lastFrame = snap.frame;
          console.log(`[e2e]${tag} export ${snap.kind}/${snap.phase ?? "-"} frame=${snap.frame}`);
        }
        if (snap.kind && snap.kind !== lastKind) {
          lastKind = snap.kind;
          console.log(`[e2e]${tag} export phase -> ${snap.kind}`);
        }
        if (snap.detail && snap.detail !== lastDetail) lastDetail = snap.detail;
        if (snap.done) {
          settled = snap.done;
          return true;
        }
        return false;
      },
      { timeout, interval: 1000 },
    );
  } catch (e) {
    throw new Error(
      `export never settled (last kind=${lastKind}, detail=${lastDetail}, last frame=${lastFrame}): ${e.message}`,
    );
  }
  return { done: settled, lastFrame, lastKind, lastDetail };
}
