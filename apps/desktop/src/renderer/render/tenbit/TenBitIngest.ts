// Converts TenBitFrames into per-clip textures through a Pixi mesh pass.
// Planes upload as RG8 (r = low byte, g = high byte of the
// u16LE sample) with NEAREST sampling — bilinear would interpolate the two
// bytes independently and produce garbage. Chroma is upsampled nearest.
//
// Dual-backend (GLSL + WGSL), mirroring Nv12Ingest: the 10-bit export worker
// runs on WebGL, the preview compositor on WebGPU. The render-target format is
// per-backend — see `build()`. The 10-bit normalization math (limited-range
// scales, owned BT.709 matrix) runs at full float precision on both.
//
// NOTE: VERT and FRAG below are duplicated verbatim in the 10-bit GL-parity
// gate (see apps/desktop/e2e) — keep both copies in sync.

import {
  BufferImageSource, Mesh, MeshGeometry, RenderTexture, Shader, Texture,
} from "pixi.js";
import type { Renderer } from "pixi.js";
import type { TenBitFrame } from "../decoder/tenBitFrame";
import { BT709, coefForMatrix, inverseCoef } from "./yuv10";

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

// WGSL twin of VERT+FRAG, following Nv12Ingest's group conventions:
// globalUniforms@group(0) and localUniforms@group(1) are declared with exactly
// those variable names so Pixi v8's mesh pipe auto-assigns their bind groups;
// our resources live in group(2), matched to `resources` keys by name. The
// math must stay in lockstep with VERT+FRAG above. (The vertex stage applies
// the mesh-local uTransformMatrix as Nv12Ingest's does — identity for the
// root-rendered ingest mesh, so the GL VERT, which omits it, computes the
// same positions.)
const WGSL = /* wgsl */ `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}

struct TenBitUniforms {
  uCoef: vec4<f32>,
  uScale: vec2<f32>,
  uYOff: f32,
}

@group(0) @binding(0) var<uniform> globalUniforms : GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms : LocalUniforms;

@group(2) @binding(0) var uY: texture_2d<f32>;
@group(2) @binding(1) var uYSampler: sampler;
@group(2) @binding(2) var uU: texture_2d<f32>;
@group(2) @binding(3) var uUSampler: sampler;
@group(2) @binding(4) var uV: texture_2d<f32>;
@group(2) @binding(5) var uVSampler: sampler;
@group(2) @binding(6) var<uniform> tenbit : TenBitUniforms;

struct VSOutput {
  @builtin(position) vPosition: vec4<f32>,
  @location(0) vUV: vec2<f32>,
}

@vertex
fn mainVert(
  @location(0) aPosition: vec2<f32>,
  @location(1) aUV: vec2<f32>,
) -> VSOutput {
  let mvp = globalUniforms.uProjectionMatrix
    * globalUniforms.uWorldTransformMatrix
    * localUniforms.uTransformMatrix;
  return VSOutput(
    vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0),
    aUV,
  );
}

fn decode10(t: vec4<f32>) -> f32 {
  return t.r * 255.0 + t.g * 255.0 * 256.0;
}

@fragment
fn mainFrag(
  @location(0) vUVIn: vec2<f32>,
) -> @location(0) vec4<f32> {
  let y  = (decode10(textureSample(uY, uYSampler, vUVIn)) - tenbit.uYOff) / tenbit.uScale.x;
  let cb = (decode10(textureSample(uU, uUSampler, vUVIn)) - 512.0) / tenbit.uScale.y;
  let cr = (decode10(textureSample(uV, uVSampler, vUVIn)) - 512.0) / tenbit.uScale.y;
  let rgb = vec3<f32>(
    y + tenbit.uCoef.x * cr,
    y - tenbit.uCoef.z * cr - tenbit.uCoef.y * cb,
    y + tenbit.uCoef.w * cb);
  return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}`;

interface ClipState {
  w: number; h: number;
  y: BufferImageSource; u: BufferImageSource; v: BufferImageSource;
  rt: RenderTexture;
  mesh: Mesh<MeshGeometry, Shader>;
  last: TenBitFrame | null;
}

function planeSource(data: Uint8Array, w: number, h: number): BufferImageSource {
  return new BufferImageSource({
    resource: data, width: w, height: h, format: "rg8unorm",
    alphaMode: "no-premultiply-alpha",
    scaleMode: "nearest",
  });
}

