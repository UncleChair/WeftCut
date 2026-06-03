// ONE-OFF POC (NOT a gate): does WebView2's WebGPU `importExternalTexture` honor
// a VideoFrame's colorSpace matrix (601 vs 709) when sampled via
// `textureSampleBaseClampToEdge`? If yes, it's the zero-copy path that fixes
// export color (unlike `copyExternalImageToTexture`, which Pixi uses and which
// drops the matrix → fixed 709). Self-contained: synthetic I420 frame, no app.
//   npx wdio run wdio.conf.mjs --spec ./tools/iso_importexternaltexture.e2e.js
describe("importExternalTexture colorSpace honoring (real WebView2 WebGPU, one-off)", function () {
  it("reports matrix honoring through importExternalTexture", async function () {
    const result = await browser.executeAsync((done) => {
      (async () => {
        if (!navigator.gpu) return done({ error: "no navigator.gpu" });
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return done({ error: "no adapter" });
        const device = await adapter.requestDevice();

        const WGSL = `
@group(0) @binding(0) var extTex: texture_external;
@group(0) @binding(1) var samp: sampler;
@vertex fn vmain(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f,3>(vec2f(-1.0,-1.0), vec2f(3.0,-1.0), vec2f(-1.0,3.0));
  return vec4f(p[vi], 0.0, 1.0);
}
@fragment fn fmain() -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(extTex, samp, vec2f(0.5, 0.5));
}`;
        const module = device.createShaderModule({ code: WGSL });
        const pipeline = device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vmain" },
          fragment: { module, entryPoint: "fmain", targets: [{ format: "rgba8unorm" }] },
          primitive: { topology: "triangle-list" },
        });
        const sampler = device.createSampler();

        async function sample(cs) {
          const W = 16, H = 16, ySize = W * H, cSize = (W / 2) * (H / 2);
          const data = new Uint8Array(ySize + 2 * cSize);
          data.fill(128, 0, ySize); // Y
          data.fill(128, ySize, ySize + cSize); // Cb
          data.fill(240, ySize + cSize); // Cr  (chromatic → matrix-sensitive G)
          let vf;
          try {
            vf = new VideoFrame(data, { format: "I420", codedWidth: W, codedHeight: H, timestamp: 0, colorSpace: cs });
          } catch (e) {
            return { error: "VideoFrame ctor: " + String(e) };
          }
          let ext;
          try {
            ext = device.importExternalTexture({ source: vf });
          } catch (e) {
            vf.close();
            return { error: "importExternalTexture: " + String(e) };
          }
          const target = device.createTexture({
            size: [1, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          });
          const bind = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: ext }, { binding: 1, resource: sampler }],
          });
          const readBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          const enc = device.createCommandEncoder();
          const pass = enc.beginRenderPass({
            colorAttachments: [{
              view: target.createView(),
              loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 },
            }],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bind);
          pass.draw(3);
          pass.end();
          enc.copyTextureToBuffer({ texture: target }, { buffer: readBuf, bytesPerRow: 256, rowsPerImage: 1 }, [1, 1, 1]);
          device.queue.submit([enc.finish()]);
          await readBuf.mapAsync(GPUMapMode.READ);
          const px = new Uint8Array(readBuf.getMappedRange().slice(0, 4));
          const rgb = [px[0], px[1], px[2]];
          readBuf.unmap();
          vf.close();
          return { rgb };
        }

        const c601 = { matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m", fullRange: false };
        const c709 = { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false };
        const r601 = await sample(c601);
        const r709 = await sample(c709);
        done({ r601, r709, ua: navigator.userAgent });
      })().catch((e) => done({ error: "threw: " + String(e) }));
    });

    console.log("[isoExt] r601(smpte170m):", JSON.stringify(result.r601));
    console.log("[isoExt] r709(bt709)    :", JSON.stringify(result.r709));
    if (result.error) console.log("[isoExt] ERROR:", result.error);
    const a = result.r601?.rgb, b = result.r709?.rgb;
    if (a && b) {
      const gDiff = Math.abs(a[1] - b[1]);
      console.log(`[isoExt] MATRIX honored via importExternalTexture? G(601)=${a[1]} vs G(709)=${b[1]} diff=${gDiff} -> ${gDiff > 8 ? "HONORED" : "IGNORED"}`);
    }
    expect(true).toBe(true);
  });
});
