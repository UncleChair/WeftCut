// ONE-OFF isolation experiment (NOT a gate): does WebView2 honor
// VideoFrame.colorSpace.matrix / fullRange in its VideoFrame->RGB conversion?
// Construct synthetic I420 frames with IDENTICAL YUV bytes, tag them differently,
// draw to a 2D canvas, read back RGB. Differ => honored; same => ignored.
//   npx wdio run wdio.conf.mjs --spec ./tools/color_isolation_canvas.e2e.js
describe("color conversion honoring (real WebView2, one-off)", function () {
  it("reports matrix + range honoring in VideoFrame->canvas conversion", async function () {
    await browser.waitUntil(
      async () => (await browser.execute(() => typeof VideoFrame === "function")) === true,
      { timeout: 30000, timeoutMsg: "VideoFrame global never available" },
    );

    const result = await browser.execute(() => {
      // Build a flat 16x16 I420 frame with constant Y/Cb/Cr, tag it, draw to a
      // 2D canvas, return the center pixel RGB.
      function sample(y, cb, cr, cs) {
        const W = 16, H = 16, ySize = W * H, cSize = (W / 2) * (H / 2);
        const data = new Uint8Array(ySize + 2 * cSize);
        data.fill(y, 0, ySize);
        data.fill(cb, ySize, ySize + cSize);
        data.fill(cr, ySize + cSize);
        let vf;
        try {
          vf = new VideoFrame(data, {
            format: "I420", codedWidth: W, codedHeight: H, timestamp: 0, colorSpace: cs,
          });
        } catch (e) {
          return { error: "VideoFrame ctor: " + String(e) };
        }
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        try {
          ctx.drawImage(vf, 0, 0);
        } catch (e) {
          vf.close();
          return { error: "drawImage: " + String(e) };
        }
        vf.close();
        const d = ctx.getImageData(W / 2, H / 2, 1, 1).data;
        return { rgb: [d[0], d[1], d[2]] };
      }
      const c601 = { matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m", fullRange: false };
      const c709 = { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false };
      const c709full = { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: true };
      // Matrix probe: chromatic YUV (Y=128, Cb=128, Cr=240) — the G channel
      // differs ~32 codes between 601 (~39) and 709 (~71) if the matrix is honored.
      const matrix601 = sample(128, 128, 240, c601);
      const matrix709 = sample(128, 128, 240, c709);
      // Range probe: near-white gray (Y=235, Cb=Cr=128) — limited maps to ~255,
      // full maps to ~235 (~20 codes) if fullRange is honored.
      const rangeLtd = sample(235, 128, 128, c709);
      const rangeFull = sample(235, 128, 128, c709full);
      return { matrix601, matrix709, rangeLtd, rangeFull, ua: navigator.userAgent };
    });

    console.log("[iso] userAgent:", result.ua);
    console.log("[iso] matrix601 (smpte170m):", JSON.stringify(result.matrix601));
    console.log("[iso] matrix709 (bt709)    :", JSON.stringify(result.matrix709));
    console.log("[iso] rangeLtd (tv)        :", JSON.stringify(result.rangeLtd));
    console.log("[iso] rangeFull (pc)       :", JSON.stringify(result.rangeFull));

    const m601 = result.matrix601.rgb, m709 = result.matrix709.rgb;
    const rL = result.rangeLtd.rgb, rF = result.rangeFull.rgb;
    if (m601 && m709) {
      const gDiff = Math.abs(m601[1] - m709[1]);
      console.log(`[iso] MATRIX honored? G(601)=${m601[1]} vs G(709)=${m709[1]} diff=${gDiff} -> ${gDiff > 8 ? "HONORED" : "IGNORED"}`);
    }
    if (rL && rF) {
      const vDiff = Math.abs(rL[0] - rF[0]);
      console.log(`[iso] RANGE honored?  R(tv)=${rL[0]} vs R(pc)=${rF[0]} diff=${vDiff} -> ${vDiff > 8 ? "HONORED" : "IGNORED"}`);
    }
    // Diagnostic only — always passes; the console lines carry the finding.
    expect(true).toBe(true);
  });
});
