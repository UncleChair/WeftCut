// Drives the lower-third Motif and host navigation through the REAL app:
//   1. Determinism  — two captures at a held time (t=2.0 s, past the 0.8 s
//                     in-animation) are byte-identical.
//   2. Transparent  — a corner pixel outside the bar is fully transparent
//                     (proves just-the-bar geometry + CDP transparent backdrop).
//   3. Accent edge  — the 10 px left border at (69, 192) is the accent color
//                     #ff4d4d (proves font/layout rendered, non-square capture).
//   4. Navigation   — capturing `countdown` then `lower-third` in one session
//                     both succeed (the hidden host navigates between ids).

const LT_PROPS = { title: "Jane Doe", subtitle: "Director of Photography", accent: "#ff4d4d", align: "left" };
const LT_W = 1280, LT_H = 320, LT_ID = "lower-third";
const CD_PROPS = { seconds: 5, label: "GO", accent: "#ff4d4d" };
const CD_W = 480, CD_H = 480, CD_ID = "countdown";

async function capturePng(motifId, tSec, props, w, h) {
  const out = await browser.executeAsync((motifId, t, props, w, h, done) => {
    const hook = window.__weftcutTest;
    if (!hook || typeof hook.captureMotifFrame !== "function") {
      done({ ok: false, error: "captureMotifFrame hook absent" });
      return;
    }
    hook.captureMotifFrame({ motifId, tSec: t, props, width: w, height: h })
      .then((b64) => done({ ok: true, b64 }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, motifId, tSec, props, w, h);
  if (!out.ok) throw new Error(`capture(${motifId}, t=${tSec}) failed: ${out.error}`);
  return out.b64;
}

async function samplePixel(b64, cx, cy) {
  return browser.executeAsync((b64str, x, y, done) => {
    const bytes = Uint8Array.from(atob(b64str), (c) => c.charCodeAt(0));
    createImageBitmap(new Blob([bytes], { type: "image/png" }))
      .then((bitmap) => {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        const d = ctx.getImageData(x, y, 1, 1).data;
        done({ r: d[0], g: d[1], b: d[2], a: d[3] });
      })
      .catch((e) => done({ error: String(e) }));
  }, b64, cx, cy);
}

describe("lower-third motif + host navigation (real WebView2)", () => {
  before(async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30000, timeoutMsg: "never reached readyState=complete" },
    );
    await browser.waitUntil(
      async () => await browser.execute(
        () => !!(window.__weftcutTest && typeof window.__weftcutTest.captureMotifFrame === "function"),
      ),
      { timeout: 30000, timeoutMsg: "captureMotifFrame hook never installed" },
    );
  });

  it("determinism: two held captures at t=2.0 are identical", async () => {
    const a = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    const b = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    expect(a).not.toHaveLength(0);
    expect(a).toBe(b);
  });

  it("transparent: a corner pixel outside the bar is fully transparent", async () => {
    const b64 = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    const px = await samplePixel(b64, 10, 10);
    if (px.error) throw new Error("pixel sample failed: " + px.error);
    expect(px.a).toBeLessThan(10);
  });

  it("accent edge: the left border at (69,192) is the accent color", async () => {
    const b64 = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    const px = await samplePixel(b64, 69, 192);
    if (px.error) throw new Error("pixel sample failed: " + px.error);
    expect(px.r).toBeGreaterThanOrEqual(200);
    expect(px.g).toBeLessThan(150);
    expect(px.b).toBeLessThan(150);
    expect(px.a).toBeGreaterThan(200);
  });

  it("navigation: capturing countdown then lower-third in one session both succeed", async () => {
    const cd = await capturePng(CD_ID, 2.5, CD_PROPS, CD_W, CD_H);
    expect(cd).not.toHaveLength(0);
    const lt = await capturePng(LT_ID, 2.0, LT_PROPS, LT_W, LT_H);
    expect(lt).not.toHaveLength(0);
    const px = await samplePixel(lt, 69, 192);
    if (px.error) throw new Error("pixel sample failed: " + px.error);
    expect(px.r).toBeGreaterThanOrEqual(200);
    const cd2 = await capturePng(CD_ID, 1.0, CD_PROPS, CD_W, CD_H);
    expect(cd2).not.toHaveLength(0);
  });
});
