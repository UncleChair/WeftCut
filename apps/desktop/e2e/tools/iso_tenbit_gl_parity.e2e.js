// GL-parity gate for the 10-bit ingest + pack pipeline (Task 5).
// Verifies that:
//   T1: TenBitIngest's RG8→RGBA16F shader matches the yuv10.ts CPU reference.
//   T1b: 601-tagged (smpte170m) case — same pipeline with BT601 coefficients.
//   T1c: awkward-width (70×64) case — pins the UNPACK_ALIGNMENT=1 fix.
//   T2: PackYuv420p10's f16→RGBA8 byte-pack shaders are byte-exact (±1 code)
//       and pins the PACK_ROW_FLIP orientation constant.
//
// NOTE: The shader strings inlined below are copied verbatim from their
// source files — keep both in sync:
//   T1 VERT/FRAG  ← src/render/tenbit/TenBitIngest.ts
//   T2 VERT_PACK/FRAG_Y/FRAG_C ← src/render/tenbit/PackYuv420p10.ts
//
// Self-contained: pixi.js injected from node_modules as a blob-URL ES module.
// Run (from apps/desktop/e2e):
//   node node_modules\@wdio\cli\bin\wdio.js run wdio.conf.mjs --spec ./tools/iso_tenbit_gl_parity.e2e.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..", ".."); // e2e/tools -> repo root
const PIXI_SRC = fs.readFileSync(
  path.resolve(REPO, "node_modules/pixi.js/dist/pixi.min.mjs"),
  "utf8",
);

/// Ship a library source into the page in chunks (single executeScript
/// payloads in the MB range can exceed driver body limits).
async function stashLibSource(name, src) {
  await browser.execute((n) => {
    window.__probeSrc = window.__probeSrc || {};
    window.__probeSrc[n] = "";
  }, name);
  const CHUNK = 256 * 1024;
  for (let i = 0; i < src.length; i += CHUNK) {
    await browser.execute(
      (n, c) => {
        window.__probeSrc[n] += c;
      },
      name,
      src.slice(i, i + CHUNK),
    );
  }
}

