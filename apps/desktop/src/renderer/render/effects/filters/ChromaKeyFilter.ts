// Chroma key: the repo's first custom (non-stock) Pixi filter. Shader math
// lives in chromaKeySources.ts (shared with the f16 parity gate); this class
// is the pixi plumbing — dual program + uniform group + the scalar-param
// glue the effect registry drives every frame.

import { Filter, GlProgram, GpuProgram, UniformGroup } from "pixi.js";
import {
  CHROMA_FRAG_GL,
  CHROMA_VERT_GL,
  CHROMA_WGSL,
  CHROMA_UNIFORM_DEFAULTS,
} from "./chromaKeySources";

export type ChromaParamName =
  | "keyR"
  | "keyG"
  | "keyB"
  | "balance"
  | "clipBlack"
  | "clipWhite"
  | "despill"
  | "feather"
  | "shrink"
  | "viewMatte";

interface ChromaUniforms {
  uKey: Float32Array;
  uBalance: number;
  uClipBlack: number;
  uClipWhite: number;
  uDespill: number;
  uFeather: number;
  uShrink: number;
  uViewMatte: number;
}

export class ChromaKeyFilter extends Filter {
  constructor() {
    const d = CHROMA_UNIFORM_DEFAULTS;
    const gpuProgram = GpuProgram.from({
      vertex: { source: CHROMA_WGSL, entryPoint: "mainVertex" },
      fragment: { source: CHROMA_WGSL, entryPoint: "mainFragment" },
    });
    const glProgram = GlProgram.from({
      vertex: CHROMA_VERT_GL,
      fragment: CHROMA_FRAG_GL,
      name: "chromakey-filter",
    });
    super({
      gpuProgram,
      glProgram,
      resources: {
        chromaUniforms: new UniformGroup({
          uKey: { value: new Float32Array(d.uKey), type: "vec3<f32>" },
          uBalance: { value: d.uBalance, type: "f32" },
          uClipBlack: { value: d.uClipBlack, type: "f32" },
          uClipWhite: { value: d.uClipWhite, type: "f32" },
          uDespill: { value: d.uDespill, type: "f32" },
          uFeather: { value: d.uFeather, type: "f32" },
          uShrink: { value: d.uShrink, type: "f32" },
          uViewMatte: { value: d.uViewMatte, type: "f32" },
        }),
      },
    });
  }

  applyParam(name: ChromaParamName, value: number): void {
    const u = (this.resources as { chromaUniforms: { uniforms: ChromaUniforms } })
      .chromaUniforms.uniforms;
    switch (name) {
      case "keyR": u.uKey[0] = value; break;
      case "keyG": u.uKey[1] = value; break;
      case "keyB": u.uKey[2] = value; break;
      case "balance": u.uBalance = value; break;
      case "clipBlack": u.uClipBlack = value; break;
      case "clipWhite": u.uClipWhite = value; break;
      case "despill": u.uDespill = value; break;
      case "feather": u.uFeather = value; break;
      case "shrink": u.uShrink = value; break;
      case "viewMatte": u.uViewMatte = value; break;
    }
  }
}
