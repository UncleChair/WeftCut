// apps/desktop/src/main/motif/staleness.ts
//
// Cross-project staleness (upload-authoring spec §7-B). A placed Motif layer
// stores the motif_version it was created with as a SEEN-AT marker — it does
// NOT pin rendering (the frame cache key is source-derived). On project open,
// comparing each marker against the catalog's current version surfaces "this
// Motif changed since you placed it (v1 → v3)". Acknowledging bumps markers to
// current in ONE undo entry via rebind_motif.
//
// Pure cores take exactly the data they need so they unit-test without an actor
// or disk. Mirrors native/src/motifs/staleness.rs (ported verbatim, Phase 3).
import type { Manifest } from '../../shared/motifs/catalog'
import type { BuiltinMotif } from './authoring'
import type { MotifRebindEntry } from '../state/model'

/** One row of the on-open staleness report, grouped by motif id. Wire-shaped
 *  (snake_case): the renderer's MotifStaleEntry + the e2e assert on these keys. */
export interface MotifStaleEntry {
  motif_id: string
  name: string
  /** Lowest seen-at version across the affected (stale) layers. */
  placed_version: number
  current_version: number
  layer_count: number
}

/** Current catalog versions: motif_id -> { name, version }. Built-ins first,
 *  then published user Motifs (insertion order makes the store win on a
 *  collision, matching Rust). Drafts are deliberately absent: always version 1,
 *  content-hash-keyed, so a draft layer can never read as stale. */
export function currentVersions(
  builtins: BuiltinMotif[],
  published: Manifest[],
): Map<string, { name: string; version: number }> {
  const map = new Map<string, { name: string; version: number }>()
  for (const b of builtins) map.set(b.manifest.id, { name: b.manifest.name, version: b.manifest.version })
  for (const m of published) map.set(m.id, { name: m.name, version: m.version })
  return map
}

/** Group (motifId, placedVersion) pairs into report rows. ANY inequality
 *  reports (downgrades included — same message shape); ids missing from
 *  `current` are skipped (the "unknown Motif" placeholder owns that case);
 *  layers already at current don't count. Sorted by motif id for a
 *  deterministic order (motif ids are sanitized ASCII, so default string sort
 *  matches the Rust BTreeMap byte order). */
export function buildStalenessReport(
  layers: Array<{ motifId: string; placedVersion: number }>,
  current: Map<string, { name: string; version: number }>,
): MotifStaleEntry[] {
  const grouped = new Map<string, { placed: number; count: number }>()
  for (const { motifId, placedVersion } of layers) {
    const cur = current.get(motifId)
    if (!cur) continue
    if (placedVersion === cur.version) continue
    const slot = grouped.get(motifId)
    if (slot) { slot.placed = Math.min(slot.placed, placedVersion); slot.count += 1 }
    else grouped.set(motifId, { placed: placedVersion, count: 1 })
  }
  return [...grouped.keys()].sort().map((id) => {
    const cur = current.get(id)!
    const slot = grouped.get(id)!
    return { motif_id: id, name: cur.name, placed_version: slot.placed, current_version: cur.version, layer_count: slot.count }
  })
}

/** Build the acknowledge set: every layer whose seen-at version differs from
 *  current keeps its id + props verbatim and gets motif_version = current. */
export function buildAckEntries(
  layers: Array<{ layerId: string; motifId: string; placedVersion: number; props: Record<string, unknown> }>,
  current: Map<string, { name: string; version: number }>,
): MotifRebindEntry[] {
  const out: MotifRebindEntry[] = []
  for (const { layerId, motifId, placedVersion, props } of layers) {
    const cur = current.get(motifId)
    if (!cur) continue
    if (cur.version === placedVersion) continue
    out.push({ layer_id: layerId, motif_id: motifId, motif_version: cur.version, props })
  }
  return out
}
