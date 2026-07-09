// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BlurFilter } from "pixi.js";
import { getDescriptor } from "./effectRegistry";
import { ChromaKeyFilter } from "./filters/ChromaKeyFilter";

import { listEffects } from "./effectRegistry";

describe("effectRegistry", () => {
  it("blur descriptor builds a BlurFilter and applies strength", () => {
    const d = getDescriptor("blur")!;
    expect(d.fidelity).toBe("f16-verified");
    const f = d.create();
    expect(f).toBeInstanceOf(BlurFilter);
    d.params.strength!.apply(f, 12);
    expect((f as BlurFilter).strength).toBe(12);
  });
  it("unknown kind returns null", () => {
    expect(getDescriptor("nope")).toBeNull();
  });
});

describe("listEffects", () => {
  it("returns the catalog including blur", () => {
    expect(listEffects().map((d) => d.kind)).toContain("blur");
  });
  it("blur strength carries a step and a [0,100] range", () => {
    const blur = listEffects().find((d) => d.kind === "blur")!;
    expect(blur.params.strength!.step).toBe(1);
    expect(blur.params.strength!.range).toEqual([0, 100]);
  });
  it("blur name i18n key is a nested leaf (effects.blur.name)", () => {
    const blur = listEffects().find((d) => d.kind === "blur")!;
    expect(blur.nameI18nKey).toBe("effects.blur.name");
  });
});

describe("chromakey", () => {
  it("descriptor builds a ChromaKeyFilter and routes params to uniforms", () => {
    const d = getDescriptor("chromakey")!;
    expect(d.fidelity).toBe("f16-verified");
    expect(d.nameI18nKey).toBe("effects.chromakey.name");
    const f = d.create();
    expect(f).toBeInstanceOf(ChromaKeyFilter);
    d.params.keyR!.apply(f, 0.25);
    d.params.balance!.apply(f, 0.9);
    const u = (f.resources as Record<string, { uniforms: Record<string, unknown> }>)
      .chromaUniforms!.uniforms;
    expect((u.uKey as Float32Array)[0]).toBeCloseTo(0.25);
    expect(u.uBalance).toBeCloseTo(0.9);
  });

  it("carries the 10 spec params, in spec order, with spec defaults", () => {
    const d = getDescriptor("chromakey")!;
    expect(Object.keys(d.params)).toEqual([
      "keyR", "keyG", "keyB", "balance", "clipBlack",
      "clipWhite", "despill", "feather", "shrink", "viewMatte",
    ]);
    expect(d.params.keyG!.default).toBe(1);
    expect(d.params.balance!.default).toBe(0.5);
    expect(d.params.clipWhite!.default).toBe(1);
    expect(d.params.despill!.default).toBe(1);
    expect(d.params.shrink!.range).toEqual([-5, 5]);
    expect(d.params.feather!.range).toEqual([0, 10]);
  });
});
