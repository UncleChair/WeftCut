// Converts NativeNv12Frames into per-clip RGBA8 textures through a Pixi
// WebGL2 mesh pass, selecting the YUV→RGB matrix from the frame's stamped
// colorSpace — Chromium's own buffer-frame conversion can't be trusted with
// it (why: see nv12Frame.ts). Mirrors TenBitIngest (the 10-bit twin);
// coefficient selection is shared via `coefForMatrix`.
//
// Y uploads as R8, interleaved CbCr as RG8 at half resolution. Chroma is
// upsampled nearest, matching the 10-bit lane.

import {
  BufferImageSource, Mesh, MeshGeometry, RenderTexture, Shader, Texture,
} from "pixi.js";
import type { WebGLRenderer } from "pixi.js";
import type { NativeNv12Frame } from "../decoder/nv12Frame";
import { BT709, coefForMatrix, inverseCoef } from "../tenbit/yuv10";

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
uniform sampler2D uUV;
uniform vec4 uCoef;   // crR, cbG, crG, cbB
uniform vec2 uScale;  // y scale (219 limited / 255 full), c scale (224 / 255)
uniform float uYOff;  // 16 limited / 0 full
void main() {
  float y = (texture(uY, vUV).r * 255.0 - uYOff) / uScale.x;
  vec2 c  = (texture(uUV, vUV).rg * 255.0 - 128.0) / uScale.y;
  vec3 rgb = vec3(
    y + uCoef.x * c.y,
    y - uCoef.z * c.y - uCoef.y * c.x,
    y + uCoef.w * c.x);
  finalColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

interface ClipState {
  w: number; h: number;
  y: BufferImageSource; uv: BufferImageSource;
  rt: RenderTexture;
  mesh: Mesh<MeshGeometry, Shader>;
  last: NativeNv12Frame | null;
}

function planeSource(
  data: Uint8Array, w: number, h: number, format: "r8unorm" | "rg8unorm",
): BufferImageSource {
  return new BufferImageSource({
    resource: data, width: w, height: h, format,
    alphaMode: "no-premultiply-alpha",
    scaleMode: "nearest",
  });
}

export class Nv12Ingest {
  private states = new Map<string, ClipState>();
  constructor(private renderer: WebGLRenderer) {
    // Plane rows are `w` bytes (Y and interleaved CbCr alike) — not 4-aligned
    // for w%4==2 sources (854/1918-wide). Pixi never touches UNPACK_ALIGNMENT;
    // default 4 would skew those uploads.
    this.renderer.gl.pixelStorei(this.renderer.gl.UNPACK_ALIGNMENT, 1);
  }

  /// Convert `f` (if not already current) and return the clip's RGBA8
  /// texture. Keyed by layerId; textures are ingest-owned (callers must not
  /// destroy them).
  textureFor(key: string, f: NativeNv12Frame): Texture {
    let s = this.states.get(key);
    if (s && (s.w !== f.width || s.h !== f.height)) {
      this.release(key);
      s = undefined;
    }
    if (!s) {
      s = this.build(f);
      this.states.set(key, s);
    }
    if (s.last !== f) {
      s.y.resource = f.data.subarray(0, f.width * f.height);
      s.uv.resource = f.data.subarray(f.uvOffset, f.uvOffset + f.width * (f.height >> 1));
      s.y.update(); s.uv.update();
      const full = f.colorSpace?.fullRange === true;
      const coef = inverseCoef(coefForMatrix(f.colorSpace?.matrix));
      const u = s.mesh.shader!.resources.nv12.uniforms;
      u.uCoef = new Float32Array(coef);
      u.uScale = new Float32Array(full ? [255, 255] : [219, 224]);
      u.uYOff = full ? 0 : 16;
      this.renderer.render({ container: s.mesh, target: s.rt });
      s.last = f;
    }
    return s.rt;
  }

  private build(f: NativeNv12Frame): ClipState {
    const w = f.width, h = f.height;
    const y = planeSource(f.data.subarray(0, w * h), w, h, "r8unorm");
    const uv = planeSource(
      f.data.subarray(f.uvOffset, f.uvOffset + w * (h >> 1)), w >> 1, h >> 1, "rg8unorm",
    );
    const rt = RenderTexture.create({ width: w, height: h, format: "rgba8unorm" });
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = Shader.from({
      gl: { vertex: VERT, fragment: FRAG },
      resources: {
        uY: y, uYSampler: y.style,
        uUV: uv, uUVSampler: uv.style,
        nv12: {
          uCoef: { value: new Float32Array(inverseCoef(BT709)), type: "vec4<f32>" },
          uScale: { value: new Float32Array([219, 224]), type: "vec2<f32>" },
          uYOff: { value: 16, type: "f32" },
        },
      },
    });
    const mesh = new Mesh<MeshGeometry, Shader>({ geometry, shader });
    return { w, h, y, uv, rt, mesh, last: null };
  }

  release(key: string): void {
    const s = this.states.get(key);
    if (!s) return;
    const { geometry, shader } = s.mesh;
    s.mesh.destroy();
    geometry.destroy();
    shader?.destroy();
    s.rt.destroy(true);
    s.y.destroy(); s.uv.destroy();
    this.states.delete(key);
  }

  dispose(): void {
    for (const k of [...this.states.keys()]) this.release(k);
  }
}
