import i18n from "../i18n";
import { formatTimecode } from "../frames";
import { layerDisplayName } from "../lib/layerName";
import { trackDisplayName } from "../lib/trackName";
import { useProjectStore } from "../state/projectStore";
import type {
  CommandError,
  Rational,
  ValidationError,
} from "../../shared/commandErrors";

/// Refusal → one legible status-bar line. Three tiers, every variant filed
/// (the Record over the union is the completeness lock — adding a variant
/// without deciding its tier fails to compile, the same trick MENU_SPEC uses):
///
///   * suppress — no-op refusals (`NothingToUndo`). A native NLE does nothing
///     on an empty undo; a Debug row keeps the trace without the noise.
///   * generic — plumbing / not user-reachable from this process's UI. The
///     code is humanized mechanically; English only, per the status-log rule
///     that plumbing errors stay raw.
///   * curated — refusals a user can actually hit from the editor surface.
///     Hand-written copy under `errors.*` (en-US + zh-CN), uuids resolved to
///     the names the timeline shows.
///
/// The canonical `message` is ALWAYS composed with the en-US fixed t
/// (status-log contract: `message` is canonical English; the console's
/// translated rendering reads `i18n_key`/`i18n_args` instead).

export interface FormattedRefusal {
  level: "error" | "debug";
  /// Canonical English, names resolved. What non-curated consumers show.
  message: string;
  i18n_key?: string;
  i18n_args?: Record<string, unknown>;
}

/// Presentation upgrade slot (see issue #18): a curated refusal MAY one day
/// declare remedy actions ("unlock the track") for a surface that can show
/// buttons. Nothing constructs or reads these in v1 — the type exists so the
/// upgrade is an entry in COPY, not a re-architecture.
export interface RefusalAction {
  labelKey: string;
  run: () => Promise<void>;
}

/// Name/number resolution against the renderer's project mirror. Injectable
/// so formatter tests run against a fixture instead of the live store; `t`
/// decides the language of DERIVED names only (a stored label and a media name
/// are user content and language-neutral).
export interface RefusalContext {
  t: (key: string, values?: Record<string, unknown>) => string;
  layer(id: string): string;
  track(id: string): string;
  media(id: string): string;
  timecode(us: number): string;
  seconds(us: number): string;
  fps(r: Rational): string;
}

function shortId(id: string): string {
  return `#${id.slice(0, 8)}`;
}

export function liveRefusalContext(
  t: (key: string, values?: Record<string, unknown>) => string,
): RefusalContext {
  return {
    t,
    layer(id) {
      const layer = useProjectStore.getState().layerById.get(id);
      return layer ? layerDisplayName(layer, t) : shortId(id);
    },
    track(id) {
      const tracks = useProjectStore.getState().summary?.tracks ?? [];
      const track = tracks.find((candidate) => candidate.id === id);
      // The header's own name, or a refusal reads as being about a lane the
      // user cannot find.
      return track ? trackDisplayName(track, tracks, t) : shortId(id);
    },
    media(id) {
      const media = useProjectStore.getState().mediaById.get(id);
      const label = media?.label.trim();
      return label ? label : shortId(id);
    },
    timecode(us) {
      const comp = useProjectStore.getState().summary?.composition;
      return formatTimecode(us, comp?.fps_num ?? 30, comp?.fps_den ?? 1);
    },
    seconds(us) {
      return `${(us / 1e6).toFixed(2)}s`;
    },
    fps(r) {
      const value = r.num / r.den;
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
    },
  };
}

// ── The tier ledger ─────────────────────────────────────────────────────────

type CommandCode = CommandError["error"];
type ValidationRule = ValidationError["rule"];
type CommandOf<C extends CommandCode> = Extract<CommandError, { error: C }>;
type ValidationOf<R extends ValidationRule> = Extract<
  ValidationError,
  { rule: R }
>;

type Spec<E> =
  | { tier: "suppress" }
  | { tier: "generic" }
  | {
      tier: "curated";
      key: string;
      args: (err: E, ctx: RefusalContext) => Record<string, unknown>;
      actions?: (err: E, ctx: RefusalContext) => RefusalAction[];
    };

