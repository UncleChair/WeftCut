// apps/desktop/src/main/state/history.ts
import type { MediaItem, Project, ProjectSettings, RoleMixSettings, Uuid } from './model'
import { HISTORY_SUMMARY, createLayerFlattener, resolveEntityLabels, restoredCheckpointSummary, type EntityLabel } from './history-labels'

export type Actor = { kind: 'User' } | { kind: 'Agent'; client: string }
export type EntityRef =
  | { kind: 'Track'; id: Uuid } | { kind: 'Layer'; id: Uuid } | { kind: 'Marker'; id: Uuid }

/** Mirrors `TrackFlagsPatch` in apps/desktop/native/src/state/project.rs —
 *  preference-shaped track toggles. null/absent = "don't touch". */
export interface TrackFlagsPatch { enabled?: boolean | null; muted?: boolean | null; solo?: boolean | null; locked?: boolean | null }

/** native/src/state/audio_role.rs:67 RoleFlagsPatch — the Mixer panel's M/S
 *  toggles. null/absent = "don't touch". Unrecorded (preference-shaped). */
export interface RoleFlagsPatch { muted?: boolean | null; solo?: boolean | null }

export interface HistoryEntry {
  op_id: Uuid; actor: Actor; timestamp: string; summary: string
  /** The `HistorySummary.key` whose `.text` is `summary` — recorded alongside it
   *  rather than looked up from it, so a reworded phrase cannot lose its key
   *  (history-labels.ts). */
  label_key: string
  /** i18n interpolation values for `label_key`; absent for the phrases that take
   *  none. The runtime data `summary` embeds inline travels here instead, so the
   *  panel can rebuild the row in its own language. */
  label_args?: Record<string, string | number>
  affected: EntityRef[]; snapshot: Project
}
interface NamedCheckpoint { id: Uuid; label: string; actor: Actor; created_at: string; snapshot: Project }
export interface HistoryEntrySummary {
  op_id: Uuid; actor: Actor; timestamp: string; summary: string; label_key: string
  label_args?: Record<string, string | number>
  affected: EntityRef[]
  /** Names for `affected`, PARALLEL to it (same length, same order), resolved
   *  against whichever STORED snapshot holds each ref — this entry's own for an
   *  add / update / move, its PREDECESSOR's for a delete (an entry stores the
   *  state AFTER its own op, so a delete's own snapshot is precisely the one
   *  that no longer holds it). See resolveEntityLabels. */
  entity_labels: EntityLabel[]
}
export interface HistoryView {
  ops: HistoryEntrySummary[]; cursor: number; len: number
  /** Absolute stack index of `ops[0]` (= `len - ops.length`). `ops` is the LAST
   *  `limit` entries, so `ops[i]`'s absolute index is `window_start + i` — the
   *  index `cursor` is stated in, and the only index `jumpTo` accepts.
   *
   *  Without it a windowed read is unreadable: `view(100)` over a 150-entry stack
   *  reports `cursor: 149` against a 100-element array, and `evicted: 0` while the
   *  first op returned is the 51st of the project. `window_start === 0 &&
   *  evicted === 0` is the ONLY combination that means "ops[0] is the start of the
   *  project"; `window_start > 0` means the window is narrower than the stack, and
   *  `evicted > 0` means the stack itself is narrower than the project. */
  window_start: number
  checkpoints: Array<{ id: Uuid; label: string; actor: Actor; created_at: string }>
  /** How many entries `record()` has dropped off the FRONT since the stack was
   *  seeded (0 until the cap is first exceeded; back to 0 after `reset()`).
   *
   *  The eviction does NOT spare the 'Initial' entry, so once it has run the top
   *  row is an ordinary op and nothing else on the wire distinguishes "this is
   *  the start of the project" from "everything before this was discarded" —
   *  which is exactly what decides whether jumping back there is safe. `len` is
   *  the LIVE stack length and cannot answer it. */
  evicted: number
  lock_reason?: string
}
export interface HistoryStatus {
  cursor: number; len: number; can_undo: boolean; can_redo: boolean; lock_reason?: string
  /** storedSnapshotsHoldLayer() — the fps rate lock's condition, carried here
   *  because only History can answer it and the settings UI has to disable the
   *  rate control BEFORE the user tries. Not part of the `HistoryView` wire
   *  shape: buildProjectSummary folds it into `composition.fps_locked`, where a
   *  consumer will actually look for it. */
  holds_layer_anywhere: boolean
}

