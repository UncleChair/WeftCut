import type { TimeUs, Uuid } from './model'

// ── ValidationError — mirrors native/src/state/validate.rs variants ──
export type ValidationError =
  | { rule: 'InvalidCanvas'; width: number; height: number }
  | { rule: 'InvalidFps'; num: number; den: number }
  | { rule: 'DuplicateTransitionId'; transition: Uuid }
  | { rule: 'TransitionSelfReference'; transition: Uuid; layer: Uuid }
  | { rule: 'TransitionLayerMissing'; transition: Uuid; layer: Uuid }
  | { rule: 'TransitionCrossTrack'; transition: Uuid; from: Uuid; to: Uuid }
  | { rule: 'TransitionDurationOutOfRange'; transition: Uuid; duration: TimeUs }
  | { rule: 'TransitionDurationMismatch'; transition: Uuid; duration: TimeUs; overlap: TimeUs }
  | { rule: 'LayerInMultipleTransitions'; layer: Uuid }
  | { rule: 'DuplicateLayerId'; layer: Uuid }
  | { rule: 'InvalidLayerRange'; layer: Uuid; t_start: TimeUs; t_end: TimeUs }
  | { rule: 'MissingMedia'; layer: Uuid; media: Uuid }
  | { rule: 'InvalidSrcRange'; layer: Uuid; src_in: TimeUs; src_out: TimeUs }
  | { rule: 'SrcRangeExceedsMedia'; layer: Uuid; src_in: TimeUs; src_out: TimeUs; media_duration: TimeUs }
  | { rule: 'LayerOverlap'; track: Uuid; a: Uuid; a_start: TimeUs; a_end: TimeUs; b: Uuid; b_start: TimeUs; b_end: TimeUs }
  | { rule: 'DuplicateGroupId'; group: Uuid }
  | { rule: 'GroupBelowMinSize'; group: Uuid; members: number }
  | { rule: 'GroupMemberMissing'; group: Uuid; layer: Uuid }
  | { rule: 'LayerInMultipleGroups'; layer: Uuid; first: Uuid; second: Uuid }

// ── CommandError — mirrors native/src/state/actor.rs:336-444 variants ──
// Phase 1 only constructs a subset; the rest are typed for Phase 2/3.
export type CommandError =
  | { error: 'TrackNotFound'; track: Uuid }
  | { error: 'LayerNotFound'; layer: Uuid }
  | { error: 'WrongLayerKind'; layer: Uuid; expected: string }
  | { error: 'MarkerNotFound'; marker: Uuid }
  | { error: 'TransitionNotFound'; transition: Uuid }
  | { error: 'TransitionLayersNotAdjacent'; from: Uuid; to: Uuid; duration: TimeUs }
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

/** {top, inner?} for a TS CommandError — inner is the wrapped rule name. */
export function tsErrorVariant(e: CommandError): { top: string; inner?: string } {
  if (e.error === 'ValidationFailed') return { top: 'ValidationFailed', inner: e.detail.rule }
  return { top: e.error }
}

/** Extract {top, inner?} from a Rust `format!("{e:?}")` Debug string, e.g.
 *  "TrimEdgeOutOfRange { .. }" → {top}, "ValidationFailed(LayerOverlap { .. })"
 *  → {top, inner}. Rust renders the variant name as the leading identifier. */
export function parseOracleErrorVariant(debug: string): { top: string; inner?: string } {
  const m = /^([A-Za-z_]\w*)(?:\(([A-Za-z_]\w*))?/.exec(debug.trim())
  if (!m) return { top: debug.trim() }
  return m[2] ? { top: m[1], inner: m[2] } : { top: m[1] }
}