const COMMAND_COPY: { [C in CommandCode]: Spec<CommandOf<C>> } = {
  TrackNotFound: { tier: "generic" },
  LayerNotFound: { tier: "generic" },
  WrongLayerKind: { tier: "generic" },
  MarkerNotFound: { tier: "generic" },
  TransitionNotFound: { tier: "generic" },
  TransitionLayersNotAdjacent: {
    tier: "curated",
    key: "errors.transition_layers_not_adjacent",
    args: (e, ctx) => ({ from: ctx.layer(e.from), to: ctx.layer(e.to) }),
  },
  TransitionUnsupportedLayerKind: { tier: "generic" },
  TransitionInsufficientHandle: {
    tier: "curated",
    key: "errors.transition_insufficient_handle",
    args: (e, ctx) => ({
      layer: ctx.layer(e.layer),
      available: ctx.seconds(e.available_us),
    }),
  },
  CheckpointNotFound: { tier: "generic" },
  MediaNotFound: { tier: "generic" },
  // Curated PRESENTATION already exists: MediaPool's RemoveMediaDialog turns
  // this into a confirm flow with the reference list. Reaching the formatter
  // means some other path tripped it — generic is the honest fallback.
  MediaInUse: { tier: "generic" },
  TrackPositionOutOfRange: { tier: "generic" },
  TrackNotEmpty: {
    tier: "curated",
    key: "errors.track_not_empty",
    args: (e, ctx) => ({ track: ctx.track(e.track) }),
  },
  TrackNotRemovable: {
    tier: "curated",
    key: "errors.track_not_removable",
    args: (e, ctx) => ({ track: ctx.track(e.track) }),
  },
  TrackLocked: {
    tier: "curated",
    key: "errors.track_locked",
    args: (e, ctx) => ({ track: ctx.track(e.track) }),
  },
  SplitOutsideLayer: {
    tier: "curated",
    key: "errors.split_outside_layer",
    args: (e, ctx) => ({
      layer: ctx.layer(e.layer),
      time: ctx.timecode(e.at_t),
    }),
  },
  GroupLockedMember: {
    tier: "curated",
    key: "errors.group_locked_member",
    args: (e, ctx) => ({
      layer: ctx.layer(e.touched),
      locked: ctx.layer(e.locked_layer),
    }),
  },
  TrimEdgeOutOfRange: {
    tier: "curated",
    key: "errors.trim_edge_out_of_range",
    args: (e, ctx) => ({
      layer: ctx.layer(e.layer),
      time: ctx.timecode(e.new_t),
    }),
  },
  LayerParamsKindMismatch: { tier: "generic" },
  GroupNotFound: { tier: "generic" },
  LayerAlreadyGrouped: { tier: "generic" },
  GroupCreateNeedsTwoLayers: { tier: "generic" },
  LayerNotInGroup: { tier: "generic" },
  NothingToUndo: { tier: "suppress" },
  NothingToRedo: { tier: "suppress" },
  HistoryLocked: { tier: "generic" },
  // Dispatch unwraps to VALIDATION_COPY before consulting this entry; it
  // exists only so the Record stays total over the union.
  ValidationFailed: { tier: "generic" },
  EmptyKeyframeTrack: { tier: "generic" },
  UnknownKeyframeParam: { tier: "generic" },
  EffectNotFound: { tier: "generic" },
  EffectIndexOutOfRange: { tier: "generic" },
  FpsLockedByContent: {
    tier: "curated",
    key: "errors.fps_locked_by_content",
    args: (e, ctx) => ({
      current: ctx.fps(e.current),
      layers: e.layer_count,
      // i18next context suffix: `_history` picks the undo-history phrasing,
      // where `layer_count` is 0 by construction and must not be shown.
      context: e.locked_by === "history" ? "history" : undefined,
    }),
  },
  InvalidArgument: { tier: "generic" },
  Backend: { tier: "generic" },
};

