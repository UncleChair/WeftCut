// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { BlurFilter } from "pixi.js";
import type { EffectView } from "../../ipc";
import { EffectChain } from "./EffectChain";
import {
  resetEffectOverrides,
  setEffectDisabled,
  setTransientOverrides,
} from "./effectOverrides";

afterEach(resetEffectOverrides);

const blur = (id: string, strength: number): EffectView => ({
  id, kind: "blur", enabled: true, params: { strength: { mode: "Static", value: strength } },
});

// Uniform layout per ChromaKeyFilter.ts:67-68.
function uKey(filter: unknown): Float32Array {
  return (filter as { resources: { chromaUniforms: { uniforms: { uKey: Float32Array } } } })
    .resources.chromaUniforms.uniforms.uKey;
}

const chromaView = (id: string): EffectView => ({
  id,
  kind: "chromakey",
  enabled: true,
  params: { keyR: { mode: "Static", value: 0.1 } },
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

describe("EffectChain × effectOverrides", () => {
  it("transient override wins over the resolved param value", () => {
    const chain = new EffectChain();
    const filters = chain.sync([chromaView("E1")], 0);
    expect(filters).toHaveLength(1);
    expect(uKey(filters[0]!)[0]).toBeCloseTo(0.1);
    setTransientOverrides("E1", { keyR: 0.9 });
    const again = chain.sync([chromaView("E1")], 0);
    expect(uKey(again[0]!)[0]).toBeCloseTo(0.9);
    chain.dispose();
  });
  it("disabled effect is excluded from the returned filter list without a rebuild", () => {
    const chain = new EffectChain();
    const before = chain.sync([chromaView("E1")], 0);
    setEffectDisabled("E1", true);
    expect(chain.sync([chromaView("E1")], 0)).toHaveLength(0);
    setEffectDisabled("E1", false);
    const after = chain.sync([chromaView("E1")], 0);
    // Same instance — exclusion is a return-filter, not a structural rebuild.
    expect(after[0]).toBe(before[0]);
    chain.dispose();
  });
});
