// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BlurFilter } from "pixi.js";
import { getDescriptor } from "./effectRegistry";

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
