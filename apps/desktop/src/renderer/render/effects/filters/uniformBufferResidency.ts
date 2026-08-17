// The two lines every filter that owns a UniformGroup has to get right.
//
// Pixi creates a filter-owned UBO lazily on the first WebGPU apply. Its GC can
// unload that buffer while EffectChain still owns the filter (a cached filter
// on a layer nobody is touching goes idle), but Pixi's bind-group cache then
// keeps pointing at the destroyed GPUBuffer — a null crash on the next frame
// that draws the layer. These tiny per-filter UBOs are worth keeping resident
// for the filter's lifetime; `destroy()` is their explicit release point.
//
// Lives here rather than in either filter because the hazard is not specific to
// one of them and the reasoning is easy to lose in a copy. Pinned for every
// custom filter by uniformBufferResidency.test.ts.

import type { UniformGroup } from "pixi.js";

/// Opt this group's GPU buffer out of Pixi's idle-resource GC, if the buffer
/// exists yet. Call from `apply`, which is the first place it can.
export function pinUniformBuffer(group: UniformGroup): void {
  const buffer = group.buffer;
  if (buffer) buffer.autoGarbageCollect = false;
}

/// Release a pinned buffer. Idempotent — a filter may be destroyed twice, and
/// a filter that never reached a WebGPU apply has no buffer at all.
export function releaseUniformBuffer(group: UniformGroup): void {
  const buffer = group.buffer;
  if (buffer && !buffer.destroyed) buffer.destroy();
}
