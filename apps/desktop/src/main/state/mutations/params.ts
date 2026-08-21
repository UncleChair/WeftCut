import type { Animated, AudioParams, AudioRole, ColorParams, ImageOverlayParams, Layer, MotifParams, Project, Rgba, TextAlign, TextParams, Uuid, VAlign, VideoClipParams } from '../model'
import { CommandFailure } from '../errors'
import { snapFrameFloor, snapFrameCeil, gridForLayerKind, snapOnGrid } from '../snap'
import { checkTrackLock, locateLayer, applyDurationAutofit } from './helpers'
import { normalizeKeyframes } from './animated'
import type { MotifCatalog } from '../../../shared/motifs/catalog'
import { resolveMotifMaxDurUs } from '../../../shared/motifs/catalog'

/** Internally-tagged ("kind") param patch. Every field optional bar kind;
 *  absent = "don't touch".
 *
 *  Text carries no `scale_x`/`scale_y` on purpose: an agent asking for a bigger
 *  title gets a bigger BOX, because the box lays glyphs out and scale magnifies
 *  the rendered result (ADR 0049). `box_w`/`box_h` are the one pair where
 *  `null` is a value distinct from absent — see the `case 'Text'` merge. */
export type LayerParamsPatch =
  | { kind: 'Text'; content?: string; font_family?: string; font_size_px?: number; color?: Rgba; x?: number; y?: number; opacity?: number; align?: TextAlign; valign?: VAlign; box_w?: number | null; box_h?: number | null; line_height?: number; letter_spacing?: number }
  | { kind: 'VideoClip'; src_in_us?: number; src_out_us?: number; x?: number; y?: number; scale_x?: number; scale_y?: number; opacity?: number; speed?: number; flip_h?: boolean; flip_v?: boolean; fade_in_us?: number; fade_out_us?: number }
  | { kind: 'ImageOverlay'; x?: number; y?: number; scale_x?: number; scale_y?: number; opacity?: number; fade_in_us?: number; fade_out_us?: number }
  | { kind: 'Motif'; x?: number; y?: number; scale_x?: number; scale_y?: number; opacity?: number; src_in_us?: number; motif_id?: string; motif_version?: number; props?: Record<string, unknown> }
  | { kind: 'Color'; color?: Rgba; width?: number; height?: number }
  | { kind: 'Audio'; src_in_us?: number; src_out_us?: number; gain_db?: number; pan?: number; fade_in_us?: number; fade_out_us?: number; mute?: boolean; role?: AudioRole }

const stat = <T>(value: T): Animated<T> => ({ mode: 'Static', value })

/** The Text enums, as values — the patch arrives from MCP as untyped JSON, so the
 *  types alone guard nothing at runtime. Listed here and not in `model.ts` because
 *  this is the only site that needs them as data. */
const TEXT_ALIGNS: readonly TextAlign[] = ['Left', 'Center', 'Right']
const VALIGNS: readonly VAlign[] = ['Top', 'Middle', 'Bottom']

/** apply_params_patch — kind-matched field merge; a discriminant
 *  mismatch is the only error. Animated fields collapse to Static(v) (MVP: this
 *  overwrites any keyframe track). Motif props merge field-wise (never replace). */
