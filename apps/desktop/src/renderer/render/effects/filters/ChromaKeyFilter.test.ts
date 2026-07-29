// @vitest-environment jsdom
import { Buffer, BufferUsage, GCSystem, type UniformGroup } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { ChromaKeyFilter, type ChromaParamName } from "./ChromaKeyFilter";
import { CHROMA_UNIFORM_DEFAULTS } from "./chromaKeySources";

function uniforms(f: ChromaKeyFilter): Record<string, number | Float32Array> {
  return (f.resources as Record<string, { uniforms: Record<string, number | Float32Array> }>)
    .chromaUniforms!.uniforms;
}

function chromaUniformGroup(f: ChromaKeyFilter): UniformGroup {
  return (f.resources as { chromaUniforms: UniformGroup }).chromaUniforms;
}

function applyWithMaterializedUniformBuffer(f: ChromaKeyFilter): Buffer {
  let buffer: Buffer | null = null;
  const filterManager = {
    applyFilter: () => {
      buffer = new Buffer({
        data: new Float32Array(12),
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      });
      // Pixi's UboSystem performs this same lazy assignment during the first
      // WebGPU render of a UniformGroup.
      chromaUniformGroup(f).buffer = buffer;
    },
  };
  f.apply(filterManager as never, null as never, null as never, false);
  return buffer!;
}

describe("ChromaKeyFilter", () => {
  it("constructs with spec defaults (green key, balance 0.5)", () => {
    const f = new ChromaKeyFilter();
    const u = uniforms(f);
    expect(Array.from(u.uKey as Float32Array)).toEqual(CHROMA_UNIFORM_DEFAULTS.uKey);
    expect(u.uBalance).toBe(0.5);
    expect(u.uClipWhite).toBe(1);
    expect(u.uDespill).toBe(1);
    expect(u.uViewMatte).toBe(0);
  });

  it("applyParam maps every catalog param onto its uniform", () => {
    const f = new ChromaKeyFilter();
    const cases: Array<[ChromaParamName, () => number]> = [
      ["keyR", () => (uniforms(f).uKey as Float32Array)[0]!],
      ["keyG", () => (uniforms(f).uKey as Float32Array)[1]!],
      ["keyB", () => (uniforms(f).uKey as Float32Array)[2]!],
      ["balance", () => uniforms(f).uBalance as number],
      ["clipBlack", () => uniforms(f).uClipBlack as number],
      ["clipWhite", () => uniforms(f).uClipWhite as number],
      ["despill", () => uniforms(f).uDespill as number],
      ["feather", () => uniforms(f).uFeather as number],
      ["shrink", () => uniforms(f).uShrink as number],
      ["viewMatte", () => uniforms(f).uViewMatte as number],
    ];
    cases.forEach(([name, read], i) => {
      const v = 0.125 + i * 0.0625;
      f.applyParam(name, v);
      expect(read(), `param ${name}`).toBeCloseTo(v, 5);
    });
  });

  it("keeps its uniform GPU buffer resident while a cached filter is idle", () => {
    const f = new ChromaKeyFilter();
    const buffer = applyWithMaterializedUniformBuffer(f);
    const gc = new GCSystem({} as never);
    gc.init({ gcActive: false, gcMaxUnusedTime: 60_000, gcFrequency: 30_000 });
    const managedBuffers = { items: { [buffer.uid]: buffer } };
    // GpuBufferSystem tracks its Buffer wrappers through this hash-based GC
    // path, which is the path that destroyed the observed chroma UBO.
    gc.addResourceHash(managedBuffers, "items", "resource");
    buffer._gcLastUsed = 0;
    const onUnload = vi.fn();
    buffer.on("unload", onUnload);
    const now = vi.spyOn(performance, "now").mockReturnValue(60_001);

    try {
      gc.run();
      expect(onUnload).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      gc.destroy();
      if (!buffer.destroyed) buffer.destroy();
      f.destroy();
    }
  });

  it("releases its retained uniform GPU buffer exactly once", () => {
    const f = new ChromaKeyFilter();
    const buffer = applyWithMaterializedUniformBuffer(f);
    const destroyBuffer = vi.spyOn(buffer, "destroy");

    f.destroy();
    f.destroy();

    expect(destroyBuffer).toHaveBeenCalledTimes(1);
    expect(buffer.destroyed).toBe(true);
  });

  it("can be destroyed before the WebGPU path materializes a uniform buffer", () => {
    const f = new ChromaKeyFilter();
    expect(chromaUniformGroup(f).buffer).toBeUndefined();

    expect(() => {
      f.destroy();
      f.destroy();
    }).not.toThrow();
  });
});