const VALIDATION_COPY: { [R in ValidationRule]: Spec<ValidationOf<R>> } = {
  InvalidCanvas: { tier: "generic" },
  InvalidFps: { tier: "generic" },
  DuplicateTransitionId: { tier: "generic" },
  TransitionSelfReference: { tier: "generic" },
  TransitionLayerMissing: { tier: "generic" },
  TransitionCrossTrack: { tier: "generic" },
  TransitionUnsupportedLayerKind: { tier: "generic" },
  TransitionDurationOutOfRange: { tier: "generic" },
  TransitionDurationMismatch: { tier: "generic" },
  LayerInMultipleTransitions: { tier: "generic" },
  DuplicateLayerId: { tier: "generic" },
  InvalidLayerRange: { tier: "generic" },
  NegativeLayerStart: { tier: "generic" },
  OffGridLayerBoundary: { tier: "generic" },
  OffGridTime: { tier: "generic" },
  MissingMedia: { tier: "generic" },
  InvalidSrcRange: { tier: "generic" },
  SrcRangeExceedsMedia: { tier: "generic" },
  LayerOverlap: {
    tier: "curated",
    key: "errors.layer_overlap",
    args: (e, ctx) => ({
      incoming: ctx.layer(e.b),
      blocking: ctx.layer(e.a),
      track: ctx.track(e.track),
    }),
  },
  DuplicateGroupId: { tier: "generic" },
  GroupBelowMinSize: { tier: "generic" },
  GroupMemberMissing: { tier: "generic" },
  LayerInMultipleGroups: { tier: "generic" },
};

// ── Composition ─────────────────────────────────────────────────────────────

/// "TrackPositionOutOfRange" → "Track position out of range".
function humanizeCode(code: string): string {
  const spaced = code.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return (
    spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/// Non-discriminant fields, compact: `layer #3f9c12ab, at_t 1500000`. Uuids
/// are shortened — a generic line names things the mirror may not know — but
/// prose fields (`reason`, `detail`) pass through whole; the full structure
/// rides the entry's `details` either way.
function fieldSummary(err: Record<string, unknown>, discriminant: string): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(err)) {
    if (k === discriminant) continue;
    const shown =
      typeof v === "string" && UUID_RE.test(v)
        ? shortId(v)
        : typeof v === "object" && v !== null
          ? JSON.stringify(v)
          : String(v);
    parts.push(`${k} ${shown}`);
  }
  return parts.join(", ");
}

function composeGeneric(
  prefix: string,
  code: string,
  raw: Record<string, unknown>,
  discriminant: string,
): FormattedRefusal {
  const fields = fieldSummary(raw, discriminant);
  return {
    level: "error",
    message: `${prefix}${humanizeCode(code)}${fields ? ` (${fields})` : ""}`,
  };
}

function composeCurated<E>(
  spec: Extract<Spec<E>, { tier: "curated" }>,
  err: E,
): FormattedRefusal {
  const tEn = i18n.getFixedT("en-US");
  const activeArgs = spec.args(
    err,
    liveRefusalContext((k, v) => i18n.t(k, v ?? {})),
  );
  const enArgs = spec.args(err, liveRefusalContext((k, v) => tEn(k, v ?? {})));
  return {
    level: "error",
    message: tEn(spec.key, enArgs),
    i18n_key: spec.key,
    i18n_args: activeArgs,
  };
}

export function formatCommandError(err: CommandError): FormattedRefusal {
  if (err.error === "ValidationFailed") {
    const detail = err.detail;
    const spec = VALIDATION_COPY[detail.rule] as Spec<ValidationError>;
    if (spec.tier === "curated") return composeCurated(spec, detail);
    // Suppress has no validation member today; the arm keeps the switch total.
    if (spec.tier === "suppress") {
      return { level: "debug", message: humanizeCode(detail.rule) };
    }
    return composeGeneric(
      "Validation failed: ",
      detail.rule,
      detail as unknown as Record<string, unknown>,
      "rule",
    );
  }
  const spec = COMMAND_COPY[err.error] as Spec<CommandError>;
  if (spec.tier === "curated") return composeCurated(spec, err);
  if (spec.tier === "suppress") {
    return { level: "debug", message: humanizeCode(err.error) };
  }
  return composeGeneric(
    "",
    err.error,
    err as unknown as Record<string, unknown>,
    "error",
  );
}
