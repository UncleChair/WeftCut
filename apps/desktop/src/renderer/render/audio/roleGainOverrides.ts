// Transient, NON-recorded per-Role gain overrides for a live fader audition.
// While a Role Gain fader gesture is in flight the Role Mixer writes the dragged
// dB here; the Compositor's audio pass consults it (via
// `auditionedRoleGainLinear` in roleGate.ts) instead of the committed Role gain,
// so the change is audible before it is committed. Release commits one
// `setRoleGain` and clears the override; Escape clears it without recording.
// Never enters React state or undo, and export never sees it. Mirrors the
// per-effect color-pick overrides in effectOverrides.ts; the recorded-gain and
// audition semantics are documented in `docs/audio.md`.

import type { AudioRole } from "../../ipc";

const overrides = new Map<AudioRole, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/// Begin/continue an audition: the Compositor folds `gainDb` in place of the
/// committed Role gain on the next composite.
export function setRoleGainOverride(role: AudioRole, gainDb: number): void {
  overrides.set(role, gainDb);
  emit();
}

/// End an audition (commit or cancel). No-op — and no notification — when the
/// Role had no active override, so a stray clear can't churn the preview.
export function clearRoleGainOverride(role: AudioRole): void {
  if (overrides.delete(role)) emit();
}

/// The auditioned dB for a Role, or `undefined` when no gesture is active.
export function roleGainOverrideDb(role: AudioRole): number | undefined {
  return overrides.get(role);
}

/// PixiPreview subscribes to re-composite on change — the audio pass only
/// re-derives the mixer from the override inside `compositeFrame`.
export function subscribeRoleGainOverrides(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function resetRoleGainOverrides(): void {
  if (overrides.size === 0) return;
  overrides.clear();
  emit();
}
