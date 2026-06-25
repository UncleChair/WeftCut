import type { Project } from '../model'
import type { MotifRebindEntry } from '../model'

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
