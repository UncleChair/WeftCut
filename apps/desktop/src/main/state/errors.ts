import type { Rational, TimeUs, Uuid } from './model'
// Type-only: erased at compile time, so this does NOT pull the wasm-backed eval
// module into every consumer of errors.ts.
import type { GridDomain } from './snap'

// ── ValidationError — mirrors native/src/state/validate.rs variants ──
export type ValidationError =
  | { rule: 'InvalidCanvas'; width: number; height: number }
  | { rule: 'InvalidFps'; num: number; den: number }
  | { rule: 'DuplicateTransitionId'; transition: Uuid }
  | { rule: 'TransitionSelfReference'; transition: Uuid; layer: Uuid }
  | { rule: 'TransitionLayerMissing'; transition: Uuid; layer: Uuid }
  | { rule: 'TransitionCrossTrack'; transition: Uuid; from: Uuid; to: Uuid }
  | { rule: 'TransitionUnsupportedLayerKind'; transition: Uuid; layer: Uuid }
  | { rule: 'TransitionDurationOutOfRange'; transition: Uuid; duration: TimeUs }
  | { rule: 'TransitionDurationMismatch'; transition: Uuid; duration: TimeUs; overlap: TimeUs }
  | { rule: 'LayerInMultipleTransitions'; layer: Uuid }
  | { rule: 'DuplicateLayerId'; layer: Uuid }
  | { rule: 'InvalidLayerRange'; layer: Uuid; t_start: TimeUs; t_end: TimeUs }
  // ── Grid backstop (docs/data-model.md § Timeline-field alignment). `fps` rides
  // along because "off grid" is meaningless without the lattice it is off:
  // 2_999_999 is off grid at 30/1 and canonical at 1000000/1. A caller that hits
  // either variant asked for a sub-quantum time; the fix is to snap and retry, and
  // the value it should have sent is `round(i * 1e6 * den / num)`.
  //
  // On `OffGridLayerBoundary` there are TWO lattices (spec R2-D6): `grid` names
  // which one, and `fps` carries that lattice's rational — so for an Audio layer it
  // reads `48000/1`, the 48 kHz mix lattice, NOT a frame rate. Without `grid` a
  // caller could not tell a 48 kHz audio rejection from an absurd 48000 fps comp.
  | { rule: 'OffGridLayerBoundary'; layer: Uuid; field: 't_start_us' | 't_end_us'; t: TimeUs; fps: Rational; grid: GridDomain }
  | { rule: 'OffGridTime'; entity: 'Composition' | 'Marker'; id: Uuid | null; field: string; t: TimeUs; fps: Rational }
  | { rule: 'MissingMedia'; layer: Uuid; media: Uuid }
  | { rule: 'InvalidSrcRange'; layer: Uuid; src_in: TimeUs; src_out: TimeUs }
  | { rule: 'SrcRangeExceedsMedia'; layer: Uuid; src_in: TimeUs; src_out: TimeUs; media_duration: TimeUs }
  | { rule: 'LayerOverlap'; track: Uuid; a: Uuid; a_start: TimeUs; a_end: TimeUs; b: Uuid; b_start: TimeUs; b_end: TimeUs }
  | { rule: 'DuplicateGroupId'; group: Uuid }
  | { rule: 'GroupBelowMinSize'; group: Uuid; members: number }
  | { rule: 'GroupMemberMissing'; group: Uuid; layer: Uuid }
  | { rule: 'LayerInMultipleGroups'; layer: Uuid; first: Uuid; second: Uuid }

