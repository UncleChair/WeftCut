// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CHROMA_FRAG_GL,
  CHROMA_VERT_GL,
  CHROMA_WGSL,
  CHROMA_UNIFORM_DEFAULTS,
} from "./chromaKeySources";

describe("chromaKeySources", () => {
  it("every uniform appears in BOTH fragment sources (dual-source drift guard)", () => {
    for (const name of Object.keys(CHROMA_UNIFORM_DEFAULTS)) {
      expect(CHROMA_FRAG_GL, `GLSL missing ${name}`).toContain(name);
      expect(CHROMA_WGSL, `WGSL missing ${name}`).toContain(name);
    }
  });

  it("WGSL carries both entry points; GL vertex is the pixi filter vertex", () => {
    expect(CHROMA_WGSL).toContain("mainVertex");
    expect(CHROMA_WGSL).toContain("mainFragment");
    expect(CHROMA_VERT_GL).toContain("filterVertexPosition");
  });

  it("stays loadable by the f16 gate's strip-export eval (no TS-only syntax)", () => {
    const text = readFileSync(
      fileURLToPath(new URL("./chromaKeySources.ts", import.meta.url)),
      "utf8",
    ).replace(/^export /gm, "");
    const mod = new Function(
      text + "\nreturn { CHROMA_FRAG_GL, CHROMA_UNIFORM_DEFAULTS };",
    )();
    expect(mod.CHROMA_FRAG_GL).toBe(CHROMA_FRAG_GL);
    expect(mod.CHROMA_UNIFORM_DEFAULTS).toEqual(CHROMA_UNIFORM_DEFAULTS);
  });
});