export function applyParamsPatch(layer: Layer, patch: LayerParamsPatch): void {
  const p = layer.params
  if (p.kind !== patch.kind) {
    throw new CommandFailure({ error: 'LayerParamsKindMismatch', layer: layer.id, actual: p.kind, patch: patch.kind })
  }
  switch (patch.kind) {
    case 'Text': {
      const t = p as TextParams
      // MCP hands this layer untyped JSON (`parseObj` + a cast), so the Text arm's
      // enums and box numbers are checked here rather than trusted. It is the edge
      // half of ADR 0049's pair — refuse at the edge, never blank the screen
      // mid-render — and the renderer's coalescing is the other half. Unchecked,
      // `valign: 'Center'` reaches `VALIGN_FRAC[valign]` as `undefined` and lands a
      // NaN anchor on the sprite, which is a VANISHED layer rather than a
      // misplaced one.
      if (patch.align !== undefined && !TEXT_ALIGNS.includes(patch.align)) {
        throw new CommandFailure({ error: 'InvalidArgument', field: 'align', detail: `align must be one of ${TEXT_ALIGNS.join(' | ')}` })
      }
      if (patch.valign !== undefined && !VALIGNS.includes(patch.valign)) {
        throw new CommandFailure({ error: 'InvalidArgument', field: 'valign', detail: `valign must be one of ${VALIGNS.join(' | ')}` })
      }
      // A box axis is either null (auto) or a real positive extent. Zero and
      // negative are refused because they are not a narrow box, they are a broken
      // mode: the renderer reads a non-positive width as "no box" and would render
      // Auto width while state claimed Fixed. Deliberately NOT the gesture's 8 px
      // floor — that one is a drag ergonomic, and a 4 px box an agent asks for on
      // purpose is legal, just silly.
      for (const field of ['box_w', 'box_h'] as const) {
        const v = patch[field]
        if (v !== undefined && v !== null && !(Number.isFinite(v) && v > 0)) {
          throw new CommandFailure({ error: 'InvalidArgument', field, detail: `${field} must be a positive number of composition pixels, or null for auto` })
        }
      }
      for (const field of ['line_height', 'letter_spacing'] as const) {
        const v = patch[field]
        if (v !== undefined && !Number.isFinite(v)) {
          throw new CommandFailure({ error: 'InvalidArgument', field, detail: `${field} must be a finite number` })
        }
      }
      // The resize mode IS the box nullability — (null, null) auto width,
      // (set, null) auto height, (set, set) fixed — so (null, set) is no mode at
      // all. A gesture reaching that pair backfills the width it measured in the
      // same commit; this layer has no canvas, and inventing a width would be the
      // silent clamp ADR 0048 rules out, so MCP's route to it refuses. Refusing
      // BEFORE the first write is load-bearing: a rejected patch must leave the
      // project byte-identical. A patch touching NEITHER box field still passes
      // through an already-illegal (hand-edited) layer, which the renderer
      // coalesces to auto width — refusing there would make the file unfixable.
      if (patch.box_w !== undefined || patch.box_h !== undefined) {
        const w = patch.box_w !== undefined ? patch.box_w : t.box_w
        const h = patch.box_h !== undefined ? patch.box_h : t.box_h
        if (w === null && h !== null) {
          throw new CommandFailure({ error: 'InvalidArgument', field: 'box_h',
            detail: 'a text box height with no width is not a resize mode: send box_w in the same patch for fixed, or leave box_h null — the modes are (null, null) auto width, (set, null) auto height, (set, set) fixed' })
        }
      }
      if (patch.content !== undefined) t.content = patch.content
      if (patch.font_family !== undefined) t.font.family = patch.font_family
      if (patch.font_size_px !== undefined) t.font.size_px = patch.font_size_px
      if (patch.color !== undefined) t.color = stat(patch.color)
      if (patch.x !== undefined) t.transform.x = stat(patch.x)
      if (patch.y !== undefined) t.transform.y = stat(patch.y)
      if (patch.opacity !== undefined) t.opacity = stat(patch.opacity)
      if (patch.align !== undefined) t.align = patch.align
      if (patch.valign !== undefined) t.valign = patch.valign
      // On the box pair the absent/null split is LOAD-BEARING, not the incidental
      // "don't touch" it is everywhere else: null is the only way to say "back to
      // auto", so an `=== undefined` guard here is the whole wire contract.
      if (patch.box_w !== undefined) t.box_w = patch.box_w
      if (patch.box_h !== undefined) t.box_h = patch.box_h
      if (patch.line_height !== undefined) t.line_height = patch.line_height
      if (patch.letter_spacing !== undefined) t.letter_spacing = patch.letter_spacing
      return
    }
    case 'VideoClip': {
      const v = p as VideoClipParams
      if (patch.src_in_us !== undefined) v.src_in_us = patch.src_in_us
      if (patch.src_out_us !== undefined) v.src_out_us = patch.src_out_us
      if (patch.x !== undefined) v.transform.x = stat(patch.x)
      if (patch.y !== undefined) v.transform.y = stat(patch.y)
      if (patch.scale_x !== undefined) v.transform.scale_x = stat(patch.scale_x)
      if (patch.scale_y !== undefined) v.transform.scale_y = stat(patch.scale_y)
      if (patch.opacity !== undefined) v.opacity = stat(patch.opacity)
      if (patch.speed !== undefined) v.speed = patch.speed
      if (patch.flip_h !== undefined) v.flip_h = patch.flip_h
      if (patch.flip_v !== undefined) v.flip_v = patch.flip_v
      if (patch.fade_in_us !== undefined) v.fade_in_us = patch.fade_in_us
      if (patch.fade_out_us !== undefined) v.fade_out_us = patch.fade_out_us
      return
    }
    case 'ImageOverlay': {
      const i = p as ImageOverlayParams
      if (patch.x !== undefined) i.transform.x = stat(patch.x)
      if (patch.y !== undefined) i.transform.y = stat(patch.y)
      if (patch.scale_x !== undefined) i.transform.scale_x = stat(patch.scale_x)
      if (patch.scale_y !== undefined) i.transform.scale_y = stat(patch.scale_y)
      if (patch.opacity !== undefined) i.opacity = stat(patch.opacity)
      if (patch.fade_in_us !== undefined) i.fade_in_us = patch.fade_in_us
      if (patch.fade_out_us !== undefined) i.fade_out_us = patch.fade_out_us
      return
    }
    case 'Motif': {
      const m = p as MotifParams
      if (patch.x !== undefined) m.transform.x = stat(patch.x)
      if (patch.y !== undefined) m.transform.y = stat(patch.y)
      if (patch.scale_x !== undefined) m.transform.scale_x = stat(patch.scale_x)
      if (patch.scale_y !== undefined) m.transform.scale_y = stat(patch.scale_y)
      if (patch.opacity !== undefined) m.opacity = stat(patch.opacity)
      if (patch.src_in_us !== undefined) m.src_in_us = patch.src_in_us
      if (patch.motif_id !== undefined) m.motif_id = patch.motif_id
      if (patch.motif_version !== undefined) m.motif_version = patch.motif_version
      if (patch.props !== undefined) for (const k of Object.keys(patch.props)) m.props[k] = patch.props[k]
      return
    }
    case 'Color': {
      const c = p as ColorParams
      if (patch.color !== undefined) c.color = stat(patch.color)
      if (patch.width !== undefined) c.width = patch.width
      if (patch.height !== undefined) c.height = patch.height
      return
    }
    case 'Audio': {
      const au = p as AudioParams
      if (patch.src_in_us !== undefined) au.src_in_us = patch.src_in_us
      if (patch.src_out_us !== undefined) au.src_out_us = patch.src_out_us
      if (patch.gain_db !== undefined) au.gain_db = stat(patch.gain_db)
      if (patch.pan !== undefined) au.pan = stat(patch.pan)
      if (patch.fade_in_us !== undefined) au.fade_in_us = patch.fade_in_us
      if (patch.fade_out_us !== undefined) au.fade_out_us = patch.fade_out_us
      if (patch.mute !== undefined) au.mute = patch.mute
      if (patch.role !== undefined) au.role = patch.role
      return
    }
  }
}

