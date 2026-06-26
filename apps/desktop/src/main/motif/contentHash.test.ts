import { describe, it, expect } from "vitest";
import { motifContentHash } from "./contentHash";
import type { Manifest } from "../../shared/motifs/catalog";

const m: Manifest = { id: "x", name: "X", version: 1, size: [10, 10], default_duration_s: 1, props_schema: {} };

describe("motifContentHash", () => {
  it("is a 64-char lowercase hex sha256", () => {
    const h = motifContentHash(m, "<html></html>");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("is stable for identical inputs", () => {
    expect(motifContentHash(m, "<a/>")).toBe(motifContentHash(m, "<a/>"));
  });
  it("changes when html changes", () => {
    expect(motifContentHash(m, "<a/>")).not.toBe(motifContentHash(m, "<b/>"));
  });
  it("changes when a core manifest field changes", () => {
    expect(motifContentHash(m, "<a/>")).not.toBe(motifContentHash({ ...m, version: 2 }, "<a/>"));
  });
  it("ignores decoration fields (status/content_hash/target_id/settle_rafs)", () => {
    const decorated = { ...m, status: "draft", content_hash: "deadbeef", target_id: "y", settle_rafs: 3 } as Manifest;
    expect(motifContentHash(decorated, "<a/>")).toBe(motifContentHash(m, "<a/>"));
  });
});
