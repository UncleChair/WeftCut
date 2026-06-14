import { waitForHook } from "./app.mjs";

/// Drive an export hook fire-and-forget and poll the mirrored export state until
/// it settles. Returns { done, lastFrame, lastKind, lastDetail } WITHOUT throwing
/// on export failure. `args` is forwarded verbatim to the hook. The export hook
/// is `exportClip` by default; pass `hook: "exportTimeline"` or
/// `hook: "exportMotifClip"` for those entry points (all three mirror the same
/// window.__weftcutExportState / __e2eExportDone state). Logs each frame/phase
/// advance so a hang reports the exact stall frame instead of a blind timeout.
export async function driveExport(args, { hook = "exportClip", timeout = 170000, label = "" } = {}) {
  await waitForHook(hook);
  await browser.execute(
    (h, a) => {
      window.__e2eExportDone = null;
      window.__weftcutTest[h](a)
        .then(() => {
          window.__e2eExportDone = { ok: true };
        })
        .catch((e) => {
          window.__e2eExportDone = { ok: false, error: String(e) };
        });
    },
    hook,
    args,
  );

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