/** update_layer_params (mutation half): lock-check, locate,
 *  field-merge, then Motif content-window clamp.
 *  After the field-merge: if the layer is a Motif with a known catalog entry and
 *  a finite contentDur, and the placed window exceeds that contentDur, clamp
 *  src_in_us + t_end_us into the new content. Growing never resizes.
 *
 *  LANDMINE: JS numbers are exact to 2^53 µs — consistent with the
 *  resolveMotifTEndUs twin note in catalog.ts — diverges from Rust saturating
 *  arithmetic only for absurd timestamps far beyond realistic use. */
export function applyUpdateLayerParams(p: Project, id: Uuid, patch: LayerParamsPatch, catalog: MotifCatalog): void {
  checkTrackLock(p, id) // LayerNotFound / TrackLocked
  const loc = locateLayer(p, id)! // existence guaranteed by checkTrackLock
  const layer = p.tracks[loc[0]].layers[loc[1]]
  applyParamsPatch(layer, patch)

  // Content-window model: after a Motif params update, if the cap-driving prop
  // (e.g. `seconds`) shrank the content below the current window, clamp the
  // geometry. Growing never resizes.
  if (layer.params.kind === 'Motif') {
    const params = layer.params as MotifParams
    // INTENTIONAL: the clamp cap is resolved from this `catalog` — the actor's full
    // MotifCatalog (built-ins + user layer) — so a USER motif with a cap clamps here too,
    // not just built-ins. Clamping user motifs is the desired behavior; do NOT narrow this
    // to built-ins-only.
    const manifest = catalog.get(params.motif_id)
    if (manifest === undefined) return // unknown motif → no clamp
    const contentDur = resolveMotifMaxDurUs(manifest, params.props)
    if (contentDur === null) return // unbounded → no clamp

    const tStart = layer.t_start_us
    const tEnd = layer.t_end_us
    const srcIn = params.src_in_us
    const width = tEnd - tStart

    if (srcIn + width <= contentDur) return // grow / within content → no geometry change

    // Clamp the window start into content (keep >= 0, < contentDur). Floor (not
    // round) so newSrcIn can never round UP toward contentDur on off-grid inputs.
    const maxSrcIn = Math.max(contentDur - 1, 0)
    const fps = p.composition.fps
    const newSrcIn = snapFrameFloor(Math.min(srcIn, maxSrcIn), fps.num, fps.den)
    // Largest grid t_end whose derived src_out stays <= contentDur.
    const cappedEnd = snapFrameFloor(tStart + (contentDur - newSrcIn), fps.num, fps.den)
    // Never collapse to zero-width (guards degenerate contentDur <= 0). The floor
    // is ONE FRAME, not one µs: `tStart + 1` is off-grid, and validate's grid
    // backstop would reject the whole commit — turning a silent 1 µs sliver into
    // a failed edit whenever a motif's remaining content is under one frame.
    const newTEnd = Math.max(cappedEnd, snapFrameCeil(tStart + 1, fps.num, fps.den))

    params.src_in_us = newSrcIn
    layer.t_end_us = newTEnd
    applyDurationAutofit(p)
  }
}

