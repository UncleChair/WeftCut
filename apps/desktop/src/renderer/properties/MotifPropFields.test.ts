import { describe, expect, it } from "vitest";
import { propKeyLabel } from "./MotifPropFields";

describe("propKeyLabel", () => {
  it("title-cases snake_case prop keys", () => {
    expect(propKeyLabel("bg_color")).toBe("Bg Color");
    expect(propKeyLabel("outline_width")).toBe("Outline Width");
    expect(propKeyLabel("h_align")).toBe("H Align");
  });

  it("capitalizes single-word keys and leaves digits alone", () => {
    expect(propKeyLabel("title")).toBe("Title");
    expect(propKeyLabel("color2")).toBe("Color2");
  });
});