// ── CommandError — the full mutation-error vocabulary. Individual dispatch
// arms construct only the variants they need. ──
export type CommandError =
  | { error: 'TrackNotFound'; track: Uuid }
  | { error: 'LayerNotFound'; layer: Uuid }
  | { error: 'WrongLayerKind'; layer: Uuid; expected: string }
  | { error: 'MarkerNotFound'; marker: Uuid }
  | { error: 'TransitionNotFound'; transition: Uuid }
  | { error: 'TransitionLayersNotAdjacent'; from: Uuid; to: Uuid; duration: TimeUs }
  | { error: 'TransitionUnsupportedLayerKind'; layer: Uuid; kind: string }
  | { error: 'TransitionInsufficientHandle'; layer: Uuid; available_us: TimeUs }
  | { error: 'CheckpointNotFound'; checkpoint: Uuid }
  | { error: 'MediaNotFound'; media: Uuid }
  | { error: 'MediaInUse'; media: Uuid; referenced_by: Uuid[] }
  | { error: 'TrackPositionOutOfRange'; position: number; len: number }
  | { error: 'TrackNotEmpty'; track: Uuid }
  | { error: 'TrackNotRemovable'; track: Uuid }
  | { error: 'TrackLocked'; track: Uuid }
  | { error: 'SplitOutsideLayer'; layer: Uuid; at_t: TimeUs }
  | { error: 'GroupLockedMember'; group: Uuid; locked_layer: Uuid; touched: Uuid }
  | { error: 'TrimEdgeOutOfRange'; layer: Uuid; new_t: TimeUs; cur_start: TimeUs; cur_end: TimeUs }
  | { error: 'LayerParamsKindMismatch'; layer: Uuid; actual: string; patch: string }
  | { error: 'GroupNotFound'; group: Uuid }
  | { error: 'LayerAlreadyGrouped'; layer: Uuid; existing: Uuid }
  | { error: 'GroupCreateNeedsTwoLayers'; got: number }
  | { error: 'LayerNotInGroup'; group: Uuid; layer: Uuid }
  | { error: 'NothingToUndo' }
  | { error: 'NothingToRedo' }
  | { error: 'HistoryLocked'; reason: string }
  | { error: 'ValidationFailed'; detail: ValidationError }
  | { error: 'EmptyKeyframeTrack'; layer: Uuid; param_key: string }
  | { error: 'UnknownKeyframeParam'; layer: Uuid; param_key: string }
  | { error: 'EffectNotFound'; effect: Uuid }
  | { error: 'EffectIndexOutOfRange'; index: number; len: number }
  // ── Composition rate lock (spec R2-D1) ──
  // An fps change re-snaps every layer edge, Motif `src_in_us`, the composition
  // duration and every marker: each edit point moves by up to half a new frame and
  // a short layer can collapse and reject the whole operation. So the rate is
  // immutable once the timeline holds a layer.
  //
  // Deliberately a hard rejection, not a confirmation flag or a convert workflow.
  // There is NO UI caller — `SettingsPanel` only reads fps to format timecode — so
  // the lock removes no existing user capability; it turns an MCP patch that looked
  // like an ordinary setting into an actionable error. `layer_count` is the blocking
  // condition made legible, and `current` tells the caller what rate it is stuck
  // with without a second round trip. Rate conversion, if ever wanted, is
  // `duplicate timeline → convert` with the rounding previewed — a feature of its
  // own, not a settings patch. A LAYER-LESS project is still freely re-rateable.
  | { error: 'FpsLockedByContent'; current: Rational; requested: Rational; layer_count: number }
  | { error: 'InvalidArgument'; field: string; detail: string }
  | { error: 'Backend'; detail: string }

/** Thrown by `validate`. Caught by `commit`, re-thrown as CommandFailure(ValidationFailed). */
export class ValidationFailure extends Error {
  constructor(public readonly err: ValidationError) {
    super(err.rule)
    this.name = 'ValidationFailure'
  }
}

/** Thrown by mutation helpers / the actor to abort a command. */
export class CommandFailure extends Error {
  constructor(public readonly err: CommandError) {
    super(err.error)
    this.name = 'CommandFailure'
  }
}

export function isValidationFailure(e: unknown): e is ValidationFailure {
  return e instanceof ValidationFailure
}
export function isCommandFailure(e: unknown): e is CommandFailure {
  return e instanceof CommandFailure
}
