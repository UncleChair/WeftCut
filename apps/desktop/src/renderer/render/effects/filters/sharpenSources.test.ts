// @vitest-environment node
// The GPU-free guards on a dual-source shader: the same three as
// chromaKeySources.test.ts, plus one per load-bearing item the source's own
// header lists (three GLSL landmines and the uInputSize.zw / uInputClamp
// structure). CI cannot run the f16 parity gate; it can protect the gate's
// preconditions and the traps that only fail on the backend nobody ran.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SHARPEN_FRAG_GL,
  SHARPEN_WGSL,
  SHARPEN_UNIFORM_DEFAULTS,
} from "./sharpenSources";

describe("sharpenSources", () => {
  it("every uniform appears in BOTH fragment sources (dual-source drift guard)", () => {
    for (const name of Object.keys(SHARPEN_UNIFORM_DEFAULTS)) {
      expect(SHARPEN_FRAG_GL, `GLSL missing ${name}`).toContain(name);
      expect(SHARPEN_WGSL, `WGSL missing ${name}`).toContain(name);
    }
  });

  it("WGSL carries both entry points", () => {
    expect(SHARPEN_WGSL).toContain("mainVertex");
    expect(SHARPEN_WGSL).toContain("mainFragment");
  });

  it("stays loadable by the f16 gate's strip-export eval (no TS-only syntax)", () => {
    const text = readFileSync(
      fileURLToPath(new URL("./sharpenSources.ts", import.meta.url)),
      "utf8",
    ).replace(/^export /gm, "");
    const mod = new Function(
      text + "\nreturn { SHARPEN_FRAG_GL, SHARPEN_UNIFORM_DEFAULTS };",
    )();
    expect(mod.SHARPEN_FRAG_GL).toBe(SHARPEN_FRAG_GL);
    expect(mod.SHARPEN_UNIFORM_DEFAULTS).toEqual(SHARPEN_UNIFORM_DEFAULTS);
  });

  // Pixi decides isES300 by searching the FRAGMENT text for this literal, and
  // without it macro-collapses the shader down to WebGL1 — which has no
  // textureLod, so the program fails to compile on the export backend.
  it("declares #version 300 es on the GLSL fragment's first line", () => {
    expect(SHARPEN_FRAG_GL.split("\n")[0]).toBe("#version 300 es");
  });

  // uInputSize is shared with the vertex stage, which Pixi always compiles
  // highp; a real ES-3.00 linker rejects a uniform whose precision differs
  // across stages.
  it("declares uInputSize highp in the GLSL fragment", () => {
    expect(SHARPEN_FRAG_GL).toMatch(/uniform\s+highp\s+vec4\s+uInputSize\s*;/);
  });

  // Pixi injects `precision mediump float;` above this; ours has to follow it
  // and win, or the interpolated UVs quantise to fp16 and a one-texel tap on a
  // 4K frame (1/3840 in UV) lands between texels.
  it("overrides the default fragment precision to highp, before any declaration", () => {
    const body = SHARPEN_FRAG_GL.split("\n").filter((l) => l.trim() !== "");
    expect(body[1]).toBe("precision highp float;");
    expect(body.findIndex((l) => /^(in|out|uniform)\b/.test(l.trim()))).toBeGreaterThan(1);
  });

  // The structural reason this filter is self-authored rather than
  // pixi-filters' ConvolutionFilter (spec decision 4): the tap offset comes
  // from Pixi's global texel-size uniform, so it is one composition pixel at
  // every preview resolution and in the export, and taps are clamped into the
  // filter region so pooled residue can never bleed in.
  it("derives its tap offset from uInputSize.zw and clamps taps, on both backends", () => {
    for (const [backend, src] of [["GLSL", SHARPEN_FRAG_GL], ["WGSL", SHARPEN_WGSL]] as const) {
      expect(src, `${backend} hand-fed texel size`).toContain("uInputSize.zw");
      expect(src, `${backend} unclamped taps`).toContain("uInputClamp");
    }
  });
});
