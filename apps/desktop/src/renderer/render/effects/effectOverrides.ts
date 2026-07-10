// Transient, NON-recorded per-effect param overrides + disable flags for the
// color-pick session. EffectChain.sync() consults this AFTER resolveAnimated —
// sync rewrites every uniform from resolved params each frame, so writing
// filter uniforms directly gets clobbered on the next composite. Never enters
// React state or undo. Spec:
// docs/superpowers/specs/2026-07-11-color-picker-design.md

const overrides = new Map<string, Record<string, number>>();
const disabled = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setTransientOverrides(effectId: string, values: Record<string, number>): void {
  overrides.set(effectId, values);
  emit();
}

export function clearTransientOverrides(effectId: string): void {
  const had = overrides.delete(effectId);
  if (had) emit();
}

export function overrideFor(effectId: string, param: string): number | undefined {
  return overrides.get(effectId)?.[param];
}

export function setEffectDisabled(effectId: string, value: boolean): void {
  if (value) disabled.add(effectId);
  else disabled.delete(effectId);
  emit();
}

export function isEffectDisabled(effectId: string): boolean {
  return disabled.has(effectId);
}

/// PixiPreview subscribes to re-composite on change — paused playback renders
/// the stage every tick but only compositeFrame re-runs EffectChain.sync.
export function subscribeEffectOverrides(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function resetEffectOverrides(): void {
  overrides.clear();
  disabled.clear();
  emit();
}
