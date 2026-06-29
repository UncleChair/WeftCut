import type { Layer, LayerParams, Marker, Project, Rgba, TrackRole, Uuid } from '../model'
import type { IdGen } from '../ids'
import { snapFrameRound } from '../snap'
import { applyDurationAutofit } from './helpers'
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

/** Snaps both edges, inserts t-start-sorted, autofits.
 *  Allocates the layer id only AFTER the track-existence check (id contract). */
export function applyAddLayer(p: Project, idGen: IdGen, trackId: Uuid, params: LayerParams, tStartUs: number, tEndUs: number): Uuid {
  const t0 = snapFrameRound(tStartUs, p.composition.fps.num, p.composition.fps.den)
  const t1 = snapFrameRound(tEndUs, p.composition.fps.num, p.composition.fps.den)
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

/** track.rs:65-79 defaults + actor.rs:2353-2380 insertion. */
export function applyAddTrack(p: Project, idGen: IdGen, label: string | null, transient = false, position?: number): Uuid {
  const id = idGen()
  const track = { id, label, enabled: true, locked: false, muted: false, solo: false, removable: true, role: null as TrackRole | null, transient, height_px: 64, layers: [] as Layer[] }
  const len = p.tracks.length
  const at = Math.min(position ?? len, len)
  p.tracks.splice(at, 0, track)
  return id
}

/** actor.rs:3101-3135 — marker inserted t-sorted, empty metadata. */
export function applyAddMarker(p: Project, idGen: IdGen, tUs: number, endTUs: number | null, label: string, color: Rgba): Uuid {
  const id = idGen()
  const marker: Marker = { id, t_us: tUs, end_t_us: endTUs, label, color, metadata: {} }
  const at = p.markers.findIndex((m) => m.t_us > tUs)
  p.markers.splice(at < 0 ? p.markers.length : at, 0, marker)
  return id
}
