import { formatTimecode } from "../frames";
import type { ProjectSummary, TrackSummary } from "../ipc";
import type { ActionId } from "../shortcuts/defs";
import { pinyinHaystacks } from "./pinyin";
import type { MediaUsage, SearchEntry } from "./types";

/// Command snapshot the index builder consumes — labels pre-resolved by
/// the caller (searchIndexStore) so this stays a pure function of its
/// arguments: the spec's Worker seam.
export interface CommandInput {
  id: string;
  /// Active-locale label.
  label: string;
  /// en-US label — extra haystack so English queries hit on zh-CN UI.
  enLabel: string;
  actionId?: ActionId;
}

const CAPTION_SNIPPET_MAX = 80;

function withPinyin(haystacks: string[]): string[] {
  const out = [...haystacks];
  for (const h of haystacks) {
    const p = pinyinHaystacks(h);
    if (p) out.push(p.full, p.initials);
  }
  return out;
}

function trackDisplayLabel(track: TrackSummary, index: number): string {
  return track.label ?? `${track.kind} ${index + 1}`;
}

export function buildEntries(
  summary: ProjectSummary | null,
  commands: CommandInput[],
): SearchEntry[] {
  const entries: SearchEntry[] = [];

  for (const c of commands) {
    entries.push({
      key: `command:${c.id}`,
      type: "command",
      label: c.label,
      context: "",
      haystacks: withPinyin(c.label === c.enLabel ? [c.label] : [c.label, c.enLabel]),
      payload: { type: "command", commandId: c.id, actionId: c.actionId },
    });
  }
  if (!summary) return entries;

  const { fps_num: fpsNum, fps_den: fpsDen } = summary.composition;
  const tc = (us: number) => formatTimecode(us, fpsNum, fpsDen);

  const usagesByMedia = new Map<string, MediaUsage[]>();
  summary.tracks.forEach((track, ti) => {
    const trackLabel = trackDisplayLabel(track, ti);
    for (const layer of track.layers) {
      const p = layer.params as { media_id?: string };
      if (typeof p.media_id !== "string") continue;
      const list = usagesByMedia.get(p.media_id) ?? [];
      list.push({
        layerId: layer.id,
        trackId: track.id,
        trackLabel,
        tStartUs: layer.t_start_us,
      });
      usagesByMedia.set(p.media_id, list);
    }
  });
  for (const list of usagesByMedia.values()) {
    list.sort((a, b) => a.tStartUs - b.tStartUs);
  }

  for (const m of summary.media) {
    entries.push({
      key: `media:${m.id}`,
      type: "media",
      label: m.label,
      context: m.kind,
      haystacks: withPinyin([m.label]),
      payload: {
        type: "media",
        mediaId: m.id,
        available: m.available,
        usages: usagesByMedia.get(m.id) ?? [],
      },
    });
  }

  summary.tracks.forEach((track, ti) => {
    const trackLabel = trackDisplayLabel(track, ti);
    const first = track.layers.reduce<{ id: string; t: number } | null>(
      (acc, l) => (acc === null || l.t_start_us < acc.t ? { id: l.id, t: l.t_start_us } : acc),
      null,
    );
    entries.push({
      key: `track:${track.id}`,
      type: "track",
      label: trackLabel,
      context: track.role ?? track.kind,
      haystacks: withPinyin([trackLabel]),
      payload: { type: "track", trackId: track.id, firstLayerId: first?.id ?? null },
    });

    for (const layer of track.layers) {
      const context = `${trackLabel} · ${tc(layer.t_start_us)}`;
      if (layer.params.kind === "Text") {
        const snippet = layer.params.content.replace(/\s+/g, " ").trim().slice(0, CAPTION_SNIPPET_MAX);
        if (!snippet) continue;
        entries.push({
          key: `caption:${layer.id}`,
          type: "caption",
          label: snippet,
          context,
          haystacks: withPinyin([snippet]),
          payload: { type: "caption", layerId: layer.id, tStartUs: layer.t_start_us },
        });
      } else {
        const p = layer.params as { media_label?: string };
        const clipLabel = layer.label ?? p.media_label ?? layer.kind;
        entries.push({
          key: `clip:${layer.id}`,
          type: "clip",
          label: clipLabel,
          context,
          haystacks: withPinyin([clipLabel]),
          payload: { type: "clip", layerId: layer.id, tStartUs: layer.t_start_us },
        });
      }
    }
  });

  for (const mk of summary.markers) {
    if (!mk.label.trim()) continue;
    entries.push({
      key: `marker:${mk.id}`,
      type: "marker",
      label: mk.label,
      context: tc(mk.t_us),
      haystacks: withPinyin([mk.label]),
      payload: { type: "marker", markerId: mk.id, tUs: mk.t_us },
    });
  }

  return entries;
}
