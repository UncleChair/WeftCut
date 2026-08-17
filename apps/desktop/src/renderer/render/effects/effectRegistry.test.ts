// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BlurFilter, ColorMatrixFilter } from "pixi.js";
import { getDescriptor } from "./effectRegistry";
import { ChromaKeyFilter } from "./filters/ChromaKeyFilter";
import { SharpenFilter } from "./filters/SharpenFilter";
import { writeBrightness, writeContrast, writeSaturation } from "./filters/colorMatrices";

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

  it("declares the key color as an eyedropper color group", () => {
    const d = getDescriptor("chromakey")!;
    expect(d.colorGroups).toEqual([{ params: ["keyR", "keyG", "keyB"] }]);
  });
});

describe("the colour-matrix trio", () => {
  // kind → the writer it must be wired to. The pairing is the thing worth
  // pinning: all three descriptors are the same shape, so a copy-paste that
  // hands contrast the brightness writer type-checks and renders.
  const TRIO = {
    brightness: writeBrightness,
    contrast: writeContrast,
    saturation: writeSaturation,
  } as const;

  const expected = (write: (out: number[], v: number) => void, v: number): number[] => {
    const m = new Array<number>(20).fill(NaN);
    write(m, v);
    return m;
  };

  for (const [kind, write] of Object.entries(TRIO)) {
    it(`${kind} builds a ColorMatrixFilter on the shared calibration`, () => {
      const d = getDescriptor(kind)!;
      expect(d.kind).toBe(kind);
      expect(d.category).toBe("color");
      expect(d.fidelity).toBe("f16-verified");
      expect(d.colorspace).toBe("display-gamma");
      expect(d.nameI18nKey).toBe(`effects.${kind}.name`);
      expect(d.colorGroups).toBeUndefined();
      expect(Object.keys(d.params)).toEqual(["amount"]);
      expect(d.params.amount!.default).toBe(0);
      expect(d.params.amount!.range).toEqual([-100, 100]);
      expect(d.params.amount!.step).toBe(1);
      expect(d.create()).toBeInstanceOf(ColorMatrixFilter);
    });

    it(`${kind} writes its own matrix into the live uniform array, in place`, () => {
      const d = getDescriptor(kind)!;
      const f = d.create() as ColorMatrixFilter;
      const live = f.matrix;
      d.params.amount!.apply(f, -40);
      // Same array object — the setter (which swaps the uniform reference on
      // every frame) must never be reached.
      expect(f.matrix).toBe(live);
      expect([...f.matrix]).toEqual(expected(write, -40));
      // uAlpha at 0 makes the fragment early-return the untouched colour.
      expect(f.alpha).toBe(1);
    });

    it(`${kind} at amount 0 leaves the identity matrix`, () => {
      const d = getDescriptor(kind)!;
      const f = d.create() as ColorMatrixFilter;
      d.params.amount!.apply(f, 0);
      expect([...f.matrix]).toEqual([
        1, 0, 0, 0, 0,
        0, 1, 0, 0, 0,
        0, 0, 1, 0, 0,
        0, 0, 0, 1, 0,
      ]);
    });
  }

  it("saturation is the Rec.709 entry — the one pixi's own helper gets wrong", () => {
    const d = getDescriptor("saturation")!;
    const f = d.create() as ColorMatrixFilter;
    d.params.amount!.apply(f, -100);
    expect(f.matrix[0]).toBeCloseTo(0.2126, 6);
    expect(f.matrix[1]).toBeCloseTo(0.7152, 6);
    expect(f.matrix[2]).toBeCloseTo(0.0722, 6);
  });

  it("all three are in the catalog under Color", () => {
    const byKind = new Map(listEffects().map((d) => [d.kind, d]));
    for (const kind of Object.keys(TRIO)) {
      expect(byKind.get(kind)?.category, kind).toBe("color");
    }
  });
});

describe("sharpen", () => {
  it("descriptor builds a SharpenFilter and routes amount to its uniform", () => {
    const d = getDescriptor("sharpen")!;
    expect(d.fidelity).toBe("f16-verified");
    expect(d.colorspace).toBe("display-gamma");
    expect(d.nameI18nKey).toBe("effects.sharpen.name");
    expect(d.colorGroups).toBeUndefined();
    const f = d.create();
    expect(f).toBeInstanceOf(SharpenFilter);
    d.params.amount!.apply(f, 60);
    const u = (f.resources as Record<string, { uniforms: Record<string, unknown> }>)
      .sharpenUniforms!.uniforms;
    expect(u.uAmount).toBe(60);
  });

  it("breaks the shared calibration deliberately: [0, 100], no negative", () => {
    // A negative unsharp amount is a box blur, and `blur` is already in the
    // catalog — one way to soften an image, called Blur.
    const d = getDescriptor("sharpen")!;
    expect(Object.keys(d.params)).toEqual(["amount"]);
    expect(d.params.amount!.range).toEqual([0, 100]);
    expect(d.params.amount!.step).toBe(1);
    expect(d.params.amount!.default).toBe(0);
  });

  it("is the catalog's Stylise entry", () => {
    const byKind = new Map(listEffects().map((d) => [d.kind, d]));
    expect(byKind.get("sharpen")?.category).toBe("stylize");
  });
});
