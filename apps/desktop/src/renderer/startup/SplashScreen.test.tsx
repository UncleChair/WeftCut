// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import iconSvg from "../public/icons/icon.svg?raw";
import { SplashScreen } from "./SplashScreen";

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SplashScreen launch mark", () => {
  it("uses the canonical icon cutout geometry through the full reveal", () => {
    const iconDocument = new DOMParser().parseFromString(iconSvg, "image/svg+xml");
    const canonicalCutout = iconDocument.querySelector(
      'mask path[fill="black"][stroke="black"]',
    );
    expect(canonicalCutout).not.toBeNull();

    const { container } = render(<SplashScreen onComplete={() => {}} />);
    const splashCutout = container.querySelector("#splash-w-cutout-shape");
    expect(splashCutout?.getAttribute("d")).toBe(
      canonicalCutout?.getAttribute("d"),
    );

    const cutoutUse = container.querySelector(
      'mask g[clip-path="url(#splash-w-reveal)"] use[href="#splash-w-cutout-shape"]',
    );
    expect(cutoutUse?.getAttribute("transform")).toBe("translate(100 0)");

    const reveal = container.querySelector("#splash-w-reveal rect");
    expect(reveal?.getAttribute("y")).toBe("120");
    expect(reveal?.getAttribute("height")).toBe("207");
  });
});
