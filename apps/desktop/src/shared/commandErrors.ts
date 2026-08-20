// The structured refusal vocabulary: raised by the main-process state actor,
// serialized as `Error(JSON.stringify(CommandError))` across IPC (Electron
// flattens custom Error props, so the structure rides `message`), and parsed
// back by the renderer (renderer/errors/parseCommandError.ts).
//
// Lives in shared/ because both sides need the types and the project-reference
// graph forbids the direct route: tsconfig.main already references
// tsconfig.web (for renderer/eval), so a renderer import from main/state
// would cycle. main/state/errors.ts re-exports these so its consumers keep
// their './errors' import path.
//
// The primitive aliases below are structural twins of main/state/model.ts
// (Uuid/TimeUs/Rational) and renderer/grid.ts (GridDomain, re-exported from
// here); TypeScript's structural typing makes them interchangeable.

export type Uuid = string
export type TimeUs = number
export interface Rational { num: number; den: number }

/** Which lattice a time lives on. Diagnostics only — see renderer/grid.ts. */
export type GridDomain = 'frame' | 'sample'

// ── ValidationError — the variants raised by main/state/validate.ts ──
export type ValidationError =
  | { rule: 'InvalidCanvas'; width: number; height: number }
  | { rule: 'InvalidFps'; num: number; den: number }
  | { rule: 'DuplicateTransitionId'; transition: Uuid }
  | { rule: 'TransitionSelfReference'; transition: Uuid; layer: Uuid }
  | { rule: 'TransitionLayerMissing'; transition: Uuid; layer: Uuid }
  | { rule: 'TransitionCrossTrack'; transition: Uuid; from: Uuid; to: Uuid }
  | { rule: 'TransitionUnsupportedLayerKind'; transition: Uuid; layer: Uuid }
  // `transition` is null when an overlap-placement add refuses `d > min(len_A,
  // len_B)` BEFORE the transition id is minted (the id contract: a refused add
  // burns no id, so there is no id to name yet). validate.ts always names one.
  | { rule: 'TransitionDurationOutOfRange'; transition: Uuid | null; duration: TimeUs }
  | { rule: 'TransitionDurationMismatch'; transition: Uuid; duration: TimeUs; overlap: TimeUs }
  // The borrowed-tail counter out of its lane: `0 ≤ extended_us ≤ duration_us`.
  // Structural (validate-only) — no layer edit can corrupt the counter, so
  // reconcile never drops on it (see validateTransitions).
  | { rule: 'TransitionExtendedOutOfRange'; transition: Uuid; extended: TimeUs; duration: TimeUs }
  | { rule: 'LayerInMultipleTransitions'; layer: Uuid }
  | { rule: 'DuplicateLayerId'; layer: Uuid }
  | { rule: 'InvalidLayerRange'; layer: Uuid; t_start: TimeUs; t_end: TimeUs }
  // Timeline time starts at zero. Deliberately its OWN rule rather than a `i >= 0`
  // clause folded into the grid predicate below: a negative time can be perfectly
  // canonical (-1_000_000 is frame -30 at 30 fps), so reporting it as "off grid"
  // would send a caller chasing the wrong fix. Repaired (lifted to 0) on load,
  // rejected on edit — the same asymmetry the grid rules use and for the same
  // reason: `replaceState` shares this validator with `project_open`, so a hard rule
  // with no matching load repair makes an already-written project unopenable.
  | { rule: 'NegativeLayerStart'; layer: Uuid; t_start: TimeUs }
  // ── Grid backstop (docs/data-model.md § Timeline-field alignment). `fps` rides
  // along because "off grid" is meaningless without the lattice it is off:
  // 2_999_999 is off grid at 30/1 and canonical at 1000000/1. A caller that hits
  // either variant asked for a sub-quantum time, and `snap_to` is the nearest
  // lattice point — the value it should have sent — so the retry is mechanical
  // instead of the caller re-deriving `round(i * 1e6 * den / num)` from `fps`.
  //
  // On `OffGridLayerBoundary` there are TWO lattices (spec R2-D6): `grid` names
  // which one, and `fps` carries that lattice's rational — so for an Audio layer it
  // reads `48000/1`, the 48 kHz mix lattice, NOT a frame rate. Without `grid` a
  // caller could not tell a 48 kHz audio rejection from an absurd 48000 fps comp.
  | { rule: 'OffGridLayerBoundary'; layer: Uuid; field: 't_start_us' | 't_end_us'; t: TimeUs; fps: Rational; grid: GridDomain; snap_to: TimeUs }
  | { rule: 'OffGridTime'; entity: 'Composition' | 'Marker'; id: Uuid | null; field: string; t: TimeUs; fps: Rational; snap_to: TimeUs }
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
  // remove_transition's restore move is blocked: `layer` (the incoming layer or
  // one of its group siblings) cannot land on its destination because a
  // non-moving layer occupies it — the user may have filled the vacated gap,
  // and the system never makes room.
  | { error: 'TransitionRestoreCollision'; layer: Uuid }
  // Overlap-placement add refused: the participants share a group, so moving
  // the incoming layer would drag the outgoing one along and the overlap never
  // opens. Never falls back to extend silently — the caller ungroup-s or asks
  // for placement 'extend' explicitly.
  | { error: 'TransitionParticipantsShareGroup'; from: Uuid; to: Uuid }
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
  // immutable once the timeline holds a layer. Scope and escape hatch:
  // docs/features.md #undo-stack-scope.
  //
  // `layer_count` is the blocking condition made legible, and `current` tells the
  // caller what rate it is stuck with without a second round trip.
  //
  // `locked_by` names the SCOPE that blocked, because the judgement spans the
  // stored history, not just the live state (see setComposition): `current` = the
  // timeline holds layers right now, `history` = it doesn't, but some snapshot or
  // checkpoint does, so undo could still resurrect old-grid layers. The two carry
  // the same remedy (empty the timeline, then reopen the project — `replace_state`
  // resets the stack) and differ only in what the message can honestly say; with
  // `history`, `layer_count` is 0 and must NOT be read as "nothing is blocking".
  | { error: 'FpsLockedByContent'; current: Rational; requested: Rational; layer_count: number; locked_by: 'current' | 'history' }
  | { error: 'InvalidArgument'; field: string; detail: string }
  | { error: 'Backend'; detail: string }
