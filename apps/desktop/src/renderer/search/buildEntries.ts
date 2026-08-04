import { formatTimecode } from "../frames";
import type { ProjectSummary, TrackSummary } from "../ipc";
import { layerDisplayName } from "../lib/layerName";
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

/// The two translators an entry may need, resolved by the caller for the same
/// reason `CommandInput` pre-resolves its labels: this file must stay a pure
/// function of its arguments (the Worker seam), so it can't reach for `i18n`.
/// `tEn` exists so a kind name indexed on a zh-CN UI is still findable by its
/// English name — the `enLabel` rule applied to Layers.
export interface LocaleInput {
  t: (key: string, values: Record<string, unknown>) => string;
  tEn: (key: string, values: Record<string, unknown>) => string;
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
  locale: LocaleInput,
): SearchEntry[] {
  const entries: SearchEntry[] = [];

  for (const c of commands) {
    entries.push({
      key: `command:${c.id}`,
      type: "command",
      label: c.label,
      context: "",
      haystacks: withPinyin(c.label === c.enLabel ? [c.label] : [c.label, c.enLabel]),
      payload: {
        type: "command",
        commandId: c.id,
        ...(c.actionId !== undefined ? { actionId: c.actionId } : {}),
      },
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
        // Same name the timeline block and the inspector show, so a hit reads as
        // the clip the user can see. Only the kind fallback is locale-dependent,
        // which is why the en-US pass can differ and earn a second haystack.
        const clipLabel = layerDisplayName(layer, locale.t);
        const enClipLabel = layerDisplayName(layer, locale.tEn);
        entries.push({
          key: `clip:${layer.id}`,
          type: "clip",
          label: clipLabel,
          context,
          haystacks: withPinyin(
            clipLabel === enClipLabel ? [clipLabel] : [clipLabel, enClipLabel],
          ),
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
