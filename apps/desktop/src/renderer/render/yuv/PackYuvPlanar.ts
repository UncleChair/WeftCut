// Generalized GPU byte-pack: f16/rgba8 composite → planar YUV bytes for the
// native ffmpeg sink. Covers yuv420p / yuv422p (8-bit, 4 samples per RGBA8
// texel) and yuv422p10le (two u16LE samples per texel). yuv420p10le stays on
// the frozen PackYuv420p10 (its shaders are duplicated byte-identical by the
// 10-bit GL-parity gate). Structure mirrors PackYuv420p10: three passes
// (Y/Cb/Cr) sampled bilinearly at output resolution (encoder downscale folds
// in), BT.709 limited-range quantization in-shader, readPixels per plane.
// Rows may be padded to the texel boundary (yuvPlaneLayout.passW*4 >
// rowBytes); readback trims per row.

import { Mesh, MeshGeometry, RenderTexture, Shader } from "pixi.js";
import type { Texture, TextureSource, WebGLRenderer } from "pixi.js";
import type { NativePixFmt } from "../encodeTarget";
import { yuvPlaneLayout, type PlanePass, type YuvLayout } from "./yuvPlaneLayout";

export type PackablePixFmt = Exclude<NativePixFmt, "yuv420p10le">;

const VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}`;

// ---- 8-bit fragments: four samples per RGBA8 texel --------------------------
// Y' = 16 + 219*Y, C = 128 + 224*C (BT.709 limited, 8-bit quantization).
const FRAG_Y_8 = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uC;
uniform vec2 uOut;
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
float q(float y) { return clamp(floor(16.0 + y * 219.0 + 0.5), 0.0, 255.0); }
float lum(float px, float row) {
  return q(dot(texture(uC, vec2((px + 0.5) / uOut.x, (row + 0.5) / uOut.y)).rgb, KY));
}
void main() {
  float px = (gl_FragCoord.x - 0.5) * 4.0;
  float row = gl_FragCoord.y - 0.5;
  o = vec4(lum(px, row), lum(px + 1.0, row), lum(px + 2.0, row), lum(px + 3.0, row)) / 255.0;
}`;

