// @vitest-environment jsdom
// The UBO-residency hazard, pinned over EVERY custom filter that owns a
// UniformGroup rather than in one filter's own file: Pixi's idle-resource GC
// unloading a filter-owned buffer that its bind-group cache still points at is
// a null crash on the next frame, and the two filters share one fix
// (uniformBufferResidency.ts). Data-driven, so the next custom filter is
// covered the moment it is added to the table.
import { Buffer, BufferUsage, GCSystem, type Filter, type UniformGroup } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { ChromaKeyFilter } from "./ChromaKeyFilter";
import { SharpenFilter } from "./SharpenFilter";

const FILTERS: Array<{ name: string; make: () => Filter; resource: string }> = [
  { name: "ChromaKeyFilter", make: () => new ChromaKeyFilter(), resource: "chromaUniforms" },
  { name: "SharpenFilter", make: () => new SharpenFilter(), resource: "sharpenUniforms" },
];

function group(f: Filter, resource: string): UniformGroup {
  return (f.resources as Record<string, UniformGroup>)[resource]!;
}

/// One `apply` with a filter manager that materialises the uniform buffer the
/// way Pixi's UboSystem does on the first WebGPU render of a UniformGroup.
function applyWithMaterializedUniformBuffer(f: Filter, resource: string): Buffer {
  let buffer: Buffer | null = null;
  const filterManager = {
    applyFilter: () => {
      buffer = new Buffer({
        data: new Float32Array(12),
        usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
      });
      group(f, resource).buffer = buffer;
    },
  };
  f.apply(filterManager as never, null as never, null as never, false);
  return buffer!;
}

describe.each(FILTERS)("$name uniform buffer", ({ make, resource }) => {
  it("stays resident while a cached filter is idle", () => {
    const f = make();
    const buffer = applyWithMaterializedUniformBuffer(f, resource);
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

  it("is released exactly once, however often the filter is destroyed", () => {
    const f = make();
    const buffer = applyWithMaterializedUniformBuffer(f, resource);
    const destroyBuffer = vi.spyOn(buffer, "destroy");

    f.destroy();
    f.destroy();

    expect(destroyBuffer).toHaveBeenCalledTimes(1);
    expect(buffer.destroyed).toBe(true);
  });

  it("can be destroyed before the WebGPU path materializes a buffer", () => {
    const f = make();
    expect(group(f, resource).buffer).toBeUndefined();

    expect(() => {
      f.destroy();
      f.destroy();
    }).not.toThrow();
  });
});