/** native/src/state/layer.rs `parse_effect_param_key` — parse
 *  "effects[<uuid>].params[<key>]" → [effectId, paramKey]; null otherwise. (A
 *  non-UUID id still parses here but the subsequent effect lookup fails → resolves
 *  to null, matching the Rust outcome.) */
export function parseEffectParamKey(key: string): [Uuid, string] | null {
  const m = /^effects\[([^\]]+)\]\.params\[(.+)\]$/.exec(key)
  return m ? [m[1], m[2]] : null
}

export const TRANSFORM_F64_KEYS = ['x', 'y', 'scale_x', 'scale_y', 'rotation_deg', 'anchor_x', 'anchor_y']

/** layer.rs `resolve_animated_f64_mut` / `resolve_animated_f64_mut_on_layer` —
 *  resolve a param-key to a setter for its Animated<f64> slot, or null if the key
 *  is unknown / invalid on this kind. Effect-param paths look in layer.effects
 *  (and require the param slot to already exist). */
function f64Lens(layer: Layer, key: string): { set(v: Animated<number>): void } | null {
  const eff = parseEffectParamKey(key)
  if (eff) {
    const e = layer.effects.find((x) => x.id === eff[0])
    if (!e || !(eff[1] in e.params)) return null
    return { set: (v) => { e.params[eff[1]] = v } }
  }
  const p = layer.params
  if (p.kind === 'Color') return null
  if (p.kind === 'Audio') {
    if (key === 'gain_db') return { set: (v) => { p.gain_db = v } }
    if (key === 'pan') return { set: (v) => { p.pan = v } }
    return null
  }
  // VideoClip | ImageOverlay | Text | Motif — transform + opacity
  if (key === 'opacity') return { set: (v) => { p.opacity = v } }
  if (TRANSFORM_F64_KEYS.includes(key)) return { set: (v) => { (p.transform as unknown as Record<string, Animated<number>>)[key] = v } }
  return null
}