const DEFAULT_CAP = 200

/** The 'Initial' entry's summary half — shared by the constructor and reset() so
 *  the seed row is spelled once. */
function seed(initial: Project): Pick<HistoryEntry, 'summary' | 'label_key' | 'affected' | 'snapshot'> {
  return { summary: HISTORY_SUMMARY.initial.text, label_key: HISTORY_SUMMARY.initial.key, affected: [], snapshot: initial }
}

/** Ids/timestamps are injected by the actor (which owns the deterministic
 *  counter) rather than minted here. */
export class History {
  private snapshots: HistoryEntry[] = []
  private cursor = 0
  private cap = DEFAULT_CAP
  private checkpoints = new Map<Uuid, NamedCheckpoint>()
  private lockReasonStr: string | null = null
  /** Front-evicted entry count — see HistoryView.evicted. */
  private evictedCount = 0

  constructor(initial: Project, actor: Actor, opId: Uuid, timestamp = '<TS>') {
    this.snapshots.push({ op_id: opId, actor, timestamp, ...seed(initial) })
    this.cursor = 0
  }

  /** Discard the stack + checkpoints + lock, seed a fresh single 'Initial'
   *  entry. Used by replace_state on a
   *  project swap: the prior project's snapshots/checkpoints reference a
   *  different project_id and are incoherent against the new state. */
  reset(initial: Project, actor: Actor, opId: Uuid, timestamp = '<TS>'): void {
    this.snapshots = [{ op_id: opId, actor, timestamp, ...seed(initial) }]
    this.cursor = 0
    this.checkpoints.clear()
    this.lockReasonStr = null
    this.evictedCount = 0 // a fresh stack has discarded nothing
  }

  current(): Project { return this.snapshots[this.cursor].snapshot }

  record(entry: HistoryEntry): void {
    this.snapshots = this.snapshots.slice(0, this.cursor + 1) // truncate redo tail
    this.snapshots.push(entry)
    while (this.snapshots.length > this.cap) { this.snapshots.shift(); this.evictedCount += 1 } // evict front
    this.cursor = this.snapshots.length - 1
  }

