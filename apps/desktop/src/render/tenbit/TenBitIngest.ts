// Converts TenBitFrames into per-clip RGBA16F textures through a Pixi
// WebGL2 mesh pass. Planes upload as RG8 (r = low byte, g = high byte of the
// u16LE sample) with NEAREST sampling — bilinear would interpolate the two
// bytes independently and produce garbage. Chroma is upsampled nearest (v1).
//
// NOTE: VERT and FRAG below are copied verbatim into
// e2e/tools/iso_tenbit_gl_parity.e2e.js (the GL-parity gate) — keep both in sync.

import {
  BufferImageSource, Mesh, MeshGeometry, RenderTexture, Shader, Texture,
} from "pixi.js";
import type { WebGLRenderer } from "pixi.js";
import type { TenBitFrame } from "../decoder/tenBitFrame";
import { BT601, BT709, inverseCoef } from "./yuv10";

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
  constructor(private renderer: WebGLRenderer) {
    // Chroma plane rows are (w/2)*2 = w bytes — not 4-aligned for w%4==2
    // sources (854/1918-wide). Pixi never touches UNPACK_ALIGNMENT; default 4
    // would skew those uploads.
    this.renderer.gl.pixelStorei(this.renderer.gl.UNPACK_ALIGNMENT, 1);
  }

  /// Convert `tb` (if not already current) and return the clip's RGBA16F
  /// texture. Keyed by layerId; textures are ingest-owned (callers must not
  /// destroy them).
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
      const m = tb.colorSpace?.matrix;
      // bt470bg is PAL 601 — identical kr/kb to smpte170m (both are BT.601).
      const coef = inverseCoef(m === "smpte170m" || m === "bt470bg" ? BT601 : BT709);
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
    const rt = RenderTexture.create({ width: w, height: h, format: "rgba16float" });
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = Shader.from({
      gl: { vertex: VERT, fragment: FRAG },
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
