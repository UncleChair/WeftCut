// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { BlurFilter } from "pixi.js";
import type { EffectView } from "../../ipc";
import { EffectChain } from "./EffectChain";

const blur = (id: string, strength: number): EffectView => ({
  id, kind: "blur", enabled: true, params: { strength: { mode: "Static", value: strength } },
});

describe("EffectChain", () => {
  it("builds one BlurFilter and applies the resolved strength", () => {
    const chain = new EffectChain();
    const filters = chain.sync([blur("a", 5)], 0);
    expect(filters).toHaveLength(1);
    expect((filters[0] as BlurFilter).strength).toBe(5);
  });
  it("reuses the same instance across syncs (no rebuild on param-only change)", () => {
    const chain = new EffectChain();
    const f1 = chain.sync([blur("a", 5)], 0)[0];
    const f2 = chain.sync([blur("a", 9)], 0)[0];
    expect(f2).toBe(f1);
    expect((f2 as BlurFilter).strength).toBe(9);
  });
  it("disabled effects are excluded; unknown kinds skipped", () => {
    const chain = new EffectChain();
    const disabled: EffectView = { ...blur("a", 5), enabled: false };
    const unknown: EffectView = { id: "u", kind: "nope", enabled: true, params: {} };
    expect(chain.sync([disabled, unknown], 0)).toHaveLength(0);
  });
});
