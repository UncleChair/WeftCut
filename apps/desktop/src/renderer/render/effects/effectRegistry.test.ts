// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BlurFilter } from "pixi.js";
import { getDescriptor } from "./effectRegistry";

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
