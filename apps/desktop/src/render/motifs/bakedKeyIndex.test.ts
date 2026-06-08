import { describe, expect, it } from "vitest";
import { BakedKeyIndex } from "./bakedKeyIndex";

describe("BakedKeyIndex", () => {
  it("add / has by cacheKey", () => {
    const idx = new BakedKeyIndex();
    expect(idx.has("a")).toBe(false);
    idx.add("a");
    expect(idx.has("a")).toBe(true);
  });

  it("hydrate keeps only live keys whose hash is on disk", () => {
    const idx = new BakedKeyIndex();
    idx.setLiveCandidates(["live", "stale"]);
    idx.hydrateFromHashes(new Set(["deadbeef"]), (k) => (k === "live" ? "deadbeef" : "00000000"));
    expect(idx.has("live")).toBe(true);
    expect(idx.has("stale")).toBe(false);
  });

  it("clear empties the set", () => {
    const idx = new BakedKeyIndex();
    idx.add("a");
    idx.clear();
    expect(idx.has("a")).toBe(false);
  });
});
