import { describe, expect, it } from "vitest";
import {
  directionVector,
  shaderSourceFor,
  TRANSITION_GL_VERT,
  TRANSITION_SOURCES,
} from "./transitionSources";

describe("transition shader sources", () => {
  it("GL sources open with the load-bearing '#version 300 es' first line", () => {
    // Pixi's GlProgram sniffs the FRAGMENT text for the literal to pick
    // ES 3.0 — a leading newline or missing pragma silently downgrades to
    // WebGL1 and the compile fails (chromaKeySources.ts).
    expect(TRANSITION_GL_VERT.startsWith("#version 300 es\n")).toBe(true);
    for (const [kind, src] of Object.entries(TRANSITION_SOURCES)) {
      expect(src.glFragment.startsWith("#version 300 es\n"), `${kind} glFragment`).toBe(true);
      expect(src.glFragment, `${kind} glFragment precision`).toContain("precision highp float;");
    }
  });

  it("WGSL sources keep the mesh-pipe binding conventions", () => {
    // globalUniforms@group(0) / localUniforms@group(1) — those exact variable
    // names are how Pixi's mesh pipe auto-assigns bind groups (Nv12Ingest).
    for (const [kind, src] of Object.entries(TRANSITION_SOURCES)) {
      expect(src.wgsl, kind).toContain("var<uniform> globalUniforms");
      expect(src.wgsl, kind).toContain("var<uniform> localUniforms");
      expect(src.wgsl, kind).toContain("fn mainVert");
      expect(src.wgsl, kind).toContain("fn mainFrag");
    }
  });

  it("crossfade is the premultiplied mix of the two sides", () => {
    expect(TRANSITION_SOURCES.Crossfade!.glFragment).toContain("mix(a, b, uProgress)");
    expect(TRANSITION_SOURCES.Crossfade!.wgsl).toContain("transition.uProgress");
  });

  it("unknown kinds fall back to Crossfade and say so", () => {
    expect(shaderSourceFor("Crossfade")).toEqual({
      source: TRANSITION_SOURCES.Crossfade,
      isFallback: false,
    });
    // Wipe/Slide exist as kinds but gain shaders in a later ticket.
    expect(shaderSourceFor("Wipe")).toEqual({
      source: TRANSITION_SOURCES.Crossfade,
      isFallback: true,
    });
  });
});

describe("directionVector", () => {
  it("maps motion direction to screen-space (y down) unit vectors", () => {
    expect(directionVector({ kind: "Wipe", direction: "left" })).toEqual([-1, 0]);
    expect(directionVector({ kind: "Wipe", direction: "right" })).toEqual([1, 0]);
    expect(directionVector({ kind: "Slide", direction: "up" })).toEqual([0, -1]);
    expect(directionVector({ kind: "Slide", direction: "down" })).toEqual([0, 1]);
  });

  it("crossfade has no direction", () => {
    expect(directionVector({ kind: "Crossfade" })).toEqual([0, 0]);
  });
});
