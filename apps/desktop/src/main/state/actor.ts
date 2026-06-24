// apps/desktop/src/main/state/actor.ts
import { produce, setAutoFreeze } from 'immer'
import type { Animated, Composition, LayerParams, Project, Rational, Uuid } from './model'
import { blankProject } from './model'
import type { IdGen } from './ids'
import { History, type Actor, type EntityRef, type TrackFlagsPatch, type RoleFlagsPatch } from './history'
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
import { videoClipParams, audioParams, imageOverlayParams, applySeparateAudio, mediaItemTemplate,
  applySetMediaDerivatives, applySetMediaWorkspacePaths, referencingLayers,
  type MediaDerivativesPatch, type WorkspacePaths } from './mutations/media'
import type { MediaItem } from './model'
import { applyUpdateLayerParams, applyUpdateLayerParamTrack, type LayerParamsPatch } from './mutations/params'
import { applyAddCaptionTrack, applyRestyleCaptionTrack, type Cue, type CaptionStylePatch } from './mutations/captions'
import { parseMechanical, prodColorParams, prodTextParams, prodMediaLayer, resolveDurationUs, pickFreeOverlayTrack, demoColor } from './commands'
import { mapCommandError, MCP_ARG_PARSERS, MCP_RESULT_SHAPERS, toolEmpty, McpArgError, type McpCallResult } from './mcp-commands'

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
  command(channel: string, wireArgs: Record<string, unknown>): DispatchResult
  replaceState(next: Project): void
  subscribe(cb: (e: ChangeEvent) => void): () => void
  historyView(limit: number): ReturnType<History['view']>
  historyStatus(): ReturnType<History['status']>
  lockHistory(reason: string): void
  unlockHistory(): void
  dryRun(ops: DryRunOp[]): Array<{ ok: true; value: DryRunOutput } | { ok: false; error: CommandError }>
  mcpCall(name: string, argsJson: string): McpCallResult
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

  // ── add_media_item (do_add_media_item:2690) — UNRECORDED. Insert into the
  //    pool (media id is the caller's, NOT counter-minted), validate the probe,
  //    then replace the pool EVERYWHERE (durable across undo) + broadcast (burns
  //    one id). No HistoryEntry. ──
  function addMediaItem(item: MediaItem): Uuid {
    const cur = current()
    const nextPool = { ...cur.media_pool, [item.id]: item }
    runValidate({ ...cur, media_pool: nextPool })
    history.replaceMediaPoolEverywhere(nextPool)
    broadcastUnrecorded('Imported media', current())
    return item.id
  }

  // ── set_media_derivatives (do_set_media_derivatives:3534) — UNRECORDED, NO
  //    validate. MediaNotFound first (no id); else patch the pool item, replace
  //    EVERYWHERE (durable across undo) + broadcast (1 id). ──
  function setMediaDerivatives(id: Uuid, patch: MediaDerivativesPatch): void {
    const nextPool = applySetMediaDerivatives(current().media_pool, id, patch) // throws MediaNotFound
    history.replaceMediaPoolEverywhere(nextPool)
    broadcastUnrecorded('Updated media derivatives', current())
  }
  // ── set_media_workspace_paths (do_set_media_workspace_paths:3500) — UNRECORDED. ──
  function setMediaWorkspacePaths(id: Uuid, paths: WorkspacePaths): void {
    const nextPool = applySetMediaWorkspacePaths(current().media_pool, id, paths) // throws MediaNotFound
    history.replaceMediaPoolEverywhere(nextPool)
    broadcastUnrecorded('Updated media workspace paths', current())
  }
  // ── remove_media (do_remove_media:3428) — HYBRID. MediaNotFound → MediaInUse
  //    (when referenced && !force) → unused path (validate probe BEFORE broadcast,
  //    durable, 1 broadcast id) | force-cascade (RAW inline layer removal +
  //    commit, 1 op_id, undoable). The force path must NOT reuse applyDeleteLayer
  //    (no empty-track prune / no group cleanup — actor.rs:3479-3488). ──
  function removeMedia(id: Uuid, force: boolean): void {
    const cur = current()
    if (!(id in cur.media_pool)) throw new CommandFailure({ error: 'MediaNotFound', media: id })
    const referencing = referencingLayers(cur, id)
    if (referencing.length > 0 && !force) throw new CommandFailure({ error: 'MediaInUse', media: id, referenced_by: referencing })
    if (referencing.length === 0) {
      const nextPool = { ...cur.media_pool }
      delete nextPool[id]
      runValidate({ ...cur, media_pool: nextPool }) // validate-before-broadcast (actor.rs:3470)
      history.replaceMediaPoolEverywhere(nextPool)
      broadcastUnrecorded(`Removed media ${id}`, current())
      return
    }
    const affected: EntityRef[] = referencing.map((l) => ({ kind: 'Layer', id: l }))
    commit(`Removed media ${id} and ${referencing.length} referencing layer(s)`, affected, { kind: 'Coarse' }, (d) => {
      for (const layerId of referencing) {
        for (const t of d.tracks) {
          const idx = t.layers.findIndex((l) => l.id === layerId)
          if (idx >= 0) { t.layers.splice(idx, 1); break }
        }
      }
      delete d.media_pool[id]
    })
  }

  // ── set_role_gain (do_set_role_gain:3657) — RECORDED (undoable). Read the
  //    role's mix bus (default-filled when absent), override ONLY gain_db
  //    (muted/solo preserved), reinsert. No affected entities, Coarse hint. ──
  function setRoleGain(role: string, gainDb: number): void {
    commit(`Set ${role} role gain`, [], { kind: 'Coarse' }, (d) => {
      const cur = d.audio_roles[role]
      d.audio_roles[role] = { gain_db: gainDb, muted: cur?.muted ?? false, solo: cur?.solo ?? false }
    })
  }

  // ── update_role_flags (do_update_role_flags:3681) — UNRECORDED (mirrors
  //    updateTrackFlags). Patch mute/solo into EVERY snapshot + broadcast (burns
  //    one id). Roles always exist (default-filled), so no not-found branch. ──
  function updateRoleFlags(role: string, patch: RoleFlagsPatch): void {
    history.replaceRoleFlagsEverywhere(role, patch)
    broadcastUnrecorded('Updated role flags', current())
  }

  // ── update_project_settings (do_update_project_settings:3619) — UNRECORDED.
  //    Clone settings, apply the present fields, replace-everywhere + broadcast. ──
  function updateProjectSettings(patch: { auto_delete_empty_tracks?: boolean | null }): void {
    const next = { ...current().settings }
    if (typeof patch.auto_delete_empty_tracks === 'boolean') next.auto_delete_empty_tracks = patch.auto_delete_empty_tracks
    history.replaceSettingsEverywhere(next)
    broadcastUnrecorded('Updated project settings', current())
  }

  // ── replace_state (do_replace_state:3581) — wholesale project swap. validate
  //    FIRST (a failure mints NO id and leaves history intact); on success reset
  //    history to a single 'Initial' entry (drops the old project's snapshots +
  //    checkpoints + lock — they reference a different project_id) then broadcast
  //    unrecorded. modified_at is NOT touched. Mints exactly 2 ids on success
  //    (reset op_id + broadcast event id); a caller that built `next` via
  //    blankProject already spent its 3 ids → 5 total (see the plan's id contract). ──
  function replaceState(next: Project): void {
    runValidate(next)                              // throws CommandFailure(ValidationFailed); no id spent
    history.reset(next, actor, idGen(), clock())   // +1 id (the 'Initial' op_id)
    broadcastUnrecorded('Replaced project state', current())  // +1 id (the event op_id)
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
          let params: LayerParams
          switch (kind) {
            case 'text': params = textParamsDefault('hello'); break
            case 'color': params = colorParams({ r: 255, g: 0, b: 0, a: 255 }, 1920, 1080); break
            case 'video': params = videoClipParams(a.media as Uuid, a.src_in_us as number, a.src_out_us as number); break
            case 'audio': params = audioParams(a.media as Uuid, a.src_in_us as number, a.src_out_us as number); break
            case 'image': params = imageOverlayParams(a.media as Uuid); break
            default: return { ok: false, error: { error: 'InvalidArgument', field: 'kind', detail: `unknown kind ${kind}` } }
          }
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
        case 'update_layer_params': commit('Updated layer params', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => applyUpdateLayerParams(d, a.layer as Uuid, a.patch as LayerParamsPatch)); return { ok: true, value: null }
        case 'update_layer_param_track': commit('Keyframed layer param', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => applyUpdateLayerParamTrack(d, a.layer as Uuid, a.param_key as string, a.track as Animated<number>)); return { ok: true, value: null }
        case 'update_layer_param_tracks': commit('Keyframed layer params', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Layer', id: a.layer as Uuid }, (d) => { for (const [k, t] of a.entries as [string, Animated<number>][]) applyUpdateLayerParamTrack(d, a.layer as Uuid, k, t) }); return { ok: true, value: null }
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
        case 'add_media': return { ok: true, value: addMediaItem(mediaItemTemplate(a.id as Uuid, a.kind as MediaItem['kind'], (a.duration_us as number | null) ?? null, (a.with_audio as boolean | undefined) ?? false)) }
        case 'separate_audio': return { ok: true, value: commit('Separated audio', [{ kind: 'Layer', id: a.layer as Uuid }], { kind: 'Coarse' }, (d) => applySeparateAudio(d, idGen, a.layer as Uuid)) }
        case 'set_media_derivatives': setMediaDerivatives(a.media as Uuid, a.patch as MediaDerivativesPatch); return { ok: true, value: null }
        case 'set_media_workspace_paths': setMediaWorkspacePaths(a.media as Uuid, a.paths as WorkspacePaths); return { ok: true, value: null }
        case 'remove_media': removeMedia(a.media as Uuid, (a.force as boolean) ?? false); return { ok: true, value: null }
        case 'set_role_gain': setRoleGain(a.role as string, a.gain_db as number); return { ok: true, value: null }
        case 'update_role_flags': updateRoleFlags(a.role as string, a.patch as RoleFlagsPatch); return { ok: true, value: null }
        case 'update_project_settings': updateProjectSettings(a.patch as { auto_delete_empty_tracks?: boolean | null }); return { ok: true, value: null }
        case 'add_caption_track': return { ok: true, value: commit('Added caption track', [], { kind: 'Coarse' }, (d) => applyAddCaptionTrack(d, idGen, a.cues as Cue[], a.comp_w as number, a.comp_h as number, (a.label as string) ?? null)) }
        case 'restyle_caption_track': commit('Restyled caption track', [{ kind: 'Track', id: a.track as Uuid }], { kind: 'Coarse' }, (d) => applyRestyleCaptionTrack(d, a.track as Uuid, a.patch as CaptionStylePatch)); return { ok: true, value: null }
        case 'replace_state': {
          // Differential-corpus vehicle: build a blank from the args (mirrors
          // Project::new_blank + project_new_workspace's canvas override) so both
          // engines mint the same 3 blank ids before the swap. Production callers
          // (Phase 3c project_open) call replaceState(loadedProject) directly.
          const next = blankProject(idGen, (a.name as string) ?? 'untitled')
          if (typeof a.width === 'number') next.composition.width = a.width
          if (typeof a.height === 'number') next.composition.height = a.height
          if (typeof a.fps_num === 'number' && typeof a.fps_den === 'number') next.composition.fps = { num: a.fps_num, den: a.fps_den }
          replaceState(next)
          return { ok: true, value: null }
        }
        default: return { ok: false, error: { error: 'InvalidArgument', field: 'op', detail: `unsupported op ${channel}` } }
      }
    } catch (e) {
      if (e instanceof CommandFailure) return { ok: false, error: e.err }
      throw e
    }
  }

  // ── production command adapter (actor.command) ──
  // Routes the renderer's real category-A channels (camelCase wire args) into
  // the gated mutation core. Mechanical channels delegate to dispatch() after
  // arg parsing; rich channels are handled inline below.
  function command(channel: string, wireArgs: Record<string, unknown>): DispatchResult {
    const mech = parseMechanical(channel, wireArgs)
    if (mech) return dispatch(mech.op, mech.args)
    try {
      switch (channel) {
        case 'add_color_layer': {
          // add_color_layer_impl (mutations.rs:362-388): resolve overlay track when
          // trackId absent (reverse-scan non-reserved; create "Overlay" if none free).
          const t0 = wireArgs.tStartUs as number
          const dur = resolveDurationUs(wireArgs.durationUs as number | undefined)
          const t1 = t0 + dur
          const trackId = (wireArgs.trackId as string | undefined) ?? pickFreeOverlayTrack(current(), t0, t1)
          if (trackId !== null) {
            const params = prodColorParams(wireArgs, current().composition)
            const id = commit('Added layer', [], { kind: 'Coarse' }, (d) =>
              applyAddLayer(d, idGen, trackId, params, t0, t1))
            return { ok: true, value: id }
          }
          // No free track — create "Overlay" in its OWN commit (matching Rust's
          // resolve_overlay_track which calls handle.add_track — a SEPARATE committed
          // op with its own op_id), THEN add the layer in a second commit. Two op_ids,
          // matching mutations.rs:254-267 + add_color_layer_impl:362-388.
          const newTrackId = commit('Added track', [], { kind: 'Coarse' }, (d) =>
            applyAddTrack(d, idGen, 'Overlay'))
          const params = prodColorParams(wireArgs, current().composition)
          const id = commit('Added layer', [], { kind: 'Coarse' }, (d) =>
            applyAddLayer(d, idGen, newTrackId, params, t0, t1))
          return { ok: true, value: id }
        }
        case 'add_text_layer': {
          // add_text_layer_impl (mutations.rs:269-305): same overlay-track logic.
          const t0 = wireArgs.tStartUs as number
          const dur = resolveDurationUs(wireArgs.durationUs as number | undefined)
          const t1 = t0 + dur
          const trackId = (wireArgs.trackId as string | undefined) ?? pickFreeOverlayTrack(current(), t0, t1)
          const params = prodTextParams(wireArgs)
          if (trackId !== null) {
            const id = commit('Added layer', [], { kind: 'Coarse' }, (d) =>
              applyAddLayer(d, idGen, trackId, params, t0, t1))
            return { ok: true, value: id }
          }
          // No free track — same two-commit pattern as add_color_layer above.
          const newTrackId = commit('Added track', [], { kind: 'Coarse' }, (d) =>
            applyAddTrack(d, idGen, 'Overlay'))
          const id = commit('Added layer', [], { kind: 'Coarse' }, (d) =>
            applyAddLayer(d, idGen, newTrackId, params, t0, t1))
          return { ok: true, value: id }
        }
        case 'add_media_layer': {
          // add_media_layer (mutations.rs:73-183): track_id required, kind-matched
          // params. When auto-pair fires (Video + audio.is_some() + setting on):
          // THREE separate commits (three op_ids), mirroring Rust's three handle
          // calls — add video layer, add audio layer (role=dialogue), groups_create.
          const trackId = wireArgs.trackId as string
          const t0 = wireArgs.tStartUs as number
          const { params, durationUs, autoPairAudio } = prodMediaLayer(wireArgs, current())
          const t1 = t0 + durationUs
          const videoId = commit('Added layer', [], { kind: 'Coarse' }, (d) =>
            applyAddLayer(d, idGen, trackId, params, t0, t1))
          if (autoPairAudio !== null) {
            // mutations.rs:161-179: paired Audio layer (role dialogue) on the SAME track,
            // same span, then groups_create([video, audio]). THREE separate commits ⇒ three
            // op_ids, matching Rust's three handle calls (the id-allocation keystone).
            const audioId = commit('Added layer', [], { kind: 'Coarse' }, (d) =>
              applyAddLayer(d, idGen, trackId, autoPairAudio, t0, t1))
            commit('Created group', [], { kind: 'Coarse' }, (d) =>
              applyGroupsCreate(d, idGen, [videoId, audioId], null, false))
          }
          return { ok: true, value: videoId }
        }
        case 'add_demo_color_layer': {
          // add_demo_color_layer (mutations.rs:185-214):
          //   track=tracks.front() (create "Track" if empty),
          //   t_start=track.last_layer.t_end ?? 0, duration=2s,
          //   color=demo_color(track.layers.len()), w/h=composition size.
          const snap = current()
          const firstTrack = snap.tracks[0]
          if (firstTrack) {
            const t0 = firstTrack.layers.at(-1)?.t_end_us ?? 0
            const t1 = t0 + 2_000_000
            const params = prodColorParams(
              { color: demoColor(firstTrack.layers.length) },
              snap.composition,
            )
            const id = commit('Added layer', [], { kind: 'Coarse' }, (d) =>
              applyAddLayer(d, idGen, firstTrack.id, params, t0, t1))
            return { ok: true, value: id }
          }
          // No tracks at all — create "Track" then add layer inside one commit.
          // Unreachable in prod (reserved A/B-roll tracks are non-removable, so tracks is never empty); single-commit is fine. Do NOT mirror this onto the reachable no-trackId overlay path — that one matches Rust's two-commit resolve_overlay_track.
          const id = commit('Added layer', [], { kind: 'Coarse' }, (d) => {
            const newTrackId = applyAddTrack(d, idGen, 'Track')
            const t0 = 0
            const t1 = 2_000_000
            const params = prodColorParams({ color: demoColor(0) }, d.composition)
            return applyAddLayer(d, idGen, newTrackId, params, t0, t1)
          })
          return { ok: true, value: id }
        }
        case 'add_demo_text_layer': {
          // add_demo_text_layer (mutations.rs:318-360):
          //   track=tracks.last() (create "Overlay" if empty),
          //   t_start=track.last_layer.t_end ?? 0, duration=3s,
          //   content="TEXT", Arial 96 weight:700.
          const snap = current()
          const lastTrack = snap.tracks.at(-1)
          if (lastTrack) {
            const t0 = lastTrack.layers.at(-1)?.t_end_us ?? 0
            const t1 = t0 + 3_000_000
            const params: LayerParams = {
              kind: 'Text', content: 'TEXT',
              font: { family: 'Arial', size_px: 96, weight: 700, italic: false },
              color: { mode: 'Static', value: { r: 255, g: 255, b: 255, a: 255 } },
              align: 'Center', transform: { x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 }, scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 }, rotation_deg: { mode: 'Static', value: 0 }, anchor: [0.5, 0.5] },
              opacity: { mode: 'Static', value: 1 },
              shadow: null, outline: null, intro: null, outro: null,
              backend_hint: 'DrawText',
            }
            const id = commit('Added layer', [], { kind: 'Coarse' }, (d) =>
              applyAddLayer(d, idGen, lastTrack.id, params, t0, t1))
            return { ok: true, value: id }
          }
          // Unreachable in prod (reserved A/B-roll tracks are non-removable, so tracks is never empty); single-commit is fine. Do NOT mirror this onto the reachable no-trackId overlay path — that one matches Rust's two-commit resolve_overlay_track.
          const id = commit('Added layer', [], { kind: 'Coarse' }, (d) => {
            const newTrackId = applyAddTrack(d, idGen, 'Overlay')
            const params: LayerParams = {
              kind: 'Text', content: 'TEXT',
              font: { family: 'Arial', size_px: 96, weight: 700, italic: false },
              color: { mode: 'Static', value: { r: 255, g: 255, b: 255, a: 255 } },
              align: 'Center', transform: { x: { mode: 'Static', value: 0 }, y: { mode: 'Static', value: 0 }, scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 }, rotation_deg: { mode: 'Static', value: 0 }, anchor: [0.5, 0.5] },
              opacity: { mode: 'Static', value: 1 },
              shadow: null, outline: null, intro: null, outro: null,
              backend_hint: 'DrawText',
            }
            return applyAddLayer(d, idGen, newTrackId, params, 0, 3_000_000)
          })
          return { ok: true, value: id }
        }
        default:
          // (meta channels added in Task 4)
          return { ok: false, error: { error: 'InvalidArgument', field: 'op', detail: `unsupported production op ${channel}` } }
      }
    } catch (e) {
      if (e instanceof CommandFailure) return { ok: false, error: e.err }
      throw e
    }
  }

  function mcpCall(name: string, argsJson: string): McpCallResult {
    let a: Record<string, unknown>
    try { a = JSON.parse(argsJson) as Record<string, unknown> }
    catch (e) { return { ok: false, error: { code: 'invalid_params', message: `invalid args for ${name}: ${String(e)}` } } }
    try {
      // Dedicated arms for explicit-param tools land in Tasks 4. Until then, the
      // table path handles the mechanical tools.
      const parse = MCP_ARG_PARSERS[name]
      if (!parse) return { ok: false, error: { code: 'not_found', message: `unknown tool '${name}'` } }
      const { op, args } = parse(a)
      const r = dispatch(op, args)
      if (!r.ok) return { ok: false, error: mapCommandError(r.error) }
      const shape = MCP_RESULT_SHAPERS[name] ?? (() => toolEmpty())
      return { ok: true, result: shape(r.value) }
    } catch (e) {
      if (e instanceof McpArgError) return { ok: false, error: e.toJson() }
      throw e
    }
  }

  return {
    snapshot: current,
    dispatch,
    command,
    mcpCall,
    replaceState,
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb) },
    historyView: (n) => history.view(n),
    historyStatus: () => history.status(),
    lockHistory: (r) => history.lock(r),
    unlockHistory: () => history.unlock(),
    dryRun,
  }
}
