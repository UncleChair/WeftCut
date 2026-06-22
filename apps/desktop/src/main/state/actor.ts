// apps/desktop/src/main/state/actor.ts
import { produce, setAutoFreeze } from 'immer'
import type { Composition, LayerParams, Project, Rational, Uuid } from './model'
import type { IdGen } from './ids'
import { History, type Actor, type EntityRef, type TrackFlagsPatch } from './history'
import { CommandFailure, ValidationFailure, type CommandError } from './errors'
import { validate } from './validate'
import { snapFrameRound } from './snap'
import { applyAddLayer, applyAddMarker, applyAddTrack, colorParams, textParamsDefault } from './mutations/add'
import { applyMoveLayer } from './mutations/move'
import { applyTrimLayer, type LayerEdge } from './mutations/trim'
import { applyDeleteLayer } from './mutations/delete'
import { applyDuplicateLayer } from './mutations/duplicate'
import { applySplitLayer } from './mutations/split'
import { applyGroupsCreate, applyGroupsDissolve, applyGroupsAddMembers, applyGroupsRemoveMembers, applyGroupsRename } from './mutations/groups'
import { applyUpdateLayer, type LayerPatch } from './mutations/update'
import { applyFitComposition } from './mutations/composition'
import { applyDurationAutofit } from './mutations/helpers'
import { applyUpdateMarker, applyRemoveMarker, type MarkerPatch } from './mutations/markers'
import { applyDeleteTrack, applyMoveTrack } from './mutations/tracks'
import { applyAddEffect, applyUpdateEffect, applyMoveEffect, applyRemoveEffect, type EffectPatch } from './mutations/effects'
import { applyAddTransition, applyRemoveTransition } from './mutations/transitions'

setAutoFreeze(true) // snapshots are frozen — accidental mutation throws.

export type Clock = () => string
export type DiffHint = { kind: 'Coarse' } | { kind: 'Layer'; id: Uuid } | { kind: 'Composition' }
export interface ChangeEvent { op_id: Uuid; actor: Actor; timestamp: string; summary: string; affected: EntityRef[]; new_snapshot: Project; diff_hint: DiffHint }

export type DryRunOp =
  | { kind: 'AddLayer'; track_id: Uuid; params: LayerParams; t_start_us: number; t_end_us: number }
  | { kind: 'DeleteLayer'; id: Uuid }
  | { kind: 'MoveLayer'; id: Uuid; new_track_id: Uuid; new_t_start_us: number; escape_group: boolean }
  | { kind: 'TrimLayer'; id: Uuid; edge: LayerEdge; new_t_us: number; escape_group: boolean }
export type DryRunOutput = { kind: 'AddLayer'; layer_id: Uuid } | { kind: 'Void' }

export interface ActorOptions { initial: Project; idGen: IdGen; clock?: Clock; actor?: Actor }
export type DispatchResult = { ok: true; value: unknown } | { ok: false; error: CommandError }

export interface ActorHandle {
  snapshot(): Project
  dispatch(channel: string, args: Record<string, unknown>): DispatchResult
  subscribe(cb: (e: ChangeEvent) => void): () => void
  historyView(limit: number): ReturnType<History['view']>
  historyStatus(): ReturnType<History['status']>
  lockHistory(reason: string): void
  unlockHistory(): void
  dryRun(ops: DryRunOp[]): Array<{ ok: true; value: DryRunOutput } | { ok: false; error: CommandError }>
}

