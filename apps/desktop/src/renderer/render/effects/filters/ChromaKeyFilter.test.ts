// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ChromaKeyFilter, type ChromaParamName } from "./ChromaKeyFilter";
import { CHROMA_UNIFORM_DEFAULTS } from "./chromaKeySources";

function uniforms(f: ChromaKeyFilter): Record<string, number | Float32Array> {
  return (f.resources as Record<string, { uniforms: Record<string, number | Float32Array> }>)
    .chromaUniforms!.uniforms;
}

describe("ChromaKeyFilter", () => {
  it("constructs with spec defaults (green key, balance 0.5)", () => {
    const f = new ChromaKeyFilter();
    const u = uniforms(f);
    expect(Array.from(u.uKey as Float32Array)).toEqual(CHROMA_UNIFORM_DEFAULTS.uKey);
    expect(u.uBalance).toBe(0.5);
    expect(u.uClipWhite).toBe(1);
    expect(u.uDespill).toBe(1);
    expect(u.uViewMatte).toBe(0);
  });

  it("applyParam maps every catalog param onto its uniform", () => {
    const f = new ChromaKeyFilter();
    const cases: Array<[ChromaParamName, () => number]> = [
      ["keyR", () => (uniforms(f).uKey as Float32Array)[0]!],
      ["keyG", () => (uniforms(f).uKey as Float32Array)[1]!],
      ["keyB", () => (uniforms(f).uKey as Float32Array)[2]!],
      ["balance", () => uniforms(f).uBalance as number],
      ["clipBlack", () => uniforms(f).uClipBlack as number],
      ["clipWhite", () => uniforms(f).uClipWhite as number],
      ["despill", () => uniforms(f).uDespill as number],
      ["feather", () => uniforms(f).uFeather as number],
      ["shrink", () => uniforms(f).uShrink as number],
      ["viewMatte", () => uniforms(f).uViewMatte as number],
    ];
    cases.forEach(([name, read], i) => {
      const v = 0.125 + i * 0.0625;
      f.applyParam(name, v);
      expect(read(), `param ${name}`).toBeCloseTo(v, 5);
    });
  });
});
