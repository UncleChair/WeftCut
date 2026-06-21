// @vitest-environment jsdom
// jsdom is required because BlurFilter touches the DOM (canvas APIs).

import { describe, expect, it } from "vitest";
import { BlurFilter } from "pixi.js";
import { EffectChain } from "./EffectChain";
import { effectsFor } from "./effectsFor";

describe("effectsFor", () => {
  it("returns a BlurFilter for a layer with a blur effect", () => {
    const chain = new EffectChain();
    const layer = {
      id: "l",
      effects: [
        {
          id: "a",
          kind: "blur",
          enabled: true,
          params: { strength: { mode: "Static", value: 4 } },
        },
      ],
    } as unknown as Parameters<typeof effectsFor>[1];
    const filters = effectsFor(chain, layer, 0);
    expect(filters[0]).toBeInstanceOf(BlurFilter);
  });

  it("returns an empty array when effects is undefined", () => {
    const chain = new EffectChain();
    const layer = { id: "l" } as unknown as Parameters<typeof effectsFor>[1];
    const filters = effectsFor(chain, layer, 0);
    expect(filters).toHaveLength(0);
  });

  it("returns an empty array when all effects are disabled", () => {
    const chain = new EffectChain();
    const layer = {
      id: "l",
      effects: [
        {
          id: "a",
          kind: "blur",
          enabled: false,
          params: { strength: { mode: "Static", value: 4 } },
        },
      ],
    } as unknown as Parameters<typeof effectsFor>[1];
    const filters = effectsFor(chain, layer, 0);
    expect(filters).toHaveLength(0);
  });

  it("returns no filters when preview effects are disabled", () => {
    const chain = new EffectChain();
    const layer = {
      id: "l",
      effects: [
        {
          id: "a",
          kind: "blur",
          enabled: true,
          params: { strength: { mode: "Static", value: 4 } },
        },
      ],
    } as unknown as Parameters<typeof effectsFor>[1];
    expect(effectsFor(chain, layer, 0, { previewEffectsEnabled: false })).toHaveLength(0);
  });

  it("returns filters when preview effects are enabled (explicit true)", () => {
    const chain = new EffectChain();
    const layer = {
      id: "l",
      effects: [
        {
          id: "a",
          kind: "blur",
          enabled: true,
          params: { strength: { mode: "Static", value: 4 } },
        },
      ],
    } as unknown as Parameters<typeof effectsFor>[1];
    const filters = effectsFor(chain, layer, 0, { previewEffectsEnabled: true });
    expect(filters[0]).toBeInstanceOf(BlurFilter);
  });

  it("returns filters when opts is omitted (default enabled)", () => {
    const chain = new EffectChain();
    const layer = {
      id: "l",
      effects: [
        {
          id: "a",
          kind: "blur",
          enabled: true,
          params: { strength: { mode: "Static", value: 4 } },
        },
      ],
    } as unknown as Parameters<typeof effectsFor>[1];
    const filters = effectsFor(chain, layer, 0);
    expect(filters[0]).toBeInstanceOf(BlurFilter);
  });
});
