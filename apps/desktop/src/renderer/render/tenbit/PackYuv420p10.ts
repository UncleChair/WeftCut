// f16 composite → yuv420p10le bytes via three byte-pack fragment passes into
// RGBA8 targets (each texel = two u16LE samples) + async PBO readback
// (submit/retrieve, see PboFrameReader — byte-exact). The pass samples the
// composite BILINEARLY at output resolution, so encoder downscale folds in
// here. Chroma = one bilinear tap at each 2×2 block midpoint (an exact box
// average). Readback needs no CPU row flip — see `PACK_ROW_FLIP`.
//
// NOTE: VERT, FRAG_Y, and FRAG_C below are duplicated by the 10-bit
// GL-parity gate — keep both copies byte-identical.

import { Mesh, MeshGeometry, RenderTexture, Shader } from "pixi.js";
import type { TextureSource, WebGLRenderer } from "pixi.js";
import type { Texture } from "pixi.js";
import { PboFrameReader } from "../yuv/pboReadback";

/// Pixi's GL renderer applies a Y-flip projection (y=0 = RT top), so
/// gl_FragCoord.y=0.5 corresponds to visual row 0 (top). readPixels at y=0
/// therefore gives the visual top row directly — no flip needed.
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

export class PackYuv420p10 {
  private y: Pass | null = null;
  private u: Pass | null = null;
  private v: Pass | null = null;
  private reader: PboFrameReader | null = null;
  private boundSource: TextureSource | null = null;

  constructor(
    private renderer: WebGLRenderer,
    private outW: number,
    private outH: number,
  ) {
    if (outW % 4 !== 0 || outH % 2 !== 0) {
      throw new Error(`PackYuv420p10: width%4==0 and height%2==0 required, got ${outW}x${outH}`);
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

  /// Render the three pack passes off `composite` and queue their async GPU
  /// readback (PBO + fence) — non-blocking. Pair every submit() with one
  /// retrieve(); at most two frames may be in flight.
  submit(composite: Texture): void {
    if (this.boundSource === null) {
      this.boundSource = composite.source;
    } else if (composite.source !== this.boundSource) {
      throw new Error("PackYuv420p10: composite texture changed after first submit() — recreate the packer");
    }
    const W = this.outW, H = this.outH;
    this.y ??= this.buildPass(FRAG_Y, W / 2, H, null, composite);
    this.u ??= this.buildPass(FRAG_C, W / 4, H / 2, 0, composite);
    this.v ??= this.buildPass(FRAG_C, W / 4, H / 2, 1, composite);
    const passes = [this.y, this.u, this.v];
    for (const pass of passes) {
      this.renderer.render({ container: pass.mesh, target: pass.rt });
    }
    this.reader ??= new PboFrameReader(
      this.renderer.gl,
      passes.map((p) => ({ w: p.w, h: p.h, dstRowBytes: p.w * 4, flipRows: PACK_ROW_FLIP })),
    );
    this.reader.submit((i) => this.renderer.renderTarget.bind(passes[i]!.rt, false));
  }

  /// Frames submitted but not yet retrieved.
  get pending(): number {
    return this.reader?.pending ?? 0;
  }

  /// Resolve the OLDEST submitted frame into one frame-owned buffer in
  /// yuv420p10le plane order — safe to transfer.
  retrieve(): Promise<Uint8Array> {
    if (!this.reader) throw new Error("PackYuv420p10: retrieve() before submit()");
    return this.reader.retrieve();
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
    this.reader?.dispose();
    this.reader = null;
  }
}
