import { describe, expect, it } from "vitest";
import {
  directionVector,
  shaderSourceFor,
  slideSampleUv,
  TRANSITION_GL_VERT,
  TRANSITION_SOURCES,
  wipeShowsIncoming,
} from "./transitionSources";

describe("transition shader sources", () => {
  it("all three kinds have shaders", () => {
    expect(Object.keys(TRANSITION_SOURCES).sort()).toEqual(["Crossfade", "Slide", "Wipe"]);
    for (const kind of ["Crossfade", "Wipe", "Slide"]) {
      expect(shaderSourceFor(kind)).toEqual({
        source: TRANSITION_SOURCES[kind],
        isFallback: false,
      });
    }
  });

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
    expect(shaderSourceFor("Iris")).toEqual({
      source: TRANSITION_SOURCES.Crossfade,
      isFallback: true,
    });
  });

  it("wipe pins its swept-coordinate formula and boundary convention on both backends", () => {
    // Same math, same boundary: swept coordinate t, then step(t, progress)
    // — GLSL and WGSL step() both give the t == p boundary pixel to B.
    const wipe = TRANSITION_SOURCES.Wipe!;
    expect(wipe.glFragment).toContain("float t = dot(vUV - 0.5, uDirection) + 0.5;");
    expect(wipe.glFragment).toContain("mix(a, b, step(t, uProgress))");
    expect(wipe.wgsl).toContain("let t = dot(vUV - vec2<f32>(0.5), transition.uDirection) + 0.5;");
    expect(wipe.wgsl).toContain("mix(a, b, vec4<f32>(step(t, transition.uProgress)))");
  });

  it("slide pins its offset formula, in-shader bounds guard, and premultiplied over", () => {
    const slide = TRANSITION_SOURCES.Slide!;
    expect(slide.glFragment).toContain("vec2 uvB = vUV + uDirection * (1.0 - uProgress);");
    // Bounds guard is IN-SHADER — the RT sampler clamps, which would smear
    // B's edge pixels; both bounds inclusive on both backends.
    expect(slide.glFragment).toContain("step(vec2(0.0), uvB) * step(uvB, vec2(1.0))");
    expect(slide.wgsl).toContain(
      "let uvB = vUV + transition.uDirection * (1.0 - transition.uProgress);",
    );
    expect(slide.wgsl).toContain("step(vec2<f32>(0.0), uvB) * step(uvB, vec2<f32>(1.0))");
    // Premultiplied over-composite of B onto A — no mid-transition darkening.
    expect(slide.glFragment).toContain("finalColor = b + a * (1.0 - b.a);");
    expect(slide.wgsl).toContain("return b + a * (1.0 - b.a);");
  });
});

describe("directionVector", () => {
  it("maps motion direction to screen-space (y down) unit vectors for BOTH kinds", () => {
    // One convention serves both kinds: the vector points where the moving
    // thing travels. Wipe reads it as the boundary's sweep axis; Slide as
    // the sampling offset that walks B in along its motion. UV space is
    // y-down like screen space, so the vector feeds both shaders unmapped.
    for (const kind of ["Wipe", "Slide"] as const) {
      expect(directionVector({ kind, direction: "left" }), kind).toEqual([-1, 0]);
      expect(directionVector({ kind, direction: "right" }), kind).toEqual([1, 0]);
      expect(directionVector({ kind, direction: "up" }), kind).toEqual([0, -1]);
      expect(directionVector({ kind, direction: "down" }), kind).toEqual([0, 1]);
    }
  });

  it("crossfade has no direction", () => {
    expect(directionVector({ kind: "Crossfade" })).toEqual([0, 0]);
  });
});

// Interior pixel-center-like sample grid — exact 0/1 UVs never occur at
// pixel centers, so the twins are exercised where real fragments live.
const GRID: [number, number][] = [];
for (let x = 0.05; x < 1; x += 0.15) {
  for (let y = 0.05; y < 1; y += 0.15) GRID.push([x, y]);
}