export class TenBitIngest {
  private states = new Map<string, ClipState>();
  private readonly isGl: boolean;
  constructor(private renderer: Renderer) {
    this.isGl = "gl" in renderer;
    // Chroma plane rows are (w/2)*2 = w bytes — not 4-aligned for w%4==2
    // sources (854/1918-wide). Pixi never touches UNPACK_ALIGNMENT; default 4
    // would skew those uploads. WebGL-only: the WebGPU upload path
    // (writeTexture) takes an explicit tight bytesPerRow, no row padding.
    if ("gl" in renderer) {
      renderer.gl.pixelStorei(renderer.gl.UNPACK_ALIGNMENT, 1);
    }
  }

  /// Convert `tb` (if not already current) and return the clip's converted RGB
  /// texture (rgba16float on WebGL, bgra8unorm on WebGPU). Keyed by layerId;
  /// textures are ingest-owned (callers must not destroy them).
  textureFor(key: string, tb: TenBitFrame): Texture {
    let s = this.states.get(key);
    if (s && (s.w !== tb.width || s.h !== tb.height)) {
      this.release(key);
      s = undefined;
    }
    if (!s) {
      s = this.build(tb);
      this.states.set(key, s);
    }
    if (s.last !== tb) {
      const cw = tb.width >> 1, ch = tb.height >> 1;
      s.y.resource = tb.data.subarray(tb.yOffset, tb.yOffset + tb.width * tb.height * 2);
      s.u.resource = tb.data.subarray(tb.uOffset, tb.uOffset + cw * ch * 2);
      s.v.resource = tb.data.subarray(tb.vOffset, tb.vOffset + cw * ch * 2);
      s.y.update(); s.u.update(); s.v.update();
      const full = tb.colorSpace?.fullRange === true;
      const coef = inverseCoef(coefForMatrix(tb.colorSpace?.matrix));
      const u = s.mesh.shader!.resources.tenbit.uniforms;
      u.uCoef = new Float32Array(coef);
      u.uScale = new Float32Array(full ? [1023, 1023] : [876, 896]);
      u.uYOff = full ? 0 : 64;
      this.renderer.render({ container: s.mesh, target: s.rt });
      s.last = tb;
    }
    return s.rt;
  }

  private build(tb: TenBitFrame): ClipState {
    const w = tb.width, h = tb.height, cw = w >> 1, ch = h >> 1;
    const y = planeSource(tb.data.subarray(tb.yOffset, tb.yOffset + w * h * 2), w, h);
    const u = planeSource(tb.data.subarray(tb.uOffset, tb.uOffset + cw * ch * 2), cw, ch);
    const v = planeSource(tb.data.subarray(tb.vOffset, tb.vOffset + cw * ch * 2), cw, ch);
    // WebGL keeps rgba16float — the 10-bit export's f16 compositing depends
    // on it (ADR 0022). WebGPU stores 8-bit: Pixi's WebGPU pipelines hard-code
    // bgra8unorm color targets (Nv12Ingest's LANDMINE — any other RT format
    // trips Dawn's attachment validation and the pass silently draws
    // nothing), and only the 8-bit preview canvas consumes this path there.
    const rtFormat = this.isGl ? ("rgba16float" as const) : ("bgra8unorm" as const);
    const rt = RenderTexture.create({ width: w, height: h, format: rtFormat });
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = Shader.from({
      gl: { vertex: VERT, fragment: FRAG },
      gpu: {
        vertex: { entryPoint: "mainVert", source: WGSL },
        fragment: { entryPoint: "mainFrag", source: WGSL },
      },
      resources: {
        uY: y, uYSampler: y.style,
        uU: u, uUSampler: u.style,
        uV: v, uVSampler: v.style,
        tenbit: {
          uCoef: { value: new Float32Array(inverseCoef(BT709)), type: "vec4<f32>" },
          uScale: { value: new Float32Array([876, 896]), type: "vec2<f32>" },
          uYOff: { value: 64, type: "f32" },
        },
      },
    });
    const mesh = new Mesh<MeshGeometry, Shader>({ geometry, shader });
    return { w, h, y, u, v, rt, mesh, last: null };
  }

  release(key: string): void {
    const s = this.states.get(key);
    if (!s) return;
    const { geometry, shader } = s.mesh;
    s.mesh.destroy();
    geometry.destroy();
    shader?.destroy();
    s.rt.destroy(true);
    s.y.destroy(); s.u.destroy(); s.v.destroy();
    this.states.delete(key);
  }

  dispose(): void {
    for (const k of [...this.states.keys()]) this.release(k);
  }
}
