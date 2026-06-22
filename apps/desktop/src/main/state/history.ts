// apps/desktop/src/main/state/history.ts
import type { Composition, MediaItem, Project, ProjectSettings, Uuid } from './model'

export type Actor = { kind: 'User' } | { kind: 'Agent'; client: string }
export type EntityRef =
  | { kind: 'Track'; id: Uuid } | { kind: 'Layer'; id: Uuid } | { kind: 'Marker'; id: Uuid }

/** native/src/state/project.rs:151-162 TrackFlagsPatch — preference-shaped track
 *  toggles. null/absent = "don't touch". */
export interface TrackFlagsPatch { enabled?: boolean | null; muted?: boolean | null; solo?: boolean | null; locked?: boolean | null }

export interface HistoryEntry {
  op_id: Uuid; actor: Actor; timestamp: string; summary: string
  affected: EntityRef[]; snapshot: Project
}
interface NamedCheckpoint { id: Uuid; label: string; actor: Actor; created_at: string; snapshot: Project }
export interface HistoryEntrySummary { op_id: Uuid; actor: Actor; timestamp: string; summary: string; affected: EntityRef[] }
export interface HistoryView { ops: HistoryEntrySummary[]; cursor: number; len: number; checkpoints: Array<{ id: Uuid; label: string; created_at: string }>; lock_reason?: string }
export interface HistoryStatus { cursor: number; len: number; can_undo: boolean; can_redo: boolean; lock_reason?: string }

const DEFAULT_CAP = 200

/** 1:1 port of native/src/state/history.rs. Ids/timestamps are injected by the
 *  actor (which owns the deterministic counter) rather than minted here. */
export class History {
  private snapshots: HistoryEntry[] = []
  private cursor = 0
  private cap = DEFAULT_CAP
  private checkpoints = new Map<Uuid, NamedCheckpoint>()
  private lockReasonStr: string | null = null

  constructor(initial: Project, actor: Actor, opId: Uuid, timestamp = '<TS>') {
    this.snapshots.push({ op_id: opId, actor, timestamp, summary: 'Initial', affected: [], snapshot: initial })
    this.cursor = 0
  }

  current(): Project { return this.snapshots[this.cursor].snapshot }

  record(entry: HistoryEntry): void {
    this.snapshots = this.snapshots.slice(0, this.cursor + 1) // truncate redo tail
    this.snapshots.push(entry)
    while (this.snapshots.length > this.cap) this.snapshots.shift() // evict front
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
  canUndo(): boolean { return this.cursor > 0 }
  canRedo(): boolean { return this.cursor + 1 < this.snapshots.length }
  cursorIndex(): number { return this.cursor }
  len(): number { return this.snapshots.length }

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
    this.record({ op_id: opId, actor, timestamp, summary: `Restored checkpoint '${cp.label}'`, affected: [], snapshot: cp.snapshot })
    return cp.snapshot
  }
  listCheckpoints(): NamedCheckpoint[] {
    return [...this.checkpoints.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
  }

  /** Preference patch applied to ALL snapshots + checkpoints; cursor unchanged
   *  (project_settings_patch_convention). The track-flag variant is
   *  replaceTrackFlagsEverywhere; the audio-role-flag variant is not yet ported. */
  replaceSettingsEverywhere(settings: ProjectSettings): void {
    for (const e of this.snapshots) e.snapshot = { ...e.snapshot, settings: { ...settings } }
    for (const cp of this.checkpoints.values()) cp.snapshot = { ...cp.snapshot, settings: { ...settings } }
  }

  /** native/src/state/history.rs:281-292 — patch one track's flags into EVERY
   *  snapshot + checkpoint where the track exists; skip snapshots that lack it;
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

  /** native/src/state/history.rs:225 — set `media_pool` on EVERY snapshot +
   *  checkpoint. Media imports live OUTSIDE the editing undo/redo stack, so the
   *  pool must be durable across undos/redos through unrelated edits (cursor
   *  unchanged; never recorded — project_settings_patch_convention). */
  replaceMediaPoolEverywhere(pool: Record<string, MediaItem>): void {
    for (const e of this.snapshots) e.snapshot = { ...e.snapshot, media_pool: pool }
    for (const cp of this.checkpoints.values()) cp.snapshot = { ...cp.snapshot, media_pool: pool }
  }

  /** native/src/state/history.rs:246 — copy the 7 canvas fields (width/height/
   *  fps/sample_rate/channels/color_space/background) into EVERY snapshot +
   *  checkpoint. Composition canvas is preference-shaped, so the change must
   *  survive undo/redo (cursor unchanged; never recorded). duration_us /
   *  duration_pinned are NOT canvas fields and are left untouched. */
  replaceCompositionCanvasEverywhere(canvas: Composition): void {
    const patch = (p: Project): Project => ({
      ...p,
      composition: { ...p.composition,
        width: canvas.width, height: canvas.height, fps: canvas.fps,
        sample_rate: canvas.sample_rate, channels: canvas.channels,
        color_space: canvas.color_space, background: canvas.background },
    })
    for (const e of this.snapshots) e.snapshot = patch(e.snapshot)
    for (const cp of this.checkpoints.values()) cp.snapshot = patch(cp.snapshot)
  }

  view(limit: number): HistoryView {
    const total = this.snapshots.length
    const take = Math.min(limit, total)
    const ops = this.snapshots.slice(total - take).map((e) => ({ op_id: e.op_id, actor: e.actor, timestamp: e.timestamp, summary: e.summary, affected: e.affected }))
    const checkpoints = this.listCheckpoints().map((c) => ({ id: c.id, label: c.label, created_at: c.created_at }))
    const v: HistoryView = { ops, cursor: this.cursor, len: total, checkpoints }
    if (this.lockReasonStr !== null) v.lock_reason = this.lockReasonStr
    return v
  }
  status(): HistoryStatus {
    const s: HistoryStatus = { cursor: this.cursor, len: this.snapshots.length, can_undo: this.canUndo(), can_redo: this.canRedo() }
    if (this.lockReasonStr !== null) s.lock_reason = this.lockReasonStr
    return s
  }
}
