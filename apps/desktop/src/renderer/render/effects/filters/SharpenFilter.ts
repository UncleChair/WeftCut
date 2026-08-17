// Sharpen: the repo's second custom (non-stock) Pixi filter. Shader math lives
// in sharpenSources.ts (shared with the f16 parity gate); this class is the
// pixi plumbing — dual program + uniform group + the scalar-param glue the
// effect registry drives every frame. Same structure as ChromaKeyFilter,
// including the UBO residency pin both of them need.
//
// No `padding`: the kernel's edge behaviour comes from `uInputClamp`. Padding
// would draw the sprite's transparent surround into the taps and the negative
// lobes would ring it as a dark halo.

import { defaultFilterVert, Filter, GlProgram, GpuProgram, UniformGroup } from "pixi.js";
import {
  SHARPEN_FRAG_GL,
  SHARPEN_WGSL,
  SHARPEN_UNIFORM_DEFAULTS,
} from "./sharpenSources";
import { pinUniformBuffer, releaseUniformBuffer } from "./uniformBufferResidency";

export type SharpenParamName = "amount";

interface SharpenUniforms {
  uAmount: number;
}

export class SharpenFilter extends Filter {
  private readonly sharpenUniforms: UniformGroup;

  constructor() {
    const d = SHARPEN_UNIFORM_DEFAULTS;
    const gpuProgram = GpuProgram.from({
      vertex: { source: SHARPEN_WGSL, entryPoint: "mainVertex" },
      fragment: { source: SHARPEN_WGSL, entryPoint: "mainFragment" },
    });
    const glProgram = GlProgram.from({
      vertex: defaultFilterVert,
      fragment: SHARPEN_FRAG_GL,
      name: "sharpen-filter",
    });
    const sharpenUniforms = new UniformGroup({
      uAmount: { value: d.uAmount, type: "f32" },
    });
    super({
      gpuProgram,
      glProgram,
      resources: {
        sharpenUniforms,
      },
    });
    this.sharpenUniforms = sharpenUniforms;
  }

  override apply(...args: Parameters<Filter["apply"]>): void {
    super.apply(...args);
    pinUniformBuffer(this.sharpenUniforms);
  }

  override destroy(destroyPrograms = false): void {
    releaseUniformBuffer(this.sharpenUniforms);
    super.destroy(destroyPrograms);
  }

  /// Straight through, with no conversion: the shader owns the /100, per
  /// `SHARPEN_UNIFORM_DEFAULTS`.
  applyParam(name: SharpenParamName, value: number): void {
    const u = (this.resources as { sharpenUniforms: { uniforms: SharpenUniforms } })
      .sharpenUniforms.uniforms;
    switch (name) {
      case "amount": u.uAmount = value; break;
    }
  }
}