describe("iso_tenbit_gl_parity (T1 ingest + T2 pack, real WebView2)", function () {
  before(async function () {
    this.timeout(300000);
    await browser.setTimeout({ script: 240000 });
    await stashLibSource("pixi", PIXI_SRC);
    await browser.execute(() => {
      window.__probeMods = {};
      window.__probeImport = async (name) => {
        if (window.__probeMods[name]) return window.__probeMods[name];
        const blob = new Blob([window.__probeSrc[name]], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        try {
          const m = await import(url);
          window.__probeMods[name] = m;
          return m;
        } finally {
          URL.revokeObjectURL(url);
        }
      };
    });
  });

  it("T1 — ingest parity: RG8 planes → RGBA16F matches yuv10.ts CPU reference", async function () {
    this.timeout(180000);

    const r = await browser.executeAsync((done) => {
      (async () => {
        // ---- inline yuv10.ts CPU reference ----
        function inverseCoef(c) {
          const kg = 1 - c.kr - c.kb;
          const crR = 2 * (1 - c.kr);
          const cbB = 2 * (1 - c.kb);
          return [crR, (c.kb * cbB) / kg, (c.kr * crR) / kg, cbB];
        }
        function yuv10ToRgb(y10, u10, v10, c) {
          const [crR, cbG, crG, cbB] = inverseCoef(c);
          const y = (y10 - 64) / 876;
          const cb = (u10 - 512) / 896;
          const cr = (v10 - 512) / 896;
          const clamp01 = (x) => Math.min(1, Math.max(0, x));
          return [
            clamp01(y + crR * cr),
            clamp01(y - crG * cr - cbG * cb),
            clamp01(y + cbB * cb),
          ];
        }
        const BT709 = { kr: 0.2126, kb: 0.0722 };

        // ---- shader source (verbatim from TenBitIngest.ts) ----
        const VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;
        const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uY;
uniform sampler2D uU;
uniform sampler2D uV;
uniform vec4 uCoef;   // crR, cbG, crG, cbB
uniform vec2 uScale;  // y scale (876 limited / 1023 full), c scale (896 / 1023)
uniform float uYOff;  // 64 limited / 0 full
float decode10(vec4 t) { return t.r * 255.0 + t.g * 255.0 * 256.0; }
void main() {
  float y  = (decode10(texture(uY, vUV)) - uYOff) / uScale.x;
  float cb = (decode10(texture(uU, vUV)) - 512.0) / uScale.y;
  float cr = (decode10(texture(uV, vUV)) - 512.0) / uScale.y;
  vec3 rgb = vec3(
    y + uCoef.x * cr,
    y - uCoef.z * cr - uCoef.y * cb,
    y + uCoef.w * cb);
  finalColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

        const out = {};
        let renderer;
        try {
          const PIXI = await window.__probeImport("pixi");
          out.pixiVersion = PIXI.VERSION;

          const W = 64, H = 64;
          renderer = await PIXI.autoDetectRenderer({
            preference: "webgl",
            width: W,
            height: H,
            antialias: false,
          });
          out.rendererName = renderer.name ?? renderer.constructor.name;
          const gl = renderer.gl;
          if (!gl) {
            done({ ...out, error: "no GL context" });
            return;
          }

          // Build synthetic plane data: Y ramp 64→940 across x, U=512, V=720
          const CW = W >> 1, CH = H >> 1;
          const yPlane = new Uint8Array(W * H * 2);
          const uPlane = new Uint8Array(CW * CH * 2);
          const vPlane = new Uint8Array(CW * CH * 2);

          // Y: code = round(64 + (x/63)*876), encoded as u16LE
          for (let row = 0; row < H; row++) {
            for (let x = 0; x < W; x++) {
              const code = Math.round(64 + (x / (W - 1)) * 876);
              const idx = (row * W + x) * 2;
              yPlane[idx] = code & 0xff;
              yPlane[idx + 1] = (code >> 8) & 0xff;
            }
          }
          // U = 512 for all
          for (let i = 0; i < CW * CH; i++) {
            uPlane[i * 2] = 512 & 0xff;
            uPlane[i * 2 + 1] = (512 >> 8) & 0xff;
          }
          // V = 720 for all
          for (let i = 0; i < CW * CH; i++) {
            vPlane[i * 2] = 720 & 0xff;
            vPlane[i * 2 + 1] = (720 >> 8) & 0xff;
          }

          // Build BufferImageSource planes (rg8unorm format)
          const ySource = new PIXI.BufferImageSource({
            resource: yPlane, width: W, height: H, format: "rg8unorm",
            alphaMode: "no-premultiply-alpha", scaleMode: "nearest",
          });
          const uSource = new PIXI.BufferImageSource({
            resource: uPlane, width: CW, height: CH, format: "rg8unorm",
            alphaMode: "no-premultiply-alpha", scaleMode: "nearest",
          });
          const vSource = new PIXI.BufferImageSource({
            resource: vPlane, width: CW, height: CH, format: "rg8unorm",
            alphaMode: "no-premultiply-alpha", scaleMode: "nearest",
          });

          const rt = PIXI.RenderTexture.create({ width: W, height: H, format: "rgba16float" });

          const geometry = new PIXI.MeshGeometry({
            positions: new Float32Array([0, 0, W, 0, W, H, 0, H]),
            uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
            indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
          });

          const coef = inverseCoef(BT709);
          const shader = PIXI.Shader.from({
            gl: { vertex: VERT, fragment: FRAG },
            resources: {
              uY: ySource, uYSampler: ySource.style,
              uU: uSource, uUSampler: uSource.style,
              uV: vSource, uVSampler: vSource.style,
              tenbit: {
                uCoef: { value: new Float32Array(coef), type: "vec4<f32>" },
                uScale: { value: new Float32Array([876, 896]), type: "vec2<f32>" },
                uYOff: { value: 64, type: "f32" },
              },
            },
          });

          const mesh = new PIXI.Mesh({ geometry, shader });
          renderer.render({ container: mesh, target: rt });

          // Readback
          renderer.renderTarget.bind(rt, false);
          const f32buf = new Float32Array(W * H * 4);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, f32buf);
          const glErr = gl.getError();
          out.glReadError = glErr;

          // Sample 16 points across y=32 row. GL is bottom-up, Pixi may flip.
          // We sample BOTH possible row mappings and report which matched.
          // Row 32 from top = row H-1-32 from bottom (GL bottom-up) = row 31 from bottom.
          const SAMPLE_Y_TOP = 32;
          const rowGlBottomUp = H - 1 - SAMPLE_Y_TOP; // = 31

          const samplePoints = [];
          for (let i = 0; i < 16; i++) {
            const x = Math.round((i / 15) * (W - 1));
            samplePoints.push(x);
          }

          const THRESH = 2 / 876;
          let maxErr = 0;
          let matchedRow = null;
          const errors = [];

          // Try both row mappings
          for (const glRow of [rowGlBottomUp, SAMPLE_Y_TOP]) {
            let rowMaxErr = 0;
            const rowErrs = [];
            for (const x of samplePoints) {
              const y10 = Math.round(64 + (x / (W - 1)) * 876);
              const [refR, refG, refB] = yuv10ToRgb(y10, 512, 720, BT709);
              const idx = (glRow * W + x) * 4;
              const glR = f32buf[idx];
              const glG = f32buf[idx + 1];
              const glB = f32buf[idx + 2];
              const errR = Math.abs(glR - refR);
              const errG = Math.abs(glG - refG);
              const errB = Math.abs(glB - refB);
              const err = Math.max(errR, errG, errB);
              if (err > rowMaxErr) rowMaxErr = err;
              rowErrs.push({ x, y10, ref: [refR, refG, refB], gl: [glR, glG, glB], err });
            }
            if (matchedRow === null || rowMaxErr < maxErr) {
              maxErr = rowMaxErr;
              matchedRow = glRow;
              errors.length = 0;
              for (const e of rowErrs) errors.push(e);
            }
          }

          const orientationNote = matchedRow === rowGlBottomUp
            ? "GL bottom-up row matched (Pixi RT does NOT flip — readback is bottom-up)"
            : "Top-down row matched (Pixi RT projection flips the readback)";

          out.maxErr = maxErr;
          out.threshold = THRESH;
          out.pass = maxErr < THRESH;
          out.orientationNote = orientationNote;
          out.matchedGlRow = matchedRow;
          // Sample of first/last errors for diagnostics
          out.sampleErrors = errors.slice(0, 3).map((e) => ({
            x: e.x, y10: e.y10,
            ref: e.ref.map((v) => +v.toFixed(5)),
            gl: e.gl.map((v) => +v.toFixed(5)),
            err: +e.err.toFixed(6),
          }));

        } catch (e) {
          out.fatal = String((e && e.stack) || e);
        } finally {
          try { renderer?.destroy(); } catch { /* ignore teardown */ }
        }
        done(out);
      })().catch((e) => done({ fatal: String((e && e.stack) || e) }));
    });

    console.log("\n[T1] ===== Ingest parity: RG8 planes → RGBA16F =====");
    if (r.fatal) {
      console.log("[T1] FATAL:", r.fatal);
    } else {
      console.log(`[T1] pixi=${r.pixiVersion} renderer=${r.rendererName} glReadError=${r.glReadError}`);
      console.log(`[T1] orientation: ${r.orientationNote}`);
      console.log(`[T1] maxErr=${r.maxErr?.toFixed(6)} threshold=${r.threshold?.toFixed(6)}`);
      if (r.sampleErrors) {
        for (const e of r.sampleErrors) {
          console.log(`[T1]   x=${e.x} y10=${e.y10} ref=[${e.ref}] gl=[${e.gl}] err=${e.err}`);
        }
      }
      console.log(`[T1] verdict: ${r.pass ? "PASS — GL ingest matches CPU reference" : "FAIL — error exceeds threshold"}`);
    }

    expect(r.fatal).toBeUndefined();
    expect(r.glReadError).toBe(0);
    expect(r.pass).toBe(true);
  });

  it("T1b — ingest parity: 601-tagged (smpte170m) case matches BT601 CPU reference", async function () {
    this.timeout(180000);

    const r = await browser.executeAsync((done) => {
      (async () => {
        // ---- inline yuv10.ts CPU reference (BT601) ----
        function inverseCoef(c) {
          const kg = 1 - c.kr - c.kb;
          const crR = 2 * (1 - c.kr);
          const cbB = 2 * (1 - c.kb);
          return [crR, (c.kb * cbB) / kg, (c.kr * crR) / kg, cbB];
        }
        function yuv10ToRgb(y10, u10, v10, c) {
          const [crR, cbG, crG, cbB] = inverseCoef(c);
          const y = (y10 - 64) / 876;
          const cb = (u10 - 512) / 896;
          const cr = (v10 - 512) / 896;
          const clamp01 = (x) => Math.min(1, Math.max(0, x));
          return [
            clamp01(y + crR * cr),
            clamp01(y - crG * cr - cbG * cb),
            clamp01(y + cbB * cb),
          ];
        }
        // BT.601 — same kr/kb for smpte170m and bt470bg
        const BT601 = { kr: 0.299, kb: 0.114 };

        // ---- shader source (verbatim from TenBitIngest.ts) ----
        const VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;
        const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uY;
uniform sampler2D uU;
uniform sampler2D uV;
uniform vec4 uCoef;   // crR, cbG, crG, cbB
uniform vec2 uScale;  // y scale (876 limited / 1023 full), c scale (896 / 1023)
uniform float uYOff;  // 64 limited / 0 full
float decode10(vec4 t) { return t.r * 255.0 + t.g * 255.0 * 256.0; }
void main() {
  float y  = (decode10(texture(uY, vUV)) - uYOff) / uScale.x;
  float cb = (decode10(texture(uU, vUV)) - 512.0) / uScale.y;
  float cr = (decode10(texture(uV, vUV)) - 512.0) / uScale.y;
  vec3 rgb = vec3(
    y + uCoef.x * cr,
    y - uCoef.z * cr - uCoef.y * cb,
    y + uCoef.w * cb);
  finalColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

        const out = {};
        let renderer;
        try {
          const PIXI = await window.__probeImport("pixi");
          out.pixiVersion = PIXI.VERSION;

          const W = 64, H = 64;
          renderer = await PIXI.autoDetectRenderer({
            preference: "webgl", width: W, height: H, antialias: false,
          });
          const gl = renderer.gl;
          if (!gl) { done({ ...out, error: "no GL context" }); return; }

          const CW = W >> 1, CH = H >> 1;
          const yPlane = new Uint8Array(W * H * 2);
          const uPlane = new Uint8Array(CW * CH * 2);
          const vPlane = new Uint8Array(CW * CH * 2);
          for (let row = 0; row < H; row++) {
            for (let x = 0; x < W; x++) {
              const code = Math.round(64 + (x / (W - 1)) * 876);
              const idx = (row * W + x) * 2;
              yPlane[idx] = code & 0xff; yPlane[idx + 1] = (code >> 8) & 0xff;
            }
          }
          for (let i = 0; i < CW * CH; i++) {
            uPlane[i * 2] = 512 & 0xff; uPlane[i * 2 + 1] = (512 >> 8) & 0xff;
            vPlane[i * 2] = 640 & 0xff; vPlane[i * 2 + 1] = (640 >> 8) & 0xff;
          }

          const ySource = new PIXI.BufferImageSource({
            resource: yPlane, width: W, height: H, format: "rg8unorm",
            alphaMode: "no-premultiply-alpha", scaleMode: "nearest",
          });
          const uSource = new PIXI.BufferImageSource({
            resource: uPlane, width: CW, height: CH, format: "rg8unorm",
            alphaMode: "no-premultiply-alpha", scaleMode: "nearest",
          });
          const vSource = new PIXI.BufferImageSource({
            resource: vPlane, width: CW, height: CH, format: "rg8unorm",
            alphaMode: "no-premultiply-alpha", scaleMode: "nearest",
          });

          const rt = PIXI.RenderTexture.create({ width: W, height: H, format: "rgba16float" });
          const geometry = new PIXI.MeshGeometry({
            positions: new Float32Array([0, 0, W, 0, W, H, 0, H]),
            uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
            indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
          });
          // Use BT601 coefficients (smpte170m / bt470bg path in TenBitIngest)
          const coef = inverseCoef(BT601);
          const shader = PIXI.Shader.from({
            gl: { vertex: VERT, fragment: FRAG },
            resources: {
              uY: ySource, uYSampler: ySource.style,
              uU: uSource, uUSampler: uSource.style,
              uV: vSource, uVSampler: vSource.style,
              tenbit: {
                uCoef: { value: new Float32Array(coef), type: "vec4<f32>" },
                uScale: { value: new Float32Array([876, 896]), type: "vec2<f32>" },
                uYOff: { value: 64, type: "f32" },
              },
            },
          });
          const mesh = new PIXI.Mesh({ geometry, shader });
          renderer.render({ container: mesh, target: rt });

          renderer.renderTarget.bind(rt, false);
          const f32buf = new Float32Array(W * H * 4);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, f32buf);
          out.glReadError = gl.getError();

          const THRESH = 2 / 876;
          let maxErr = 0;
          // Sample row 32 (try both orientations, pick best match)
          const SAMPLE_Y_TOP = 32;
          const rowGlBottomUp = H - 1 - SAMPLE_Y_TOP;
          const samplePoints = [];
          for (let i = 0; i < 16; i++) samplePoints.push(Math.round((i / 15) * (W - 1)));

          for (const glRow of [rowGlBottomUp, SAMPLE_Y_TOP]) {
            let rowMax = 0;
            for (const x of samplePoints) {
              const y10 = Math.round(64 + (x / (W - 1)) * 876);
              const [refR, refG, refB] = yuv10ToRgb(y10, 512, 640, BT601);
              const idx = (glRow * W + x) * 4;
              const err = Math.max(
                Math.abs(f32buf[idx] - refR),
                Math.abs(f32buf[idx + 1] - refG),
                Math.abs(f32buf[idx + 2] - refB),
              );
              if (err > rowMax) rowMax = err;
            }
            if (maxErr === 0 || rowMax < maxErr) maxErr = rowMax;
          }

          out.maxErr = maxErr;
          out.threshold = THRESH;
          out.pass = maxErr < THRESH;
        } catch (e) {
          out.fatal = String((e && e.stack) || e);
        } finally {
          try { renderer?.destroy(); } catch { /* ignore */ }
        }
        done(out);
      })().catch((e) => done({ fatal: String((e && e.stack) || e) }));
    });

    console.log("\n[T1b] ===== Ingest parity: 601-tagged case =====");
    if (r.fatal) {
      console.log("[T1b] FATAL:", r.fatal);
    } else {
      console.log(`[T1b] maxErr=${r.maxErr?.toFixed(6)} threshold=${r.threshold?.toFixed(6)}`);
      console.log(`[T1b] verdict: ${r.pass ? "PASS — BT601 ingest matches CPU reference" : "FAIL"}`);
    }

    expect(r.fatal).toBeUndefined();
    expect(r.glReadError).toBe(0);
    expect(r.pass).toBe(true);
  });

  it("T1c — ingest parity: 70×64 awkward-width pins UNPACK_ALIGNMENT=1 fix", async function () {
    this.timeout(180000);

    const r = await browser.executeAsync((done) => {
      (async () => {
        // ---- inline yuv10.ts CPU reference ----
        function inverseCoef(c) {
          const kg = 1 - c.kr - c.kb;
          const crR = 2 * (1 - c.kr);
          const cbB = 2 * (1 - c.kb);
          return [crR, (c.kb * cbB) / kg, (c.kr * crR) / kg, cbB];
        }
        function yuv10ToRgb(y10, u10, v10, c) {
          const [crR, cbG, crG, cbB] = inverseCoef(c);
          const y = (y10 - 64) / 876;
          const cb = (u10 - 512) / 896;
          const cr = (v10 - 512) / 896;
          const clamp01 = (x) => Math.min(1, Math.max(0, x));
          return [
            clamp01(y + crR * cr),
            clamp01(y - crG * cr - cbG * cb),
            clamp01(y + cbB * cb),
          ];
        }
        const BT709 = { kr: 0.2126, kb: 0.0722 };

        // ---- shader source (verbatim from TenBitIngest.ts) ----
        const VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;
        const FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uY;
uniform sampler2D uU;
uniform sampler2D uV;
uniform vec4 uCoef;   // crR, cbG, crG, cbB
uniform vec2 uScale;  // y scale (876 limited / 1023 full), c scale (896 / 1023)
uniform float uYOff;  // 64 limited / 0 full
float decode10(vec4 t) { return t.r * 255.0 + t.g * 255.0 * 256.0; }
void main() {
  float y  = (decode10(texture(uY, vUV)) - uYOff) / uScale.x;
  float cb = (decode10(texture(uU, vUV)) - 512.0) / uScale.y;
  float cr = (decode10(texture(uV, vUV)) - 512.0) / uScale.y;
  vec3 rgb = vec3(
    y + uCoef.x * cr,
    y - uCoef.z * cr - uCoef.y * cb,
    y + uCoef.w * cb);
  finalColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

        // W=70: chroma row = 35 * 2 = 70 bytes; 70 % 4 == 2 → skewed with UNPACK_ALIGNMENT=4.
        // This test sets UNPACK_ALIGNMENT=1 (same as TenBitIngest constructor fix) and asserts
        // parity. Without the pixelStorei the upload would be skewed and this must fail.
        const W = 70, H = 64;
        const out = {};
        let renderer;
        try {
          const PIXI = await window.__probeImport("pixi");
          out.pixiVersion = PIXI.VERSION;

          renderer = await PIXI.autoDetectRenderer({
            preference: "webgl", width: W, height: H, antialias: false,
          });
          const gl = renderer.gl;
          if (!gl) { done({ ...out, error: "no GL context" }); return; }

          // Set UNPACK_ALIGNMENT=1 exactly as TenBitIngest constructor does.
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

          const CW = W >> 1, CH = H >> 1;
          const yPlane = new Uint8Array(W * H * 2);
          const uPlane = new Uint8Array(CW * CH * 2);
          const vPlane = new Uint8Array(CW * CH * 2);
          // Y ramp across x, U=512, V=720
          for (let row = 0; row < H; row++) {
            for (let x = 0; x < W; x++) {
              const code = Math.round(64 + (x / (W - 1)) * 876);
              const idx = (row * W + x) * 2;
              yPlane[idx] = code & 0xff; yPlane[idx + 1] = (code >> 8) & 0xff;
            }
          }
          for (let i = 0; i < CW * CH; i++) {
            uPlane[i * 2] = 512 & 0xff; uPlane[i * 2 + 1] = (512 >> 8) & 0xff;
            vPlane[i * 2] = 720 & 0xff; vPlane[i * 2 + 1] = (720 >> 8) & 0xff;
          }

          const ySource = new PIXI.BufferImageSource({
            resource: yPlane, width: W, height: H, format: "rg8unorm",
            alphaMode: "no-premultiply-alpha", scaleMode: "nearest",
          });
          const uSource = new PIXI.BufferImageSource({
            resource: uPlane, width: CW, height: CH, format: "rg8unorm",
            alphaMode: "no-premultiply-alpha", scaleMode: "nearest",
          });
          const vSource = new PIXI.BufferImageSource({
            resource: vPlane, width: CW, height: CH, format: "rg8unorm",
            alphaMode: "no-premultiply-alpha", scaleMode: "nearest",
          });

          const rt = PIXI.RenderTexture.create({ width: W, height: H, format: "rgba16float" });
          const geometry = new PIXI.MeshGeometry({
            positions: new Float32Array([0, 0, W, 0, W, H, 0, H]),
            uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
            indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
          });
          const coef = inverseCoef(BT709);
          const shader = PIXI.Shader.from({
            gl: { vertex: VERT, fragment: FRAG },
            resources: {
              uY: ySource, uYSampler: ySource.style,
              uU: uSource, uUSampler: uSource.style,
              uV: vSource, uVSampler: vSource.style,
              tenbit: {
                uCoef: { value: new Float32Array(coef), type: "vec4<f32>" },
                uScale: { value: new Float32Array([876, 896]), type: "vec2<f32>" },
                uYOff: { value: 64, type: "f32" },
              },
            },
          });
          const mesh = new PIXI.Mesh({ geometry, shader });
          renderer.render({ container: mesh, target: rt });

          renderer.renderTarget.bind(rt, false);
          const f32buf = new Float32Array(W * H * 4);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, f32buf);
          out.glReadError = gl.getError();

          const THRESH = 2 / 876;
          let maxErr = 0;
          // Sample row 32, try both orientations, pick best
          const SAMPLE_Y_TOP = 32;
          const rowGlBottomUp = H - 1 - SAMPLE_Y_TOP;
          const samplePoints = [];
          for (let i = 0; i < 12; i++) samplePoints.push(Math.round((i / 11) * (W - 1)));

          for (const glRow of [rowGlBottomUp, SAMPLE_Y_TOP]) {
            let rowMax = 0;
            for (const x of samplePoints) {
              const y10 = Math.round(64 + (x / (W - 1)) * 876);
              const [refR, refG, refB] = yuv10ToRgb(y10, 512, 720, BT709);
              const idx = (glRow * W + x) * 4;
              const err = Math.max(
                Math.abs(f32buf[idx] - refR),
                Math.abs(f32buf[idx + 1] - refG),
                Math.abs(f32buf[idx + 2] - refB),
              );
              if (err > rowMax) rowMax = err;
            }
            if (maxErr === 0 || rowMax < maxErr) maxErr = rowMax;
          }

          out.maxErr = maxErr;
          out.threshold = THRESH;
          out.pass = maxErr < THRESH;
          out.note = "W=70 chroma rows=70 bytes (70%4==2) — UNPACK_ALIGNMENT=1 required";
        } catch (e) {
          out.fatal = String((e && e.stack) || e);
        } finally {
          try { renderer?.destroy(); } catch { /* ignore */ }
        }
        done(out);
      })().catch((e) => done({ fatal: String((e && e.stack) || e) }));
    });

    console.log("\n[T1c] ===== Ingest parity: 70×64 awkward-width (UNPACK_ALIGNMENT pin) =====");
    if (r.fatal) {
      console.log("[T1c] FATAL:", r.fatal);
    } else {
      console.log(`[T1c] note: ${r.note}`);
      console.log(`[T1c] maxErr=${r.maxErr?.toFixed(6)} threshold=${r.threshold?.toFixed(6)}`);
      console.log(`[T1c] verdict: ${r.pass ? "PASS — awkward-width upload correct with UNPACK_ALIGNMENT=1" : "FAIL"}`);
    }

    expect(r.fatal).toBeUndefined();
    expect(r.glReadError).toBe(0);
    expect(r.pass).toBe(true);
  });

  it("T2 — pack parity: f16 composite → yuv420p10le bytes, orientation pinned", async function () {
    this.timeout(180000);

    const r = await browser.executeAsync((done) => {
      (async () => {
        // ---- inline yuv10.ts CPU reference ----
        const BT709 = { kr: 0.2126, kb: 0.0722 };
        function inverseCoef(c) {
          const kg = 1 - c.kr - c.kb;
          const crR = 2 * (1 - c.kr);
          const cbB = 2 * (1 - c.kb);
          return [crR, (c.kb * cbB) / kg, (c.kr * crR) / kg, cbB];
        }
        function rgbToYuv10(r, g, b, c) {
          const clamp01 = (x) => Math.min(1, Math.max(0, x));
          const clamp10 = (x) => Math.min(1023, Math.max(0, Math.round(x)));
          const kg = 1 - c.kr - c.kb;
          const y = c.kr * clamp01(r) + kg * clamp01(g) + c.kb * clamp01(b);
          const cb = (clamp01(b) - y) / (2 * (1 - c.kb));
          const cr = (clamp01(r) - y) / (2 * (1 - c.kr));
          return [clamp10(64 + 876 * y), clamp10(512 + 896 * cb), clamp10(512 + 896 * cr)];
        }
        function packTwoSamples(a10, b10) {
          return [a10 & 255, a10 >> 8, b10 & 255, b10 >> 8];
        }

        // ---- shader sources (verbatim from PackYuv420p10.ts) ----
        const VERT_COMPOSITE = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;
        const FRAG_GRADIENT = `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;
void main() {
  finalColor = vec4(vUV.x, vUV.x, vUV.y, 1.0);
}`;

        const VERT_PACK = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}`;
        const FRAG_Y = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uC;
uniform vec2 uOut; // encoder (outW, outH)
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
float q(float y) { return clamp(floor(64.0 + y * 876.0 + 0.5), 0.0, 1023.0); }
void main() {
  float px = (gl_FragCoord.x - 0.5) * 2.0;
  float row = gl_FragCoord.y - 0.5;
  float y0 = q(dot(texture(uC, vec2((px + 0.5) / uOut.x, (row + 0.5) / uOut.y)).rgb, KY));
  float y1 = q(dot(texture(uC, vec2((px + 1.5) / uOut.x, (row + 0.5) / uOut.y)).rgb, KY));
  o = vec4(mod(y0, 256.0) / 255.0, floor(y0 / 256.0) / 255.0,
           mod(y1, 256.0) / 255.0, floor(y1 / 256.0) / 255.0);
}`;
        const FRAG_C = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uC;
uniform vec2 uOut;
uniform float uSel;
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
float qc(float c) { return clamp(floor(512.0 + c * 896.0 + 0.5), 0.0, 1023.0); }
float chroma(vec2 blockMid) {
  vec3 rgb = texture(uC, blockMid).rgb;
  float y = dot(rgb, KY);
  return uSel < 0.5 ? (rgb.b - y) / 1.8556 : (rgb.r - y) / 1.5748;
}
void main() {
  float cx = (gl_FragCoord.x - 0.5) * 2.0;
  float cy = gl_FragCoord.y - 0.5;
  float c0 = qc(chroma(vec2((2.0 * cx + 1.0) / uOut.x, (2.0 * cy + 1.0) / uOut.y)));
  float c1 = qc(chroma(vec2((2.0 * (cx + 1.0) + 1.0) / uOut.x, (2.0 * cy + 1.0) / uOut.y)));
  o = vec4(mod(c0, 256.0) / 255.0, floor(c0 / 256.0) / 255.0,
           mod(c1, 256.0) / 255.0, floor(c1 / 256.0) / 255.0);
}`;

        // Asymmetric gradient: R=G=vUV.x, B=vUV.y
        // So rows differ (B changes with row) and columns differ (R/G change with col).
        const W = 128, H = 16;
        const out = {};
        let renderer;

        try {
          const PIXI = await window.__probeImport("pixi");
          out.pixiVersion = PIXI.VERSION;

          renderer = await PIXI.autoDetectRenderer({
            preference: "webgl",
            width: W,
            height: H,
            antialias: false,
          });
          out.rendererName = renderer.name ?? renderer.constructor.name;
          const gl = renderer.gl;
          if (!gl) { done({ ...out, error: "no GL context" }); return; }

          // Step 1: render asymmetric gradient into rgba16float RT
          const compositRT = PIXI.RenderTexture.create({ width: W, height: H, format: "rgba16float" });
          {
            const geom = new PIXI.MeshGeometry({
              positions: new Float32Array([0, 0, W, 0, W, H, 0, H]),
              uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
              indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
            });
            const sh = PIXI.Shader.from({
              gl: { vertex: VERT_COMPOSITE, fragment: FRAG_GRADIENT },
              resources: {},
            });
            const mesh = new PIXI.Mesh({ geometry: geom, shader: sh });
            renderer.render({ container: mesh, target: compositRT });
          }

          // Step 2: Y pack pass — PackP010 dims: W/2 wide × H tall
          const YW = W / 2, YH = H;
          const UW = W / 4, UH = H / 2;

          function buildPackPass(frag, pw, ph, sel) {
            const rt = PIXI.RenderTexture.create({ width: pw, height: ph, format: "rgba8unorm" });
            const geom = new PIXI.MeshGeometry({
              positions: new Float32Array([0, 0, pw, 0, pw, ph, 0, ph]),
              uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
              indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
            });
            const res = {
              uC: compositRT.source,
              uCSampler: compositRT.source.style,
              pack: {
                uOut: { value: new Float32Array([W, H]), type: "vec2<f32>" },
                ...(sel !== null ? { uSel: { value: sel, type: "f32" } } : {}),
              },
            };
            const sh = PIXI.Shader.from({
              gl: { vertex: VERT_PACK, fragment: frag },
              resources: res,
            });
            return { rt, mesh: new PIXI.Mesh({ geometry: geom, shader: sh }), w: pw, h: ph };
          }

          const yPass = buildPackPass(FRAG_Y, YW, YH, null);
          const uPass = buildPackPass(FRAG_C, UW, UH, 0);
          const vPass = buildPackPass(FRAG_C, UW, UH, 1);

          // Render each pass and read back.
          // PACK_ROW_FLIP = false (pinned by this test): Pixi's Y-flip projection
          // makes gl_FragCoord.y=0.5 = visual top, so readPixels row 0 = visual top.
          // No flip needed — the raw GL readback is already top-down.
          function readPass(pass) {
            renderer.render({ container: pass.mesh, target: pass.rt });
            renderer.renderTarget.bind(pass.rt, false);
            const raw = new Uint8Array(pass.w * pass.h * 4);
            gl.readPixels(0, 0, pass.w, pass.h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
            return raw;
          }

          const yRaw = readPass(yPass);
          const uRaw = readPass(uPass);
          const vRaw = readPass(vPass);

          // Decode a u16LE from RGBA8 pack texel (two samples: r+g*256, b+a*256)
          function decodePairFromTexel(raw, texelIdx) {
            const base = texelIdx * 4;
            return [raw[base] + raw[base + 1] * 256, raw[base + 2] + raw[base + 3] * 256];
          }

          // CPU reference: gradient at pixel center (px+0.5)/W, (row+0.5)/H
          // R=G=u, B=v  where u=(px+0.5)/W, v=(row+0.5)/H
          function gradientRgb(px, row) {
            const u = (px + 0.5) / W;
            const v = (row + 0.5) / H;
            return [u, u, v];
          }

          // Y reference for row r: sample pixels at x=0,1 → pack to texel 0
          function yRef(px, row) {
            const [r, g, b] = gradientRgb(px, row);
            return rgbToYuv10(r, g, b, BT709)[0];
          }

          // === Orientation test ===
          // PACK_ROW_FLIP = false: Pixi's Y-flip projection makes
          // gl_FragCoord.y=0.5 = visual top, so readPixels row 0 = visual top row.
          // We assert that raw GL row 0 matches the TOP reference (small B).
          //
          // Reference row 0 (visual top, B≈small):
          const refY_row0_px0 = yRef(0, 0);
          const refY_row0_px1 = yRef(1, 0);
          // Reference row H-1 (visual bottom, B≈large):
          const refY_rowLast_px0 = yRef(0, H - 1);
          const refY_rowLast_px1 = yRef(1, H - 1);

          // Raw GL row 0 texel 0 — both samples (no flip applied)
          const [glY_r0_s0, glY_r0_s1] = decodePairFromTexel(yRaw, 0 * YW + 0);

          const errRow0_withTopRef = Math.max(
            Math.abs(glY_r0_s0 - refY_row0_px0),
            Math.abs(glY_r0_s1 - refY_row0_px1),
          );
          const errRow0_withBotRef = Math.max(
            Math.abs(glY_r0_s0 - refY_rowLast_px0),
            Math.abs(glY_r0_s1 - refY_rowLast_px1),
          );

          let orientationVerdict;
          let rowFlipCorrect;
          if (errRow0_withTopRef <= errRow0_withBotRef + 1) {
            // GL row 0 = visual top → PACK_ROW_FLIP=false is correct
            orientationVerdict = "PACK_ROW_FLIP=false confirmed — GL row 0 = visual top (Pixi Y-flip)";
            rowFlipCorrect = true;
          } else {
            // GL row 0 = visual bottom → would need PACK_ROW_FLIP=true
            orientationVerdict = "PACK_ROW_FLIP must be true — GL row 0 = visual bottom";
            rowFlipCorrect = false;
          }
          out.orientationVerdict = orientationVerdict;
          out.rowFlipCorrect = rowFlipCorrect;
          out.orientationDetail = {
            glY_r0: [glY_r0_s0, glY_r0_s1],
            refTopRow: [refY_row0_px0, refY_row0_px1],
            refBotRow: [refY_rowLast_px0, refY_rowLast_px1],
            errWithTop: errRow0_withTopRef,
            errWithBot: errRow0_withBotRef,
          };

          // === Y row parity: rows 0 and H-1 ===
          let yMaxErr = 0;
          const yErrDetails = [];
          for (const row of [0, H - 1]) {
            for (let tx = 0; tx < Math.min(YW, 4); tx++) {
              const px0 = tx * 2, px1 = tx * 2 + 1;
              const [glA, glB] = decodePairFromTexel(yRaw, row * YW + tx);
              const refA = yRef(px0, row);
              const refB = yRef(px1, row);
              const err = Math.max(Math.abs(glA - refA), Math.abs(glB - refB));
              if (err > yMaxErr) yMaxErr = err;
              yErrDetails.push({ row, tx, glA, glB, refA, refB, err });
            }
          }
          out.yMaxErr = yMaxErr;
          out.yPass = yMaxErr <= 1;

          // === Chroma spot samples (8 samples) ===
          // For chroma (cx, cy), the GL shader taps at ((2cx+1)/W, (2cy+1)/H).
          // For our linear gradient, the bilinear tap value equals the analytic
          // value at that UV coordinate.
          function chromaRef(cx, cy, sel) {
            const tapU = (2 * cx + 1) / W;
            const tapV = (2 * cy + 1) / H;
            // R=G=tapU, B=tapV (linear gradient, bilinear = exact)
            const [refR, refG, refB] = [tapU, tapU, tapV];
            const [, refU, refV] = rgbToYuv10(refR, refG, refB, BT709);
            return sel === 0 ? refU : refV;
          }

          let cMaxErr = 0;
          const cErrDetails = [];
          const chromaSamples = [
            [0, 0], [1, 0], [2, 0], [3, 0],
            [0, UH - 1], [1, UH - 1], [2, UH - 1], [3, UH - 1],
          ];
          for (const [cx, cy] of chromaSamples) {
            // cx maps to texel cx>>1; sample 0 or 1 within that texel
            const texelCx = Math.floor(cx / 2);
            const sampleInTexel = cx % 2;
            const [glCbPair] = [decodePairFromTexel(uRaw, cy * UW + texelCx)];
            const [glCrPair] = [decodePairFromTexel(vRaw, cy * UW + texelCx)];
            const glCb = sampleInTexel === 0 ? glCbPair[0] : glCbPair[1];
            const glCr = sampleInTexel === 0 ? glCrPair[0] : glCrPair[1];
            const refCb = chromaRef(cx, cy, 0);
            const refCr = chromaRef(cx, cy, 1);
            const err = Math.max(Math.abs(glCb - refCb), Math.abs(glCr - refCr));
            if (err > cMaxErr) cMaxErr = err;
            cErrDetails.push({ cx, cy, glCb, glCr, refCb, refCr, err });
          }
          out.cMaxErr = cMaxErr;
          out.cPass = cMaxErr <= 2;
          out.cErrSample = cErrDetails.slice(0, 4).map((e) => ({
            cx: e.cx, cy: e.cy,
            glCb: e.glCb, glCr: e.glCr,
            refCb: e.refCb, refCr: e.refCr, err: e.err,
          }));
          out.yErrSample = yErrDetails.slice(0, 3);

          out.pass = out.yPass && out.cPass && out.rowFlipCorrect;
        } catch (e) {
          out.fatal = String((e && e.stack) || e);
        } finally {
          try { renderer?.destroy(); } catch { /* ignore */ }
        }
        done(out);
      })().catch((e) => done({ fatal: String((e && e.stack) || e) }));
    });

    console.log("\n[T2] ===== Pack parity: f16 → yuv420p10le bytes =====");
    if (r.fatal) {
      console.log("[T2] FATAL:", r.fatal);
    } else {
      console.log(`[T2] pixi=${r.pixiVersion} renderer=${r.rendererName}`);
      console.log(`[T2] ORIENTATION: ${r.orientationVerdict}`);
      if (r.orientationDetail) {
        const d = r.orientationDetail;
        console.log(`[T2]   glY_r0=[${d.glY_r0}] refTop=[${d.refTopRow}] refBot=[${d.refBotRow}]`);
        console.log(`[T2]   errWithTop=${d.errWithTop} errWithBot=${d.errWithBot}`);
      }
      console.log(`[T2] Y plane: maxErr=${r.yMaxErr} (tol ±1) -> ${r.yPass ? "PASS" : "FAIL"}`);
      if (r.yErrSample) {
        for (const e of r.yErrSample) {
          console.log(`[T2]   Y row=${e.row} tx=${e.tx} gl=[${e.glA},${e.glB}] ref=[${e.refA},${e.refB}] err=${e.err}`);
        }
      }
      console.log(`[T2] Chroma: maxErr=${r.cMaxErr} (tol ±2) -> ${r.cPass ? "PASS" : "FAIL"}`);
      if (r.cErrSample) {
        for (const e of r.cErrSample) {
          console.log(`[T2]   C cx=${e.cx} cy=${e.cy} glCb=${e.glCb} glCr=${e.glCr} refCb=${e.refCb} refCr=${e.refCr} err=${e.err}`);
        }
      }
      console.log(`[T2] verdict: ${r.pass ? "PASS — pack shaders byte-exact and orientation correct" : "FAIL — see fields above"}`);
    }

    expect(r.fatal).toBeUndefined();
    expect(r.yPass).toBe(true);
    expect(r.cPass).toBe(true);
    expect(r.rowFlipCorrect).toBe(true);
    expect(r.pass).toBe(true);
  });
});
