import type { LayerParams, Project } from '../model'
import type { MotifRebindEntry } from '../model'
import { defaultTransform } from './add'

/** Build Motif LayerParams from canonicalized props + manifest version.
 *  Mirrors the MotifParams construction in commands/motifs.rs:198-205 and
 *  mcp/tools.rs:2079-2086. src_in_us=0, identity transform, Static(1) opacity. */
export function motifLayerParams(motifId: string, motifVersion: number, canonicalProps: Record<string, unknown>): LayerParams {
  return {
    kind: 'Motif',
    motif_id: motifId,
    motif_version: motifVersion,
    props: canonicalProps,
    src_in_us: 0,
    transform: defaultTransform(),
    opacity: { mode: 'Static', value: 1 },
  }
}

/** 1:1 port of do_rebind_motif (actor.rs:3711): set motif_id/version/props on the
 *  named Motif-param layers; non-Motif or missing layers are skipped. */
export function applyRebindMotif(draft: Project, updates: MotifRebindEntry[]): void {
  for (const u of updates) {
    for (const track of draft.tracks) {
      for (const layer of track.layers) {
        if (layer.id === u.layer_id && layer.params.kind === 'Motif') {
          layer.params.motif_id = u.motif_id
          layer.params.motif_version = u.motif_version
          layer.params.props = u.props as Record<string, unknown>
        }
      }
    }
  }
}
