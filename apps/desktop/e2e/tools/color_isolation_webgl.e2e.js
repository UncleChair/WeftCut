// ONE-OFF isolation experiment #2 (NOT a gate): does the WebGL texImage2D upload
// path (what PixiJS uses) honor VideoFrame.colorSpace.matrix / fullRange the way
// the 2D canvas did? Same synthetic I420 frames, uploaded to a WebGL2 texture,
// rendered, read back. Differ across tags => WebGL honors (=> bug is the decoder
// not tagging output frames, L1). Same => WebGL ignores (=> bug is the upload, L3).
//   npx wdio run wdio.conf.mjs --spec ./tools/color_isolation_webgl.e2e.js
describe("WebGL VideoFrame upload color honoring (real WebView2, one-off)", function () {
  it("reports matrix + range honoring through WebGL2 texImage2D", async function () {
    await browser.waitUntil(
      async () => (await browser.execute(() => typeof VideoFrame === "function")) === true,
      { timeout: 30000, timeoutMsg: "VideoFrame global never available" },
    );

    const result = await browser.execute(() => {
      function sampleGL(y, cb, cr, cs) {
        const W = 16, H = 16, ySize = W * H, cSize = (W / 2) * (H / 2);
        const data = new Uint8Array(ySize + 2 * cSize);
        data.fill(y, 0, ySize);
        data.fill(cb, ySize, ySize + cSize);
        data.fill(cr, ySize + cSize);
        let vf;
        try {
          vf = new VideoFrame(data, { format: "I420", codedWidth: W, codedHeight: H, timestamp: 0, colorSpace: cs });
        } catch (e) {
          return { error: "ctor: " + String(e) };
        }
        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
        if (!gl) { vf.close(); return { error: "no webgl2" }; }
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vf);
        } catch (e) { vf.close(); return { error: "texImage2D: " + String(e) }; }
        vf.close();
        const vs = "#version 300 es\nin vec2 p; out vec2 uv;\nvoid main(){ uv=(p+1.0)/2.0; gl_Position=vec4(p,0.0,1.0); }";
        const fs = "#version 300 es\nprecision highp float; in vec2 uv; uniform sampler2D t; out vec4 o;\nvoid main(){ o=texture(t,uv); }";
        function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
        const prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: "link: " + gl.getProgramInfoLog(prog) };
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, "p");
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.uniform1i(gl.getUniformLocation(prog, "t"), 0);
        gl.viewport(0, 0, W, H);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const px = new Uint8Array(4);
        gl.readPixels(W / 2, H / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return { rgb: [px[0], px[1], px[2]] };
      }
      const c601 = { matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m", fullRange: false };
      const c709 = { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false };
      const c709full = { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: true };
      return {
        matrix601: sampleGL(128, 128, 240, c601),
        matrix709: sampleGL(128, 128, 240, c709),
        rangeLtd: sampleGL(235, 128, 128, c709),
        rangeFull: sampleGL(235, 128, 128, c709full),
      };
    });

    console.log("[isoGL] matrix601 (smpte170m):", JSON.stringify(result.matrix601));
    console.log("[isoGL] matrix709 (bt709)    :", JSON.stringify(result.matrix709));
    console.log("[isoGL] rangeLtd (tv)        :", JSON.stringify(result.rangeLtd));
    console.log("[isoGL] rangeFull (pc)       :", JSON.stringify(result.rangeFull));
    const m601 = result.matrix601.rgb, m709 = result.matrix709.rgb;
    const rL = result.rangeLtd.rgb, rF = result.rangeFull.rgb;
    if (m601 && m709) {
      const gDiff = Math.abs(m601[1] - m709[1]);
      console.log(`[isoGL] MATRIX honored (WebGL)? G(601)=${m601[1]} vs G(709)=${m709[1]} diff=${gDiff} -> ${gDiff > 8 ? "HONORED" : "IGNORED"}`);
    }
    if (rL && rF) {
      const vDiff = Math.abs(rL[0] - rF[0]);
      console.log(`[isoGL] RANGE honored (WebGL)?  R(tv)=${rL[0]} vs R(pc)=${rF[0]} diff=${vDiff} -> ${vDiff > 8 ? "HONORED" : "IGNORED"}`);
    }
    expect(true).toBe(true);
  });
});
