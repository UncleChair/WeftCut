// apps/desktop/src/main/state/commands.ts
// Production command adapter: translates the renderer's real category-A
// channels + camelCase wire args into the gated TS actor mutation core.
// The byte-exact prod-differential gate is the backstop for every mapping.

/** Channels whose ONLY transform is camelCase→actor-arg renaming (no rich
 *  param construction). The layer-creation family is handled in actor.command. */
const MECHANICAL: Record<string, (a: Record<string, unknown>) => { op: string; args: Record<string, unknown> }> = {
  add_track: () => ({ op: 'add_track', args: { label: 'Track' } }),
  update_layer: (a) => ({ op: 'update_layer', args: { layer: a.layerId, patch: a.patch } }),
  // (more added in Task 4)
}

/** All production channels this adapter handles (mechanical + rich + meta). */
export const PRODUCTION_OPS = new Set<string>([
  'add_track', 'update_layer',
  // (extended in Tasks 3–4)
])

export function parseMechanical(channel: string, a: Record<string, unknown>): { op: string; args: Record<string, unknown> } | null {
  const fn = MECHANICAL[channel]
  return fn ? fn(a) : null
}
