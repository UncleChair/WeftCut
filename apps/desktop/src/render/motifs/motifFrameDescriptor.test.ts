import { describe, expect, it } from "vitest";
import { getMotif, resolveMotifContentDurationUs } from "./catalog";
import { motifFrameDescriptor } from "./motifFrameDescriptor";
import { motifContentFrame, motifFrameCacheKey } from "./motifFrames";
import { canonicalizeProps } from "./Rasterizer";

function view(props: Record<string, unknown>, srcInUs = 0): any {
  return { template_id: "countdown", x: 0, y: 0, scale_x: 1, scale_y: 1, opacity: 1, src_in_us: srcInUs, props };
}

describe("motifFrameDescriptor", () => {
  const tpl = getMotif("countdown")!;
  it("matches the inline cacheKey + contentFrame computation (capped countdown)", () => {
    const v = view({ seconds: 6, accent: "#ff3366" });
    const tInLayerUs = 2_000_000;
    const d = motifFrameDescriptor(v, tInLayerUs, 5_000_000, 30, 1, tpl)!;
    const canonical = canonicalizeProps(v.props, tpl.manifest);
    const cap = resolveMotifContentDurationUs(tpl.manifest, v.props)!;
    const { frame, contentDurationFrames } = motifContentFrame(tInLayerUs, 0, cap, 30, 1);
    const expectedKey = motifFrameCacheKey({
      motifId: "countdown", version: tpl.manifest.version, canonicalProps: canonical,
      renderW: tpl.manifest.size[0], renderH: tpl.manifest.size[1], fpsNum: 30, fpsDen: 1,
      durationFrames: contentDurationFrames,
    });
    expect(d.cacheKey).toBe(expectedKey);
    expect(d.contentFrame).toBe(frame);
    expect(d.contentDurationFrames).toBe(contentDurationFrames);
  });
  it("applies src_in for a windowed layer", () => {
    const d = motifFrameDescriptor(view({ seconds: 6 }, 1_000_000), 0, 6_000_000, 30, 1, tpl)!;
    expect(d.srcInUs).toBe(1_000_000);
    expect(d.contentFrame).toBe(30);
    expect(d.contentDurationFrames).toBeGreaterThan(0);
  });
  it("content_duration_s: holds + dedups the tail, never windows", () => {
    const holdable: typeof tpl = {
      manifest: {
        id: "holdable",
        name: "Holdable",
        version: 1,
        size: [1280, 320],
        default_duration_s: 5,
        content_duration_s: 0.8,
        props_schema: {},
      },
    };
    // Layer 5 s wide; sample tInLayer = 3 s — well past the 0.8 s content.
    const d = motifFrameDescriptor(view({}, 1_000_000), 3_000_000, 5_000_000, 30, 1, holdable)!;
    expect(d.contentDurationUs).toBe(800_000);
    expect(d.contentDurationFrames).toBe(24); // round(0.8 * 30)
    expect(d.srcInUs).toBe(0); // holdable never windows, even with src_in set
    expect(d.contentFrame).toBe(d.contentDurationFrames - 1); // clamped to last → deduped hold
  });

  it("uncapped template uses layer width as content duration and ignores src_in", () => {
    const uncapped: typeof tpl = {
      ...tpl,
      manifest: {
        id: tpl.manifest.id,
        name: tpl.manifest.name,
        version: tpl.manifest.version,
        size: tpl.manifest.size,
        default_duration_s: tpl.manifest.default_duration_s,
        props_schema: tpl.manifest.props_schema,
      },
    };
    const durationUs = 4_000_000;
    const d = motifFrameDescriptor(view({}, 1_000_000), 2_000_000, durationUs, 30, 1, uncapped)!;
    expect(d.contentDurationUs).toBe(durationUs);
    expect(d.srcInUs).toBe(0);               // src_in ignored when uncapped
    expect(d.durationSec).toBeCloseTo(4, 6);
  });
});