describe("wipe formula twin", () => {
  const left = directionVector({ kind: "Wipe", direction: "left" });
  const right = directionVector({ kind: "Wipe", direction: "right" });
  const up = directionVector({ kind: "Wipe", direction: "up" });
  const down = directionVector({ kind: "Wipe", direction: "down" });

  it("shows all A at p=0 and all B at p=1, every direction", () => {
    for (const dir of [left, right, up, down]) {
      for (const uv of GRID) {
        expect(wipeShowsIncoming(uv, dir, 0), `p=0 dir=${dir} uv=${uv}`).toBe(false);
        expect(wipeShowsIncoming(uv, dir, 1), `p=1 dir=${dir} uv=${uv}`).toBe(true);
      }
    }
  });

  it("'left' sweeps the boundary right-to-left: at p the boundary is at x = 1 - p", () => {
    // Region already swept (x > 1 - p) shows B; unswept shows A.
    expect(wipeShowsIncoming([0.8, 0.5], left, 0.25)).toBe(true);
    expect(wipeShowsIncoming([0.7, 0.5], left, 0.25)).toBe(false);
    // Boundary pixel (t == p exactly) belongs to B — the step() convention
    // shared by both backends.
    expect(wipeShowsIncoming([0.75, 0.5], left, 0.25)).toBe(true);
  });

  it("'right' sweeps left-to-right; 'up' bottom-to-top; 'down' top-to-bottom", () => {
    expect(wipeShowsIncoming([0.2, 0.5], right, 0.25)).toBe(true);
    expect(wipeShowsIncoming([0.3, 0.5], right, 0.25)).toBe(false);
    // y grows down: 'up' starts at the bottom edge (y = 1).
    expect(wipeShowsIncoming([0.5, 0.8], up, 0.25)).toBe(true);
    expect(wipeShowsIncoming([0.5, 0.7], up, 0.25)).toBe(false);
    expect(wipeShowsIncoming([0.5, 0.2], down, 0.25)).toBe(true);
    expect(wipeShowsIncoming([0.5, 0.3], down, 0.25)).toBe(false);
  });
});

describe("slide formula twin", () => {
  const left = directionVector({ kind: "Slide", direction: "left" });
  const down = directionVector({ kind: "Slide", direction: "down" });

  it("B is fully offscreen at p=0 and at identity at p=1, every direction", () => {
    for (const d of ["left", "right", "up", "down"] as const) {
      const dir = directionVector({ kind: "Slide", direction: d });
      for (const uv of GRID) {
        expect(slideSampleUv(uv, dir, 0).inRange, `p=0 ${d} uv=${uv}`).toBe(false);
        const atEnd = slideSampleUv(uv, dir, 1);
        expect(atEnd.uv, `p=1 ${d} uv=${uv}`).toEqual([...uv]);
        expect(atEnd.inRange, `p=1 ${d} uv=${uv}`).toBe(true);
      }
    }
  });

  it("'left' enters from the right edge: at p, B covers x >= 1 - p showing its own left part", () => {
    // B's content is displaced (1 - p) x frame in +x, so the screen pixel
    // samples B at x - (1 - p): in range only right of the leading edge.
    const covered = slideSampleUv([0.75, 0.5], left, 0.5);
    expect(covered.inRange).toBe(true);
    expect(covered.uv[0]).toBeCloseTo(0.25);
    expect(slideSampleUv([0.25, 0.5], left, 0.5).inRange).toBe(false);
  });

  it("'down' enters from the top edge (y grows down)", () => {
    const covered = slideSampleUv([0.5, 0.25], down, 0.5);
    expect(covered.inRange).toBe(true);
    expect(covered.uv[1]).toBeCloseTo(0.75);
    expect(slideSampleUv([0.5, 0.75], down, 0.5).inRange).toBe(false);
  });
});
