import { describe, expect, it } from "vitest";
import { getTemplate, resolveTemplateContentDurationUs } from "./catalog";
import { templateFrameDescriptor } from "./templateFrameDescriptor";
import { templateContentFrame, templateFrameCacheKey } from "../sprite/TemplateSprite";
import { canonicalizeProps } from "./Rasterizer";

function view(props: Record<string, unknown>, srcInUs = 0): any {
  return { template_id: "countdown", x: 0, y: 0, scale_x: 1, scale_y: 1, opacity: 1, src_in_us: srcInUs, props };
}

describe("templateFrameDescriptor", () => {
  const tpl = getTemplate("countdown")!;
  it("matches the inline cacheKey + contentFrame computation (capped countdown)", () => {
    const v = view({ seconds: 6, color: "#ff3366" });
    const tInLayerUs = 2_000_000;
    const d = templateFrameDescriptor(v, tInLayerUs, 5_000_000, 30, 1, tpl)!;
    const canonical = canonicalizeProps(v.props, tpl.manifest);
    const cap = resolveTemplateContentDurationUs(tpl.manifest, v.props)!;
    const { frame, contentDurationFrames } = templateContentFrame(tInLayerUs, 0, cap, 30, 1);
    const expectedKey = templateFrameCacheKey({
      templateId: "countdown", version: tpl.manifest.version, canonicalProps: canonical,
      renderW: tpl.manifest.size[0], renderH: tpl.manifest.size[1], fpsNum: 30, fpsDen: 1,
      durationFrames: contentDurationFrames,
    });
    expect(d.cacheKey).toBe(expectedKey);
    expect(d.contentFrame).toBe(frame);
    expect(d.contentDurationFrames).toBe(contentDurationFrames);
  });
  it("applies src_in for a windowed layer", () => {
    const d = templateFrameDescriptor(view({ seconds: 6 }, 1_000_000), 0, 6_000_000, 30, 1, tpl)!;
    expect(d.srcInUs).toBe(1_000_000);
    expect(d.contentFrame).toBe(30);
  });
});