/** layer.rs:286-374 read sibling of f64Lens — resolve a param-key to its CURRENT
 *  Animated<f64> (a reference into the layer), or null if unknown/invalid on this
 *  kind. Effect-param paths read layer.effects (None when the param slot is
 *  absent → caller maps to UnknownKeyframeParam). Read-only: never inserts. */
export function resolveAnimatedF64(layer: Layer, key: string): Animated<number> | null {
  const eff = parseEffectParamKey(key)
  if (eff) {
    const e = layer.effects.find((x) => x.id === eff[0])
    return e ? (e.params[eff[1]] ?? null) : null
  }
  const p = layer.params
  if (p.kind === 'Color') return null
  if (p.kind === 'Audio') {
    if (key === 'gain_db') return p.gain_db
    if (key === 'pan') return p.pan
    return null
  }
  // VideoClip | ImageOverlay | Text | Motif — transform + opacity
  if (key === 'opacity') return p.opacity
  if (TRANSFORM_F64_KEYS.includes(key)) return (p.transform as unknown as Record<string, Animated<number>>)[key] ?? null
  return null
}

/** Locate the layer (LayerNotFound), resolve the param key
 *  (UnknownKeyframeParam), return its t_start_us + current track. Used by the MCP
 *  keyframe tools for timeline-absolute↔layer-local conversion. Read-only (no
 *  commit, no id mint). */
export function readLayerTrack(p: Project, id: Uuid, paramKey: string): { tStartUs: number; track: Animated<number> } {
  const loc = locateLayer(p, id)
  if (!loc) throw new CommandFailure({ error: 'LayerNotFound', layer: id })
  const layer = p.tracks[loc[0]].layers[loc[1]]
  const track = resolveAnimatedF64(layer, paramKey)
  if (track === null) throw new CommandFailure({ error: 'UnknownKeyframeParam', layer: id, param_key: paramKey })
  return { tStartUs: layer.t_start_us, track }
}

/** update_layer_param_track (mutation half): lock-check →
 *  normalize (EmptyKeyframeTrack on empty) → locate → resolve, lazily inserting
 *  Static(0) for a missing slot of an EXISTING effect → re-resolve
 *  (UnknownKeyframeParam) → assign. NO autofit (a keyframe write never moves
 *  t_start/t_end). Keyframe param-tracks are Animated<f64> only. */
export function applyUpdateLayerParamTrack(p: Project, id: Uuid, paramKey: string, track: Animated<number>): void {
  checkTrackLock(p, id) // LayerNotFound / TrackLocked — BEFORE normalize
  const loc = locateLayer(p, id)! // existence guaranteed by checkTrackLock
  const layer = p.tracks[loc[0]].layers[loc[1]]
  // Located BEFORE normalize because the write-time grid depends on the layer's
  // kind: an audio envelope — gain_db, pan, and the audio-role automation —
  // quantizes on the 48 kHz lattice, so audio automation is never coarser than the
  // mixer that renders it (spec R2-D6). Error ordering: EmptyKeyframeTrack precedes
  // UnknownKeyframeParam.
  //
  // This changes the WRITE grid only. Keyframe times remain deliberately unenforced
  // by validate (see validate.ts's validateLayerParams note): trim/split rebase keys
  // by a delta, and re-snapping the shifted set would dedupe-merge two keys that
  // landed on one quantum — authored data lost.
  if (!normalizeKeyframes(track, (t) => snapOnGrid(t, gridForLayerKind(layer.params.kind, p.composition.fps)))) {
    throw new CommandFailure({ error: 'EmptyKeyframeTrack', layer: id, param_key: paramKey })
  }
  if (f64Lens(layer, paramKey) === null) {
    const eff = parseEffectParamKey(paramKey)
    if (eff) {
      const e = layer.effects.find((x) => x.id === eff[0])
      if (e && !(eff[1] in e.params)) e.params[eff[1]] = { mode: 'Static', value: 0 }
    }
  }
  const lens = f64Lens(layer, paramKey)
  if (!lens) throw new CommandFailure({ error: 'UnknownKeyframeParam', layer: id, param_key: paramKey })
  lens.set(track)
}
