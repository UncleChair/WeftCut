import type { TrackSummary } from "../ipc";

/// The one name a track is shown under, anywhere it is named: its own label,
/// else its role, else its position in the z-stack.
///
/// An absent label means the name is DERIVED (ADR 0042), and a blank one counts
/// as absent exactly as it does for layers — so a lane is never nameless.
/// Deriving here rather than in main is what makes the reserved lanes
/// translatable at all: main holds no locale bundle, so a name computed there
/// would ship one language into every UI.
///
/// `tracks` is the project's track vector in DATA order (index 0 = bottom of the
/// z-stack), never the timeline's reversed-and-filtered row order: the number is
/// the track's 1-based position from the bottom, so a rendered row list would
/// renumber every lane the moment the A/B filter hides one. It renumbers when
/// lanes are added or pruned, which is what Premiere and Resolve do too.
///
/// `t` is structurally typed rather than `TFunction` so callers can pass
/// `useTranslation().t` straight through (same pattern as `layerDisplayName`).
export function trackDisplayName(
  track: TrackSummary,
  tracks: readonly TrackSummary[],
  t: (key: string, values: Record<string, unknown>) => string,
): string {
  const own = track.label?.trim();
  if (own) return own;
  if (track.role) {
    return t(`tracks.roles.${track.role}`, { defaultValue: track.role });
  }
  const index = tracks.findIndex((candidate) => candidate.id === track.id);
  // A track the caller's list does not hold is one whose snapshot hasn't caught
  // up yet, and a spawned lane appends at the tail — so the tail slot is the
  // number it is about to be given, rather than the "Track 0" a bare -1 prints.
  return t("tracks.positional", { n: (index < 0 ? tracks.length : index) + 1 });
}
