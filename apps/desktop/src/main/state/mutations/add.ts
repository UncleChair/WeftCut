import type { Layer, LayerParams, Marker, Project, Rgba, TrackRole, Uuid } from '../model'
import type { IdGen } from '../ids'
import { gridForLayerKind, snapOnGrid } from '../snap'
import { applyDurationAutofit } from './helpers'
import { snapMarkerTimes } from './markers'
import { CommandFailure } from '../errors'

export function colorParams(color: Rgba, width: number, height: number): LayerParams {
  return { kind: 'Color', color: { mode: 'Static', value: color }, width, height }
}
export function textParamsDefault(content: string): LayerParams {
  // Mirrors the replay driver's default_text_params (replay_driver.rs:747-758):
  // Inter 48 / weight 400 / white / Center / default transform / opacity 1 / Auto.
  return {
    kind: 'Text', content,
    font: { family: 'Inter', size_px: 48, weight: 400, italic: false },
    color: { mode: 'Static', value: { r: 255, g: 255, b: 255, a: 255 } },
    align: 'Center', transform: defaultTransform(), opacity: { mode: 'Static', value: 1 },
    shadow: null, outline: null, intro: null, outro: null, backend_hint: 'Auto',
  }
}
export function defaultTransform() {
  const s = (v: number) => ({ mode: 'Static' as const, value: v })
  return { x: s(0), y: s(0), scale_x: s(1), scale_y: s(1), rotation_deg: s(0), anchor: [0.5, 0.5] as [number, number] }
}

/** Snaps both edges onto the new layer's OWN grid — the 48 kHz sample lattice for an
 *  Audio layer, the composition frame grid otherwise (spec R2-D6) — inserts
 *  t-start-sorted, autofits.
 *
 *  An auto-paired A/V drop therefore gives the two members the same REQUESTED time
 *  resolved on two lattices. At the six rates where the frame lattice is an exact
 *  sublattice of 48 kHz they land identically; at 29.97 / 59.94 the audio lands on
 *  the sample boundary nearest the video frame — which is where the mixer would have
 *  played it anyway (`mix.rs` rounds `t_start_us` to a sample), so this stores what
 *  renders instead of a value that renders as something else.
 *
 *  Allocates the layer id only AFTER the track-existence check (id contract). */
export function applyAddLayer(p: Project, idGen: IdGen, trackId: Uuid, params: LayerParams, tStartUs: number, tEndUs: number): Uuid {
  const grid = gridForLayerKind(params.kind, p.composition.fps)
  const t0 = snapOnGrid(tStartUs, grid)
  const t1 = snapOnGrid(tEndUs, grid)
  const trackIdx = p.tracks.findIndex((t) => t.id === trackId)
  if (trackIdx < 0) throw new CommandFailure({ error: 'TrackNotFound', track: trackId })
  const layerId = idGen()
  const layer: Layer = { id: layerId, label: null, t_start_us: t0, t_end_us: t1, enabled: true, locked: false, metadata: {}, params, effects: [] }
  const track = p.tracks[trackIdx]
  const at = track.layers.findIndex((l) => l.t_start_us > t0)
  track.layers.splice(at < 0 ? track.layers.length : at, 0, layer)
  applyDurationAutofit(p)
  return layerId
}

/** Insert a new track with Track::new() defaults at `position` (default: end). */
export function applyAddTrack(p: Project, idGen: IdGen, label: string | null, transient = false, position?: number): Uuid {
  const id = idGen()
  const track = { id, label, enabled: true, locked: false, muted: false, solo: false, removable: true, role: null as TrackRole | null, transient, height_px: 64, layers: [] as Layer[] }
  const len = p.tracks.length
  const at = Math.min(position ?? len, len)
  p.tracks.splice(at, 0, track)
  return id
}

/** Marker inserted t-sorted, empty metadata. Times land on the composition frame
 *  grid via `snapMarkerTimes`, which also rejects a collapsed region — before the
 *  id is minted, so a rejected marker burns none (id contract). */
export function applyAddMarker(p: Project, idGen: IdGen, tUs: number, endTUs: number | null, label: string, color: Rgba): Uuid {
  const snapped = snapMarkerTimes(p, tUs, endTUs)
  const id = idGen()
  const marker: Marker = { id, t_us: snapped.tUs, end_t_us: snapped.endTUs, label, color, metadata: {} }
  const at = p.markers.findIndex((m) => m.t_us > snapped.tUs)
  p.markers.splice(at < 0 ? p.markers.length : at, 0, marker)
  return id
}
