import { describe, expect, it } from "vitest";
import { withDefaultColorSpace } from "./colorSpaceDefault";

const base = (over: Partial<VideoDecoderConfig> = {}): VideoDecoderConfig =>
  ({ codec: "avc1.640028", codedWidth: 1920, codedHeight: 1080, ...over }) as VideoDecoderConfig;

describe("withDefaultColorSpace", () => {
  it("fills BT.709 for untagged HD (>=720 lines)", () => {
    const out = withDefaultColorSpace(base({ codedHeight: 1080 }));
    expect(out.colorSpace?.matrix).toBe("bt709");
    expect(out.colorSpace?.primaries).toBe("bt709");
    expect(out.colorSpace?.fullRange).toBe(false);
  });

  it("fills BT.601 (smpte170m) for untagged SD (<720 lines)", () => {
    const out = withDefaultColorSpace(base({ codedHeight: 480 }));
    expect(out.colorSpace?.matrix).toBe("smpte170m");
    expect(out.colorSpace?.primaries).toBe("smpte170m");
  });

  it("uses 720 as the HD threshold", () => {
    expect(withDefaultColorSpace(base({ codedHeight: 720 })).colorSpace?.matrix).toBe("bt709");
    expect(withDefaultColorSpace(base({ codedHeight: 719 })).colorSpace?.matrix).toBe("smpte170m");
  });

  it("leaves a source with an explicit matrix untouched", () => {
    const tagged = base({ colorSpace: { matrix: "smpte170m", primaries: "bt709", transfer: "bt709", fullRange: false } });
    const out = withDefaultColorSpace(tagged);
    expect(out).toEqual(tagged); // same field values — the per-field rebuild always returns a fresh object
    expect(out.colorSpace?.matrix).toBe("smpte170m");
  });

  it("fills only the missing fields of a partial tag (matrix absent)", () => {
    // primaries present but matrix omitted — fill matrix from resolution,
    // preserve the declared primaries.
    const partial = base({ codedHeight: 1080, colorSpace: { primaries: "bt470bg", fullRange: true } });
    const out = withDefaultColorSpace(partial);
    expect(out.colorSpace?.matrix).toBe("bt709"); // filled (HD)
    expect(out.colorSpace?.primaries).toBe("bt470bg"); // preserved
    expect(out.colorSpace?.fullRange).toBe(true); // preserved
  });

  it("uses sourceColor when mediabunny gives no matrix", () => {
    const out = withDefaultColorSpace(base({ codedHeight: 1080 }), { matrix: "smpte170m", fullRange: false });
    expect(out.colorSpace?.matrix).toBe("smpte170m"); // NOT the 709 HD default
    expect(out.colorSpace?.fullRange).toBe(false);
  });

  it("mediabunny tag still wins over sourceColor", () => {
    const cfg = base({ codedHeight: 1080, colorSpace: { matrix: "bt709" } });
    const out = withDefaultColorSpace(cfg, { matrix: "smpte170m" });
    expect(out.colorSpace?.matrix).toBe("bt709");
  });

  it("falls back to resolution default when both empty", () => {
    expect(withDefaultColorSpace(base({ codedHeight: 1080 })).colorSpace?.matrix).toBe("bt709");
  });

  it("sourceColor fullRange:true applies for a full-range source", () => {
    const out = withDefaultColorSpace(base({ codedHeight: 1080 }), { matrix: "bt709", fullRange: true });
    expect(out.colorSpace?.fullRange).toBe(true);
  });

  it("layers each field independently: mediabunny matrix + sourceColor primaries + resolution transfer", () => {
    // mediabunny: matrix only. sourceColor: primaries only. transfer: neither -> HD default.
    const cfg = base({ codedHeight: 1080, colorSpace: { matrix: "bt709" } });
    const out = withDefaultColorSpace(cfg, { primaries: "bt470bg" });
    expect(out.colorSpace?.matrix).toBe("bt709"); // mediabunny wins
    expect(out.colorSpace?.primaries).toBe("bt470bg"); // sourceColor fills
    expect(out.colorSpace?.transfer).toBe("bt709"); // resolution default
    expect(out.colorSpace?.fullRange).toBe(false); // resolution default
  });
});
