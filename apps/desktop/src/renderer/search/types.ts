import type { ActionId } from "../shortcuts/defs";

export type SearchEntryType =
  | "command"
  | "media"
  | "track"
  | "clip"
  | "caption"
  | "marker";

export interface MediaUsage {
  layerId: string;
  trackId: string;
  trackLabel: string;
  tStartUs: number;
}

/// What activation needs, discriminated by `type`. Ids only (+ the times
/// needed to seek) — the index may be stale, so navigation re-validates
/// ids against projectStore's live maps at activation time.
export type SearchPayload =
  | { type: "command"; commandId: string; actionId?: ActionId }
  | { type: "media"; mediaId: string; available: boolean; usages: MediaUsage[] }
  | { type: "track"; trackId: string; firstLayerId: string | null }
  | { type: "clip"; layerId: string; tStartUs: number }
  | { type: "caption"; layerId: string; tStartUs: number }
  | { type: "marker"; markerId: string; tUs: number };

export interface SearchEntry {
  /// `${type}:${id}` — stable React list key.
  key: string;
  type: SearchEntryType;
  /// Display label; always haystacks[0].
  label: string;
  /// Secondary display line (media kind, "track · timecode", …).
  context: string;
  /// [0] = label; then extra text (en-US command label) and pinyin strings.
  haystacks: string[];
  payload: SearchPayload;
}
