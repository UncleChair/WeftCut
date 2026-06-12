// f16 composite → yuv420p10le bytes via three byte-pack fragment passes into
// RGBA8 targets (each texel = two u16LE samples) + readPixels (byte-exact).
// The pass samples the composite BILINEARLY at output resolution, so encoder
// downscale folds in here. Chroma = one bilinear tap at each 2×2 block
// midpoint (an exact box average). GL readback rows are bottom-up; rows are
// flipped on the CPU copy (PACK_ROW_FLIP, pinned by the parity e2e).

import { Mesh, MeshGeometry, RenderTexture, Shader } from "pixi.js";
import type { Renderer, Texture } from "pixi.js";

/// Pixi's GL renderer applies a Y-flip projection (y=0 = RT top), so
/// gl_FragCoord.y=0.5 corresponds to visual row 0 (top). readPixels at y=0
/// therefore gives the visual top row directly — no flip needed.
/// Pinned false by iso_tenbit_gl_parity T2 (2026-06-12).
const PACK_ROW_FLIP = false;

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

// Y pass: output texel x covers source pixels (2x, y) and (2x+1, y).
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

// Chroma pass: output texel x covers chroma samples (2x, y) and (2x+1, y) of
// a half-res plane; each chroma sample = bilinear tap at its 2×2 block
// midpoint. uSel selects Cb (0) or Cr (1).
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

interface Pass { rt: RenderTexture; mesh: Mesh<MeshGeometry, Shader>; w: number; h: number }

export class PackP010 {
  private y: Pass | null = null;
  private u: Pass | null = null;
  private v: Pass | null = null;
  private out: Uint8Array | null = null;
  private flip: Uint8Array | null = null;

  constructor(
    private renderer: Renderer,
    private outW: number,
    private outH: number,
  ) {
    if (outW % 4 !== 0 || outH % 2 !== 0) {
      throw new Error(`10-bit export needs width%4==0 and height%2==0, got ${outW}x${outH}`);
    }
  }

  private buildPass(frag: string, w: number, h: number, sel: number | null, composite: Texture): Pass {
    const rt = RenderTexture.create({ width: w, height: h, format: "rgba8unorm" });
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = Shader.from({
      gl: { vertex: VERT, fragment: frag },
      resources: {
        uC: composite.source,
        uCSampler: composite.source.style,
        pack: {
          uOut: { value: new Float32Array([this.outW, this.outH]), type: "vec2<f32>" },
          ...(sel !== null ? { uSel: { value: sel, type: "f32" } } : {}),
        },
      },
    });
    return { rt, mesh: new Mesh<MeshGeometry, Shader>({ geometry, shader }), w, h };
  }

  /// Render the three pack passes off `composite` and return one buffer in
  /// yuv420p10le plane order. The returned view is REUSED across calls —
  /// the caller must consume (send) it before the next pack().
  pack(composite: Texture): Uint8Array {
    const W = this.outW, H = this.outH;
    this.y ??= this.buildPass(FRAG_Y, W / 2, H, null, composite);
    this.u ??= this.buildPass(FRAG_C, W / 4, H / 2, 0, composite);
    this.v ??= this.buildPass(FRAG_C, W / 4, H / 2, 1, composite);
    const ySize = W * H * 2;
    const cSize = (W >> 1) * (H >> 1) * 2;
    this.out ??= new Uint8Array(ySize + 2 * cSize);
    for (const [pass, offset] of [
      [this.y, 0], [this.u, ySize], [this.v, ySize + cSize],
    ] as Array<[Pass, number]>) {
      this.renderer.render({ container: pass.mesh, target: pass.rt });
      this.readPlane(pass, this.out.subarray(offset, offset + pass.w * pass.h * 4));
    }
    return this.out;
  }

  private readPlane(pass: Pass, dst: Uint8Array): void {
    const renderer = this.renderer as Renderer & { gl: WebGL2RenderingContext };
    (renderer as unknown as { renderTarget: { bind(t: unknown, clear: boolean): void } })
      .renderTarget.bind(pass.rt, false);
    const gl = renderer.gl;
    const rowBytes = pass.w * 4;
    if (!PACK_ROW_FLIP) {
      gl.readPixels(0, 0, pass.w, pass.h, gl.RGBA, gl.UNSIGNED_BYTE, dst);
      return;
    }
    if (!this.flip || this.flip.length < dst.length) this.flip = new Uint8Array(dst.length);
    const tmp = this.flip.subarray(0, dst.length);
    gl.readPixels(0, 0, pass.w, pass.h, gl.RGBA, gl.UNSIGNED_BYTE, tmp);
    for (let r = 0; r < pass.h; r++) {
      dst.set(tmp.subarray(r * rowBytes, (r + 1) * rowBytes), (pass.h - 1 - r) * rowBytes);
    }
  }

  dispose(): void {
    for (const p of [this.y, this.u, this.v]) {
      if (p) { p.mesh.destroy(); p.rt.destroy(true); }
    }
    this.y = this.u = this.v = null;
    this.out = null;
    this.flip = null;
  }
}
