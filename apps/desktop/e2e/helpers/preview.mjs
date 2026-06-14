/// Live-preview sampling helpers. Wrap wdio's global `browser`.

/// Seek the live preview to an absolute time (µs).
export async function seekUs(tUs) {
  await browser.execute((t) => window.__weftcutTest.weftcutSeekUs(t), tUs);
}

/// Sample the composited pixel at (x,y). Re-seeks first so a paused stale frame
/// can't mask an async composite update; settles `settleMs` after the seek.
export async function sampleAt(tUs, x, y, settleMs = 300) {
  await seekUs(tUs);
  await browser.pause(settleMs);
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

/// Wait until the preview bridge (weftcutSampleComposite) is registered and live.
/// Only registers once PixiPreview mounts (timeline non-empty) — call AFTER a
/// layer has been added.
export async function waitPreviewBridge(timeout = 30000) {
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
    { timeout, timeoutMsg: "preview bridge never registered" },
  );
}
