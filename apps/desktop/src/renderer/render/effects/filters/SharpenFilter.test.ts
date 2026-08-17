// @vitest-environment jsdom
// The plumbing, as ChromaKeyFilter.test.ts does it. The UBO-residency half of
// that file's coverage lives in uniformBufferResidency.test.ts, which runs over
// every custom filter including this one.
import { describe, expect, it } from "vitest";
import { SharpenFilter } from "./SharpenFilter";
import { SHARPEN_UNIFORM_DEFAULTS } from "./sharpenSources";

function uniforms(f: SharpenFilter): Record<string, number> {
  return (f.resources as Record<string, { uniforms: Record<string, number> }>)
    .sharpenUniforms!.uniforms;
}

describe("SharpenFilter", () => {
  it("constructs at the shader source's default amount (a pass-through)", () => {
    const f = new SharpenFilter();
    expect(uniforms(f).uAmount).toBe(SHARPEN_UNIFORM_DEFAULTS.uAmount);
    expect(uniforms(f).uAmount).toBe(0);
  });

  it("sets no padding — edge behaviour comes from uInputClamp", () => {
    // Padding would draw the sprite's transparent surround into the kernel and
    // the negative lobes would ring it as a dark halo.
    expect(new SharpenFilter().padding).toBe(0);
  });

  it("applyParam carries the catalog's amount into the uniform as a percentage", () => {
    const f = new SharpenFilter();
    // Straight through, no /100 here: the shader owns the scale so the parity
    // gate, which loads the shader source but not this class, drives the same
    // number the slider shows.
    for (const v of [0, 1, 60, 100]) {
      f.applyParam("amount", v);
      expect(uniforms(f).uAmount, `amount ${v}`).toBe(v);
    }
  });

  it("builds both programs, so neither backend is half-shipped", () => {
    const f = new SharpenFilter();
    expect(f.glProgram.fragment).toContain("uAmount");
    expect(f.gpuProgram?.fragment?.entryPoint).toBe("mainFragment");
    expect(f.gpuProgram?.vertex?.entryPoint).toBe("mainVertex");
  });
});