export function createActor(opts: ActorOptions): ActorHandle {
  const idGen = opts.idGen
  const clock: Clock = opts.clock ?? (() => '<TS>')
  const actor: Actor = opts.actor ?? { kind: 'User' }
  const history = new History(opts.initial, actor, idGen(), clock()) // consumes the Initial op_id
  const subs = new Set<(e: ChangeEvent) => void>()

  function current(): Project { return history.current() }

  /** validate(next) → throw CommandFailure(ValidationFailed) on a rule failure.
   *  Shared by commit and set_composition's atomic combined-probe pre-check. */
  function runValidate(next: Project): void {
    try { validate(next) } catch (e) {
      if (e instanceof ValidationFailure) throw new CommandFailure({ error: 'ValidationFailed', detail: e.err })
      throw e
    }
  }

  /** Run a draft mutation, then validate, record, emit. Mirrors actor.rs commit:
   *  validate FIRST, op_id AFTER validate. Returns the recipe's value. Throws
   *  CommandFailure on a mutation error or a validation failure. */
  function commit<T>(summary: string, affected: EntityRef[], diff: DiffHint, recipe: (draft: Project) => T): T {
    let value!: T
    // produce: a throw inside the recipe aborts and discards the draft (Rust:
    // the clone is dropped on error → authoritative state untouched).
    const next = produce(current(), (draft) => { value = recipe(draft) })
    runValidate(next)
    const opId = idGen() // AFTER validate — failed validate consumes no op_id
    const ts = clock()
    history.record({ op_id: opId, actor, timestamp: ts, summary, affected, snapshot: next })
    emit({ op_id: opId, actor, timestamp: ts, summary, affected, new_snapshot: next, diff_hint: diff })
    return value
  }

  function emit(e: ChangeEvent): void { for (const cb of subs) cb(e) }

  function broadcastUnrecorded(summary: string, snapshot: Project): void {
    const opId = idGen() // matches broadcast_unrecorded's new_id (actor.rs:3815)
    emit({ op_id: opId, actor, timestamp: clock(), summary, affected: [], new_snapshot: snapshot, diff_hint: { kind: 'Coarse' } })
  }

  // ── set_composition (do_set_composition actor.rs:2929-3077) — atomic combined
  //    probe validate; fps re-snaps every layer + Motif src_in_us + duration; the
  //    non-fps canvas path replaces canvas in EVERY snapshot (survives undo). ──
  function setComposition(patch: Record<string, unknown>): void {
    const cur = current()
    const CANVAS_KEYS = ['width', 'height', 'fps', 'sample_rate', 'channels', 'color_space', 'background']
    const canvasChanges = CANVAS_KEYS.some((k) => patch[k] !== undefined)
    const newFps = (patch.fps as Rational | undefined) ?? cur.composition.fps
    const fpsChanged = patch.fps !== undefined && (newFps.num !== cur.composition.fps.num || newFps.den !== cur.composition.fps.den)
    const durationChange = typeof patch.duration_us === 'number'
      ? snapFrameRound(patch.duration_us, newFps.num, newFps.den) : undefined

    // Build the combined probe (canvas + duration + fps re-snap + autofit).
    const buildProbe = (d: Project): void => {
      applyCanvasFields(d.composition, patch)
      if (durationChange !== undefined) { d.composition.duration_us = durationChange; d.composition.duration_pinned = true }
      if (fpsChanged) {
        const nf = d.composition.fps
        for (const t of d.tracks) for (const l of t.layers) {
          l.t_start_us = snapFrameRound(l.t_start_us, nf.num, nf.den)
          l.t_end_us = snapFrameRound(l.t_end_us, nf.num, nf.den)
          // Motif src_in_us lives on the COMPOSITION grid (re-snap); VideoClip/
          // Audio src_in_us is on the source-PTS grid (left untouched).
          if (l.params.kind === 'Motif') l.params.src_in_us = snapFrameRound(l.params.src_in_us, nf.num, nf.den)
        }
        d.composition.duration_us = snapFrameRound(d.composition.duration_us, nf.num, nf.den)
      }
      applyDurationAutofit(d)
    }

    if (fpsChanged) {
      // Layer geometry changed → one recorded commit of the probe.
      commit('Updated composition fps + re-snapped layers', [], { kind: 'Composition' }, buildProbe)
      return
    }

    // Non-fps: validate the combined probe FIRST (atomicity — never apply canvas
    // everywhere and then fail on the duration commit).
    const probe = produce(cur, buildProbe)
    runValidate(probe)

    if (canvasChanges) {
      const newCanvas = produce(cur.composition, (c: Composition) => applyCanvasFields(c, patch))
      history.replaceCompositionCanvasEverywhere(newCanvas)
      broadcastUnrecorded('Updated composition canvas', current())
    }
    if (durationChange !== undefined) {
      commit('Updated composition duration', [], { kind: 'Composition' }, (d) => {
        d.composition.duration_us = durationChange
        d.composition.duration_pinned = true
        applyDurationAutofit(d)
      })
    }
  }
  /** Copy the present canvas fields of `patch` into a composition draft
   *  (history.rs:391 apply_canvas_fields covers exactly these 7). */
  function applyCanvasFields(c: Composition, patch: Record<string, unknown>): void {
    if (typeof patch.width === 'number') c.width = patch.width
    if (typeof patch.height === 'number') c.height = patch.height
    if (patch.fps) c.fps = patch.fps as Rational
    if (typeof patch.sample_rate === 'number') c.sample_rate = patch.sample_rate
    if (typeof patch.channels === 'number') c.channels = patch.channels
    if (patch.color_space) c.color_space = patch.color_space as Composition['color_space']
    if (patch.background) c.background = patch.background as Project['composition']['background']
  }

  // ── meta ──
  function undo(): void {
    const reason = history.lockReason()
    if (reason !== null) throw new CommandFailure({ error: 'HistoryLocked', reason })
    const snap = history.undo()
    if (snap === null) throw new CommandFailure({ error: 'NothingToUndo' })
    broadcastUnrecorded('Undo', snap)
  }
  function redo(): void {
    const reason = history.lockReason()
    if (reason !== null) throw new CommandFailure({ error: 'HistoryLocked', reason })
    const snap = history.redo()
    if (snap === null) throw new CommandFailure({ error: 'NothingToRedo' })
    broadcastUnrecorded('Redo', snap)
  }

  // ── move_track (do_move_track:3394-3426) — the cur===new no-op must skip
  //    commit; recording it would burn an op_id and drift every later id. ──
  function moveTrack(id: Uuid, newPosition: number): void {
    const curIdx = current().tracks.findIndex((t) => t.id === id)
    if (curIdx >= 0 && curIdx === newPosition) return // no-op: no record, no broadcast
    commit('Moved track', [{ kind: 'Track', id }], { kind: 'Coarse' }, (d) => applyMoveTrack(d, id, newPosition))
  }

  // ── update_track_flags (do_update_track_flags:3637-3650) — UNRECORDED.
  //    TrackNotFound first; then replace-everywhere + broadcast (burns one id,
  //    matching broadcast_unrecorded so the det counter stays aligned). ──
  function updateTrackFlags(id: Uuid, patch: TrackFlagsPatch): void {
    if (!current().tracks.some((t) => t.id === id)) throw new CommandFailure({ error: 'TrackNotFound', track: id })
    history.replaceTrackFlagsEverywhere(id, patch)
    broadcastUnrecorded('Updated track flags', current())
  }

  function dryRun(ops: DryRunOp[]): Array<{ ok: true; value: DryRunOutput } | { ok: false; error: CommandError }> {
    const results: Array<{ ok: true; value: DryRunOutput } | { ok: false; error: CommandError }> = []
    let scratch = current()
    for (const op of ops) {
      try {
        let value: DryRunOutput = { kind: 'Void' }
        const next = produce(scratch, (d) => {
          switch (op.kind) {
            case 'AddLayer': value = { kind: 'AddLayer', layer_id: applyAddLayer(d, idGen, op.track_id, op.params, op.t_start_us, op.t_end_us) }; break
            case 'DeleteLayer': applyDeleteLayer(d, op.id); break
            case 'MoveLayer': applyMoveLayer(d, op.id, op.new_track_id, op.new_t_start_us, op.escape_group); break
            case 'TrimLayer': applyTrimLayer(d, op.id, op.edge, op.new_t_us, op.escape_group); break
          }
        })
        runValidate(next)
        scratch = next
        results.push({ ok: true, value })
      } catch (e) {
        if (e instanceof CommandFailure) { results.push({ ok: false, error: e.err }); break } // halt at first error
        throw e
      }
    }
    return results
  }

  // ── string dispatch (used by the replay driver + shadow comparator) ──
  function dispatch(channel: string, a: Record<string, unknown>): DispatchResult {
    try {
      switch (channel) {
        case 'add_layer': {
          const kind = a.kind as string
          const params: LayerParams = kind === 'text' ? textParamsDefault('hello') : colorParams({ r: 255, g: 0, b: 0, a: 255 }, 1920, 1080)
          const id = commit('Added layer', [], { kind: 'Coarse' }, (d) => applyAddLayer(d, idGen, a.track as Uuid, params, a.t_start_us as number, a.t_end_us as number))
          return { ok: true, value: id }
        }
        case 'add_track': return { ok: true, value: commit('Added track', [], { kind: 'Coarse' }, (d) => applyAddTrack(d, idGen, (a.label as string) ?? null)) }
        case 'add_marker': return { ok: true, value: commit('Added marker', [], { kind: 'Coarse' }, (d) => applyAddMarker(d, idGen, a.t_us as number, (a.end_t_us as number) ?? null, (a.label as string) ?? 'm', { r: 0, g: 128, b: 255, a: 255 })) }
        case 'move_layer': commit('Moved layer', [], { kind: 'Coarse' }, (d) => applyMoveLayer(d, a.layer as Uuid, a.to_track as Uuid, a.t_start_us as number, (a.escape_group as boolean) ?? false)); return { ok: true, value: null }
        case 'trim_layer': commit('Trimmed layer', [], { kind: 'Coarse' }, (d) => applyTrimLayer(d, a.layer as Uuid, ((a.edge as string) === 'out' ? 'Out' : 'In'), a.new_t_us as number, (a.escape_group as boolean) ?? false)); return { ok: true, value: null }
        case 'delete_layer': commit('Deleted layer', [], { kind: 'Coarse' }, (d) => applyDeleteLayer(d, a.layer as Uuid)); return { ok: true, value: null }
        case 'duplicate_layer': return { ok: true, value: commit('Duplicated layer', [], { kind: 'Coarse' }, (d) => applyDuplicateLayer(d, idGen, a.layer as Uuid, a.t_offset_us as number)) }
        case 'set_composition': setComposition(a); return { ok: true, value: null }
        case 'undo': undo(); return { ok: true, value: null }
        case 'redo': redo(); return { ok: true, value: null }
        case 'split_layer': return { ok: true, value: commit('Split layer', [], { kind: 'Coarse' }, (d) => applySplitLayer(d, idGen, a.layer as Uuid, a.at_t_us as number, (a.escape_group as boolean) ?? false)) }
        case 'groups_create': return { ok: true, value: commit('Created group', [], { kind: 'Coarse' }, (d) => applyGroupsCreate(d, idGen, a.layers as Uuid[], (a.label as string) ?? null, (a.reassign as boolean) ?? false)) }
        case 'groups_dissolve': commit('Dissolved group', [], { kind: 'Coarse' }, (d) => applyGroupsDissolve(d, a.group as Uuid)); return { ok: true, value: null }
        case 'groups_add_members': commit('Added group members', [], { kind: 'Coarse' }, (d) => applyGroupsAddMembers(d, a.group as Uuid, a.layers as Uuid[], (a.reassign as boolean) ?? false)); return { ok: true, value: null }
        case 'groups_remove_members': commit('Removed group members', [], { kind: 'Coarse' }, (d) => applyGroupsRemoveMembers(d, a.group as Uuid, a.layers as Uuid[])); return { ok: true, value: null }
        case 'groups_rename': commit('Renamed group', [], { kind: 'Coarse' }, (d) => applyGroupsRename(d, a.group as Uuid, (a.label as string) ?? null)); return { ok: true, value: null }
        case 'update_layer': commit('Updated layer', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => applyUpdateLayer(d, a.layer as Uuid, a.patch as LayerPatch)); return { ok: true, value: null }
        case 'fit_composition_to_layers': commit('Fit composition duration to layers', [], { kind: 'Composition' }, (d) => applyFitComposition(d)); return { ok: true, value: null }
        case 'update_marker': commit('Updated marker', [{ kind: 'Marker', id: a.marker as Uuid }], { kind: 'Coarse' }, (d) => applyUpdateMarker(d, a.marker as Uuid, a.patch as MarkerPatch)); return { ok: true, value: null }
        case 'remove_marker': commit('Removed marker', [{ kind: 'Marker', id: a.marker as Uuid }], { kind: 'Coarse' }, (d) => applyRemoveMarker(d, a.marker as Uuid)); return { ok: true, value: null }
        case 'delete_track': commit('Deleted track', [{ kind: 'Track', id: a.track as Uuid }], { kind: 'Coarse' }, (d) => applyDeleteTrack(d, a.track as Uuid, (a.force as boolean) ?? false)); return { ok: true, value: null }
        case 'move_track': moveTrack(a.track as Uuid, a.new_position as number); return { ok: true, value: null }
        case 'update_track_flags': updateTrackFlags(a.track as Uuid, a.patch as TrackFlagsPatch); return { ok: true, value: null }
        case 'add_effect': return { ok: true, value: commit('Added effect', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applyAddEffect(d, idGen, a.layer as Uuid, a.kind as string)) }
        case 'update_effect': commit('Updated effect', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applyUpdateEffect(d, a.layer as Uuid, a.effect as Uuid, a.patch as EffectPatch)); return { ok: true, value: null }
        case 'move_effect': commit('Reordered effect', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applyMoveEffect(d, a.layer as Uuid, a.effect as Uuid, a.new_index as number)); return { ok: true, value: null }
        case 'remove_effect': commit('Removed effect', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applyRemoveEffect(d, a.layer as Uuid, a.effect as Uuid)); return { ok: true, value: null }
        case 'add_transition': return { ok: true, value: commit('Added transition', [], { kind: 'Coarse' }, (d) => applyAddTransition(d, idGen, a.from as Uuid, a.to as Uuid, a.duration_us as number, { kind: 'Crossfade' })) }
        case 'remove_transition': commit('Removed transition', [], { kind: 'Coarse' }, (d) => applyRemoveTransition(d, a.transition as Uuid)); return { ok: true, value: null }
        default: return { ok: false, error: { error: 'InvalidArgument', field: 'op', detail: `unsupported op ${channel}` } }
      }
    } catch (e) {
      if (e instanceof CommandFailure) return { ok: false, error: e.err }
      throw e
    }
  }

  return {
    snapshot: current,
    dispatch,
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb) },
    historyView: (n) => history.view(n),
    historyStatus: () => history.status(),
    lockHistory: (r) => history.lock(r),
    unlockHistory: () => history.unlock(),
    dryRun,
  }
}