  undo(): Project | null {
    if (this.cursor === 0) return null
    this.cursor -= 1
    return this.snapshots[this.cursor].snapshot
  }
  redo(): Project | null {
    if (this.cursor + 1 >= this.snapshots.length) return null
    this.cursor += 1
    return this.snapshots[this.cursor].snapshot
  }
  /** Random-access cursor move: `undo`/`redo` generalized to an arbitrary index.
   *  Returns `snapshots[index]`'s state — the state AFTER op `index` — or `null`
   *  for anything outside `[0, len)` (and for a non-integer index, which can only
   *  come from a malformed call).
   *
   *  Records NO entry, exactly like `undo`/`redo` (docs/features.md
   *  #undo-stack-scope): moving the cursor introduces no state from outside the
   *  stack, so there is nothing to record. A later `record()` therefore truncates
   *  the tail from here, which is the standard NLE "resume from the past". */
  jumpTo(index: number): Project | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.snapshots.length) return null
    this.cursor = index
    return this.snapshots[index].snapshot
  }
  canUndo(): boolean { return this.cursor > 0 }
  canRedo(): boolean { return this.cursor + 1 < this.snapshots.length }
  cursorIndex(): number { return this.cursor }
  len(): number { return this.snapshots.length }
  /** The stack cap — how many entries survive before `record()` evicts. Exposed
   *  so the history panel's "give me the whole stack" read can ask for exactly
   *  that many rows instead of hardcoding the number at the call site. */
  capacity(): number { return this.cap }

  lock(reason: string): void { this.lockReasonStr = reason }
  unlock(): void { this.lockReasonStr = null }
  lockReason(): string | null { return this.lockReasonStr }

  checkpoint(label: string, actor: Actor, id: Uuid, createdAt = '<TS>'): Uuid {
    this.checkpoints.set(id, { id, label, actor, created_at: createdAt, snapshot: this.current() })
    return id
  }
  restoreCheckpoint(id: Uuid, opId: Uuid, timestamp: string, actor: Actor): Project | null {
    const cp = this.checkpoints.get(id)
    if (!cp) return null
    const s = restoredCheckpointSummary(cp.label)
    this.record({ op_id: opId, actor, timestamp, summary: s.text, label_key: s.key, label_args: s.label_args, affected: [], snapshot: cp.snapshot })
    return cp.snapshot
  }
  listCheckpoints(): NamedCheckpoint[] {
    return [...this.checkpoints.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
  }
  /** Presence peek. The actor checks this BEFORE minting the restore op_id, so
   *  a CheckpointNotFound restore burns zero ids. */
  hasCheckpoint(id: Uuid): boolean { return this.checkpoints.has(id) }
  /** Drop a checkpoint (and with it the full snapshot it pins); `false` when
   *  there was no such id. Deliberately uncapped on the create side: each
   *  checkpoint holds a whole Project, so the list would turn to landfill in one
   *  session without a delete — with one, a hard cap would only produce a dead
   *  end (spec decision 10). Cursor and stack untouched: a checkpoint is not a
   *  stack row. */
  deleteCheckpoint(id: Uuid): boolean { return this.checkpoints.delete(id) }

  /** Preference patch applied to ALL snapshots + checkpoints; cursor unchanged
   *  (project_settings_patch_convention). The track-flag variant is
   *  replaceTrackFlagsEverywhere, the audio-role-flag one
   *  replaceRoleFlagsEverywhere. */
  replaceSettingsEverywhere(settings: ProjectSettings): void {
    for (const e of this.snapshots) e.snapshot = { ...e.snapshot, settings: { ...settings } }
    for (const cp of this.checkpoints.values()) cp.snapshot = { ...cp.snapshot, settings: { ...settings } }
  }

  /** Patch one track's flags into EVERY snapshot + checkpoint where the track
   *  exists; skip snapshots that lack it;
   *  cursor unchanged; never recorded (project_settings_patch_convention). */
  replaceTrackFlagsEverywhere(trackId: Uuid, patch: TrackFlagsPatch): void {
    const patchTrack = (p: Project): Project => {
      const ti = p.tracks.findIndex((t) => t.id === trackId)
      if (ti < 0) return p
      const nt = { ...p.tracks[ti] }
      if (typeof patch.enabled === 'boolean') nt.enabled = patch.enabled
      if (typeof patch.muted === 'boolean') nt.muted = patch.muted
      if (typeof patch.solo === 'boolean') nt.solo = patch.solo
      if (typeof patch.locked === 'boolean') nt.locked = patch.locked
      return { ...p, tracks: p.tracks.map((t, i) => (i === ti ? nt : t)) }
    }
    for (const e of this.snapshots) e.snapshot = patchTrack(e.snapshot)
    for (const cp of this.checkpoints.values()) cp.snapshot = patchTrack(cp.snapshot)
  }

  /** Patch one audio role's mute/solo into EVERY snapshot + checkpoint.
   *  Roles ALWAYS exist (absent → RoleMixSettings default {gain_db:0,muted:false,solo:false}),
   *  so unlike tracks there is NO skip-when-absent branch: the patch applies unconditionally.
   *  gain_db is preserved (only mute/solo are preference-shaped). cursor unchanged; never
   *  recorded (project_settings_patch_convention). */
  replaceRoleFlagsEverywhere(role: string, patch: RoleFlagsPatch): void {
    const apply = (p: Project): Project => {
      const cur = p.audio_roles[role]
      const s: RoleMixSettings = { gain_db: cur?.gain_db ?? 0, muted: cur?.muted ?? false, solo: cur?.solo ?? false }
      if (typeof patch.muted === 'boolean') s.muted = patch.muted
      if (typeof patch.solo === 'boolean') s.solo = patch.solo
      return { ...p, audio_roles: { ...p.audio_roles, [role]: s } }
    }
    for (const e of this.snapshots) e.snapshot = apply(e.snapshot)
    for (const cp of this.checkpoints.values()) cp.snapshot = apply(cp.snapshot)
  }

  /** Set `media_pool` on EVERY snapshot + checkpoint.
   *  Media imports live OUTSIDE the editing undo/redo stack, so the
   *  pool must be durable across undos/redos through unrelated edits (cursor
   *  unchanged; never recorded — project_settings_patch_convention). */
  replaceMediaPoolEverywhere(pool: Record<string, MediaItem>): void {
    for (const e of this.snapshots) e.snapshot = { ...e.snapshot, media_pool: pool }
    for (const cp of this.checkpoints.values()) cp.snapshot = { ...cp.snapshot, media_pool: pool }
  }

  /** The WHOLE composition envelope is preference-shaped (docs/features.md
   *  #undo-stack-scope), so `set_composition` never records and instead runs its
   *  patch over EVERY snapshot + checkpoint (cursor unchanged).
   *
   *  A transform, not a field copy, because two of the fields cannot be copied
   *  verbatim into an older snapshot: an fps change must re-snap THAT snapshot's
   *  own markers to the new grid, and a pinned `duration_us` must be floored at
   *  THAT snapshot's own content high-water mark or the older snapshot would
   *  strand a layer past the composition end. The actor supplies the transform
   *  (it owns the snap + autofit rules); History only fans it out. */
  replaceCompositionEverywhere(transform: (p: Project) => Project): void {
    for (const e of this.snapshots) e.snapshot = transform(e.snapshot)
    for (const cp of this.checkpoints.values()) cp.snapshot = transform(cp.snapshot)
  }

  /** Does ANY stored snapshot or checkpoint hold a layer? The history-scope half
   *  of the fps rate lock — see docs/features.md #undo-stack-scope.
   *
   *  `snapshots` includes the cursor's own entry, so this subsumes the current
   *  state; the actor tests the current layer count first only to report WHICH
   *  scope blocked (`locked_by`). */
  storedSnapshotsHoldLayer(): boolean {
    const holds = (p: Project): boolean => p.tracks.some((t) => t.layers.length > 0)
    return this.snapshots.some((e) => holds(e.snapshot))
      || [...this.checkpoints.values()].some((cp) => holds(cp.snapshot))
  }

  view(limit: number): HistoryView {
    const total = this.snapshots.length
    const take = Math.min(limit, total)
    const start = total - take
    // entity_labels resolves against STORED snapshots, never current() — an entry
    // whose layer has since been deleted still names it. An entry stores the state
    // AFTER its own op, so a delete is nameable only from its PREDECESSOR; the
    // index is absolute because that predecessor may sit outside this window
    // (history-labels.ts owns the fallback chain).
    // One flattener for the WHOLE call: adjacent entries share snapshot objects
    // (entry i's `after` is entry i+1's `before`), so without the memo every
    // snapshot is flattened twice — synchronous main work on every commit while
    // the panel is open.
    const flatten = createLayerFlattener()
    const ops = this.snapshots.slice(start).map((e, i) => ({
      op_id: e.op_id, actor: e.actor, timestamp: e.timestamp, summary: e.summary, label_key: e.label_key,
      label_args: e.label_args, affected: e.affected,
      entity_labels: resolveEntityLabels(e.snapshot, this.snapshots[start + i - 1]?.snapshot ?? null, e.affected, flatten),
    }))
    const checkpoints = this.listCheckpoints().map((c) => ({ id: c.id, label: c.label, actor: c.actor, created_at: c.created_at }))
    const v: HistoryView = { ops, cursor: this.cursor, len: total, window_start: start, checkpoints, evicted: this.evictedCount }
    if (this.lockReasonStr !== null) v.lock_reason = this.lockReasonStr
    return v
  }
  status(): HistoryStatus {
    const s: HistoryStatus = {
      cursor: this.cursor, len: this.snapshots.length, can_undo: this.canUndo(), can_redo: this.canRedo(),
      holds_layer_anywhere: this.storedSnapshotsHoldLayer(),
    }
    if (this.lockReasonStr !== null) s.lock_reason = this.lockReasonStr
    return s
  }
}
