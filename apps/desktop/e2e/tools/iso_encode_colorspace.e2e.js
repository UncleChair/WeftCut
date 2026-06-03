// ONE-OFF diagnostic (NOT a gate): the export tags EVERY output bt709 because
// the captured frame is `new VideoFrame(sRGB-canvas)` and VideoEncoderConfig has
// no colorSpace. The proposed fix re-tags the captured RGBA frame with the
// source's colorSpace so the encoder writes that matrix. Two unknowns this
// verifies in real WebView2:
//   (1) does an RGBA VideoFrame RETAIN a YUV `matrix` tag (or normalize it away)?
//   (2) does VideoEncoder HONOR the input frame's colorSpace -> output
//       metadata.decoderConfig.colorSpace + the decoded frame's colorSpace?
// Encode a flat RGBA frame tagged 601 vs 709, report both signals per case.
//   npx wdio run wdio.conf.mjs --spec ./tools/iso_encode_colorspace.e2e.js
describe("encoder colorSpace honoring via input frame tag (real WebView2, one-off)", function () {
  it("reports retained tag + encoder output colorSpace per matrix", async function () {
    await browser.waitUntil(
      async () => (await browser.execute(() => typeof VideoEncoder === "function")) === true,
      { timeout: 30000, timeoutMsg: "VideoEncoder global never available" },
    );

    const result = await browser.executeAsync((done) => {
      (async () => {
        const W = 256, H = 256;
        const csOut = (cs) =>
          cs ? { matrix: cs.matrix ?? null, primaries: cs.primaries ?? null, transfer: cs.transfer ?? null, fullRange: cs.fullRange ?? null } : null;

        async function run(cs, hw) {
          // Flat chromatic RGBA (matrix-sensitive once converted to YUV).
          const buf = new Uint8Array(W * H * 4);
          for (let i = 0; i < W * H; i++) {
            buf[i * 4] = 200; buf[i * 4 + 1] = 100; buf[i * 4 + 2] = 50; buf[i * 4 + 3] = 255;
          }
          let vf;
          try {
            vf = new VideoFrame(buf, { format: "RGBA", codedWidth: W, codedHeight: H, timestamp: 0, colorSpace: cs });
          } catch (e) {
            return { error: "ctor: " + String(e) };
          }
          const inFrameCS = csOut(vf.colorSpace); // (1) did the RGBA frame keep the matrix?

          let outMeta = "no-meta";
          let decoderConfig = null;
          let encErr = null;
          let firstChunk = null;
          const enc = new VideoEncoder({
            output: (chunk, meta) => {
              if (meta && meta.decoderConfig) {
                decoderConfig = meta.decoderConfig;
                outMeta = csOut(meta.decoderConfig.colorSpace); // (2) encoder's chosen output colorSpace
              }
              if (!firstChunk) firstChunk = chunk;
            },
            error: (e) => { encErr = String(e); },
          });
          try {
            enc.configure({
              codec: "avc1.640028", width: W, height: H, bitrate: 2_000_000, framerate: 30,
              hardwareAcceleration: hw,
            });
            enc.encode(vf, { keyFrame: true });
            vf.close();
            await enc.flush();
          } catch (e) {
            try { vf.close(); } catch {}
            return { inFrameCS, error: "encode: " + String(e), encErr };
          }
          enc.close();

          // End-to-end: decode the produced chunk, read the decoded frame's colorSpace.
          let decFrameCS = "not-decoded";
          if (firstChunk && decoderConfig) {
            try {
              let df = null;
              const dec = new VideoDecoder({ output: (f) => { if (!df) df = f; }, error: () => {} });
              dec.configure(decoderConfig);
              dec.decode(firstChunk);
              await dec.flush();
              if (df) { decFrameCS = csOut(df.colorSpace); df.close(); }
              dec.close();
            } catch (e) {
              decFrameCS = "decode-err: " + String(e);
            }
          }
          return { inFrameCS, outMeta, decFrameCS, encErr };
        }

        const C601 = { matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m", fullRange: false };
        const C709 = { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false };
        const out = {};
        for (const hw of ["prefer-hardware", "prefer-software"]) {
          out[hw] = { r601: await run(C601, hw), r709: await run(C709, hw) };
        }
        done({ out, ua: navigator.userAgent });
      })().catch((e) => done({ error: "threw: " + String(e) }));
    });

    console.log("[enc] ua:", result.ua);
    if (result.error) { console.log("[enc] ERROR:", result.error); expect(true).toBe(true); return; }
    for (const hw of Object.keys(result.out)) {
      const c = result.out[hw];
      console.log(`[enc] [${hw}] 601 input:`, JSON.stringify(c.r601));
      console.log(`[enc] [${hw}] 709 input:`, JSON.stringify(c.r709));
      const m1 = c.r601?.outMeta?.matrix, m2 = c.r709?.outMeta?.matrix;
      console.log(
        `[enc] [${hw}] honors input frame colorSpace? out(601in)=${m1} vs out(709in)=${m2} -> ` +
          `${m1 && m2 && m1 !== m2 ? "HONORED" : "IGNORED/CONSTANT"}`,
      );
    }
    expect(true).toBe(true);
  });
});