// uSub: 2.0 = 4:2:0 (2x2 block midpoint), 1.0 = 4:2:2 (2x1 midpoint).
const FRAG_C_8 = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uC;
uniform vec2 uOut;
uniform float uSel;
uniform float uSub;
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
float qc(float c) { return clamp(floor(128.0 + c * 224.0 + 0.5), 0.0, 255.0); }
float chroma(float cx, float cy) {
  vec2 mid = vec2((2.0 * cx + 1.0) / uOut.x, (uSub * cy + 0.5 * uSub) / uOut.y);
  vec3 rgb = texture(uC, mid).rgb;
  float y = dot(rgb, KY);
  return qc(uSel < 0.5 ? (rgb.b - y) / 1.8556 : (rgb.r - y) / 1.5748);
}
void main() {
  float cx = (gl_FragCoord.x - 0.5) * 4.0;
  float cy = gl_FragCoord.y - 0.5;
  o = vec4(chroma(cx, cy), chroma(cx + 1.0, cy), chroma(cx + 2.0, cy), chroma(cx + 3.0, cy)) / 255.0;
}`;

// ---- 10-bit fragments (yuv422p10le): two u16LE samples per texel ------------
const FRAG_Y_10 = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uC;
uniform vec2 uOut;
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

const FRAG_C_10 = `#version 300 es
precision highp float;
out vec4 o;
uniform sampler2D uC;
uniform vec2 uOut;
uniform float uSel;
uniform float uSub;
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
float qc(float c) { return clamp(floor(512.0 + c * 896.0 + 0.5), 0.0, 1023.0); }
float chroma(float cx, float cy) {
  vec2 mid = vec2((2.0 * cx + 1.0) / uOut.x, (uSub * cy + 0.5 * uSub) / uOut.y);
  vec3 rgb = texture(uC, mid).rgb;
  float y = dot(rgb, KY);
  return uSel < 0.5 ? (rgb.b - y) / 1.8556 : (rgb.r - y) / 1.5748;
}
void main() {
  float cx = (gl_FragCoord.x - 0.5) * 2.0;
  float cy = gl_FragCoord.y - 0.5;
  float c0 = qc(chroma(cx, cy));
  float c1 = qc(chroma(cx + 1.0, cy));
  o = vec4(mod(c0, 256.0) / 255.0, floor(c0 / 256.0) / 255.0,
           mod(c1, 256.0) / 255.0, floor(c1 / 256.0) / 255.0);
}`;

interface Pass { rt: RenderTexture; mesh: Mesh<MeshGeometry, Shader>; plane: PlanePass }

export class PackYuvPlanar {
  private layout: YuvLayout;
  private y: Pass | null = null;
  private u: Pass | null = null;
  private v: Pass | null = null;
  private out: Uint8Array | null = null;
  private scratch: Uint8Array | null = null;
  private boundSource: TextureSource | null = null;

  constructor(
    private renderer: WebGLRenderer,
    private outW: number,
    private outH: number,
    private pixFmt: PackablePixFmt,
  ) {
    this.layout = yuvPlaneLayout(pixFmt, outW, outH); // throws on odd dims
  }

  private buildPass(frag: string, plane: PlanePass, sel: number | null, composite: Texture): Pass {
    const rt = RenderTexture.create({ width: plane.passW, height: plane.passH, format: "rgba8unorm" });
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, plane.passW, 0, plane.passW, plane.passH, 0, plane.passH]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const sub = this.pixFmt.startsWith("yuv420") ? 2 : 1;
    const shader = Shader.from({
      gl: { vertex: VERT, fragment: frag },
      resources: {
        uC: composite.source,
        uCSampler: composite.source.style,
        pack: {
          uOut: { value: new Float32Array([this.outW, this.outH]), type: "vec2<f32>" },
          uSub: { value: sub, type: "f32" },
          ...(sel !== null ? { uSel: { value: sel, type: "f32" } } : {}),
        },
      },
    });
    return { rt, mesh: new Mesh<MeshGeometry, Shader>({ geometry, shader }), plane };
  }

  /// Render the three pack passes off `composite` and return one buffer in
  /// planar order (Y, Cb, Cr). The returned view is REUSED across calls —
  /// the caller must consume (send/copy) it before the next pack().
  pack(composite: Texture): Uint8Array {
    if (this.boundSource === null) {
      this.boundSource = composite.source;
    } else if (composite.source !== this.boundSource) {
      throw new Error("PackYuvPlanar: composite texture changed after first pack() — recreate the packer");
    }
    const tenBit = this.layout.bytesPerSample === 2;
    this.y ??= this.buildPass(tenBit ? FRAG_Y_10 : FRAG_Y_8, this.layout.y, null, composite);
    this.u ??= this.buildPass(tenBit ? FRAG_C_10 : FRAG_C_8, this.layout.c, 0, composite);
    this.v ??= this.buildPass(tenBit ? FRAG_C_10 : FRAG_C_8, this.layout.c, 1, composite);
    this.out ??= new Uint8Array(this.layout.frameBytes);
    let offset = 0;
    for (const pass of [this.y, this.u, this.v]) {
      this.renderer.render({ container: pass.mesh, target: pass.rt });
      this.readPlane(pass, this.out.subarray(offset, offset + pass.plane.planeBytes));
      offset += pass.plane.planeBytes;
    }
    return this.out;
  }

  private readPlane(pass: Pass, dst: Uint8Array): void {
    this.renderer.renderTarget.bind(pass.rt, false);
    const gl = this.renderer.gl;
    const { passW, passH, rowBytes } = pass.plane;
    const paddedRow = passW * 4;
    if (paddedRow === rowBytes) {
      gl.readPixels(0, 0, passW, passH, gl.RGBA, gl.UNSIGNED_BYTE, dst);
      return;
    }
    // Padded pass rows (W not divisible by samples-per-texel): read the padded
    // target, then trim each row to the plane's valid byte count.
    const need = paddedRow * passH;
    if (!this.scratch || this.scratch.length < need) this.scratch = new Uint8Array(need);
    const tmp = this.scratch.subarray(0, need);
    gl.readPixels(0, 0, passW, passH, gl.RGBA, gl.UNSIGNED_BYTE, tmp);
    for (let r = 0; r < passH; r++) {
      dst.set(tmp.subarray(r * paddedRow, r * paddedRow + rowBytes), r * rowBytes);
    }
  }

  dispose(): void {
    for (const p of [this.y, this.u, this.v]) {
      if (p) {
        const { geometry, shader } = p.mesh;
        p.mesh.destroy();
        geometry.destroy();
        shader?.destroy();
        p.rt.destroy(true);
      }
    }
    this.y = this.u = this.v = null;
    this.boundSource = null;
    this.out = null;
    this.scratch = null;
  }
}
