// @vitest-environment jsdom
// apps/desktop/src/renderer/render/fonts/loadFontsIntoFaceSet.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFontsIntoFaceSet } from "./loadFontsIntoFaceSet";

describe("loadFontsIntoFaceSet", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("constructs and adds one FontFace per family", async () => {
    const added: string[] = [];
    const fakeSet = { add: (f: { family: string }) => added.push(f.family) } as unknown as FontFaceSet;
    // jsdom lacks FontFace; stub a minimal one that resolves load().
    vi.stubGlobal("FontFace", class {
      family: string;
      constructor(family: string) { this.family = family; }
      load() { return Promise.resolve(this); }
    });
    await loadFontsIntoFaceSet(fakeSet, {
      "Liberation Sans": new ArrayBuffer(4),
      "Noto Sans SC": new ArrayBuffer(4),
    });
    expect(added.sort()).toEqual(["Liberation Sans", "Noto Sans SC"]);
  });
});
