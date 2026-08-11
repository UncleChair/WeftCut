// apps/desktop/src/main/state/history-labels.ts
import type { EntityRef } from './history'
import type { Layer, Project, Uuid } from './model'
import { deriveTrackKindLabel, mediaLabel } from './summary'

/** One history row's text, carried as BOTH the i18n key the panel translates and
 *  the exact English phrase `HistoryEntry.summary` keeps on the wire.
 *
 *  Pairing them in one value is what pins the key: there is no English-prose →
 *  key lookup to fall out of step, so rewording a phrase cannot silently drop
 *  its row back to untranslated English. */
export interface HistorySummary {
  key: string; text: string
  /** i18n interpolation values for `key`. Present only for the templated
   *  summaries, whose locale strings carry the matching `{{…}}` placeholders —
   *  history-labels.test.ts gates the two against each other. */
  label_args?: Record<string, string | number>
}

/** Every recorded commit's summary. `text` is byte-identical to the literal the
 *  commit site used before this table existed — `project://history` serves it
 *  verbatim, so the MCP contract is extended by `label_key`, never rewritten.
 *  Keys mirror the `history.*` group in renderer/i18n/locales/; the two key sets
 *  are gated against each other by history-labels.test.ts. */
export const HISTORY_SUMMARY = {
  /** The stack's seed entry — minted by `History`'s constructor and `reset()`,
   *  not by a commit site. */
  initial: { key: 'history.initial', text: 'Initial' },

  layerAdd: { key: 'history.layer.add', text: 'Added layer' },
  layerPaste: { key: 'history.layer.paste', text: 'Pasted layer' },
  layerDuplicate: { key: 'history.layer.duplicate', text: 'Duplicated layer' },
  layerMove: { key: 'history.layer.move', text: 'Moved layer' },
  layerTrim: { key: 'history.layer.trim', text: 'Trimmed layer' },
  layerSplit: { key: 'history.layer.split', text: 'Split layer' },
  layerSplitByShots: { key: 'history.layer.split_by_shots', text: 'Split layer by shots' },
  layerDelete: { key: 'history.layer.delete', text: 'Deleted layer' },
  layerUpdate: { key: 'history.layer.update', text: 'Updated layer' },
  layerUpdateParams: { key: 'history.layer.update_params', text: 'Updated layer params' },
  layerKeyframeParam: { key: 'history.layer.keyframe_param', text: 'Keyframed layer param' },
  layerKeyframeParams: { key: 'history.layer.keyframe_params', text: 'Keyframed layer params' },
  layerScaleLink: { key: 'history.layer.scale_link', text: 'Linked scale' },
  layerScaleUnlink: { key: 'history.layer.scale_unlink', text: 'Unlinked scale' },
  layerSeparateAudio: { key: 'history.layer.separate_audio', text: 'Separated audio' },
  layerAddAvPair: { key: 'history.layer.add_av_pair', text: 'Added A/V pair' },
  layerRebindMotif: { key: 'history.layer.rebind_motif', text: 'Rebound motif layers' },

  trackAdd: { key: 'history.track.add', text: 'Added track' },
  trackDelete: { key: 'history.track.delete', text: 'Deleted track' },
  trackMove: { key: 'history.track.move', text: 'Moved track' },
  trackAddCaption: { key: 'history.track.add_caption', text: 'Added caption track' },

  markerAdd: { key: 'history.marker.add', text: 'Added marker' },
  markerAddShots: { key: 'history.marker.add_shots', text: 'Added shot markers' },
  markerUpdate: { key: 'history.marker.update', text: 'Updated marker' },
  markerRemove: { key: 'history.marker.remove', text: 'Removed marker' },

  effectAdd: { key: 'history.effect.add', text: 'Added effect' },
  effectUpdate: { key: 'history.effect.update', text: 'Updated effect' },
  effectReorder: { key: 'history.effect.reorder', text: 'Reordered effect' },
  effectRemove: { key: 'history.effect.remove', text: 'Removed effect' },

  transitionAdd: { key: 'history.transition.add', text: 'Added transition' },
  transitionUpdate: { key: 'history.transition.update', text: 'Updated transition' },
  transitionRemove: { key: 'history.transition.remove', text: 'Removed transition' },

  groupCreate: { key: 'history.group.create', text: 'Created group' },
  groupDissolve: { key: 'history.group.dissolve', text: 'Dissolved group' },
  groupAddMembers: { key: 'history.group.add_members', text: 'Added group members' },
  groupRemoveMembers: { key: 'history.group.remove_members', text: 'Removed group members' },
  groupRename: { key: 'history.group.rename', text: 'Renamed group' },

  captionRestyle: { key: 'history.caption.restyle', text: 'Restyled captions' },
} satisfies Record<string, HistorySummary>

// ── templated summaries — the phrase embeds runtime data, so the text is built
//    per call while the key stays a literal at exactly one site. ──

/** `remove_media force=true` — the cascade summary names the media and counts
 *  the layers that went with it. */
export function removedMediaSummary(media: Uuid, referencingCount: number): HistorySummary {
  return {
    key: 'history.media.remove_cascade', text: `Removed media ${media} and ${referencingCount} referencing layer(s)`,
    label_args: { media, count: referencingCount },
  }
}
/** `set_role_gain` — the summary names the audio role. */
export function roleGainSummary(role: string): HistorySummary {
  return { key: 'history.audio.set_role_gain', text: `Set ${role} role gain`, label_args: { role } }
}
/** `restore_checkpoint` — the summary quotes the checkpoint's own label. */
export function restoredCheckpointSummary(label: string): HistorySummary {
  return { key: 'history.checkpoint.restore', text: `Restored checkpoint '${label}'`, label_args: { label } }
}

/** Every key this module can emit — the table's plus the three templated ones,
 *  harvested from the builders themselves so a renamed key cannot slip past the
 *  locale drift test. */
export const HISTORY_SUMMARY_KEYS: readonly string[] = [
  ...Object.values(HISTORY_SUMMARY).map((s) => s.key),
  removedMediaSummary('', 0).key,
  roleGainSummary('').key,
  restoredCheckpointSummary('').key,
]

// ── entity labels — the other half of a readable row ──

/** One resolved `affected` entry's name.
 *
 *  `{ text }` is a real name — the entity's own label, its media's label, or (as
 *  the last resort) its raw id. `{ kind_key }` is the kind rung of the naming
 *  chain, which ONLY the renderer can translate, so the `kinds.*` key travels
 *  instead of an English word: main holds no locale bundle, and shipping "Color"
 *  into a zh-CN panel would name a clip differently from the clip itself.
 *
 *  Render it as `'text' in l ? l.text : t(l.kind_key)`. */
export type EntityLabel = { text: string } | { kind_key: string }

/** renderer/lib/layerName.ts + TrackHeader.tsx's own expression,
 *  `t("kinds." + kind.toLowerCase())`. */
const kindKey = (kind: string): { kind_key: string } => ({ kind_key: `kinds.${kind.toLowerCase()}` })

/** Every `kind_key` a label can carry: the six LayerParams discriminants plus
 *  `deriveTrackKindLabel`'s two outputs. Enumerated so the locale test can check
 *  they all resolve — an unresolvable one renders as a raw key in the panel. */
export const ENTITY_KIND_KEYS: readonly string[] =
  ['VideoClip', 'ImageOverlay', 'Audio', 'Text', 'Color', 'Motif', 'Video'].map((k) => kindKey(k).kind_key)

/** The one name a layer is shown under — the main-side twin of
 *  renderer/lib/layerName.ts `layerDisplayName`: own label (blank counts as
 *  absent), else its media's label, else its kind. Never the uuid, so a history
 *  row cannot name a clip differently from the clip itself. */
function layerLabel(p: Project, l: Layer): EntityLabel {
  const own = l.label?.trim()
  if (own) return { text: own }
  // `layerParamsView` fills `media_label` from the pool and falls back to the
  // media id when the item is absent — the renderer shows the same string there.
  if ('media' in l.params) {
    const item = p.media_pool[l.params.media]
    const media = (item ? mediaLabel(item) : l.params.media).trim()
    if (media) return { text: media }
  }
  return kindKey(l.params.kind)
}

/** One ref's name in ONE snapshot, or null when that snapshot doesn't hold it
 *  (or holds it nameless). `layers` is the caller's pre-flattened `p` — see
 *  resolveEntityLabels. */
function labelIn(p: Project, layers: Layer[], ref: EntityRef): EntityLabel | null {
  switch (ref.kind) {
    case 'Layer': {
      const l = layers.find((x) => x.id === ref.id)
      return l ? layerLabel(p, l) : null
    }
    case 'Track': {
      const t = p.tracks.find((x) => x.id === ref.id)
      return t ? (t.label !== null ? { text: t.label } : kindKey(deriveTrackKindLabel(t))) : null
    }
    case 'Marker': {
      const m = p.markers.find((x) => x.id === ref.id)
      return m && m.label.trim() !== '' ? { text: m.label } : null
    }
  }
}

/** Human names for one entry's `affected` — the whole reason this runs in main:
 *  the renderer holds only CURRENT state, so a row whose entity has since been
 *  deleted could only ever print a uuid there.
 *
 *  Two snapshots, because a `HistoryEntry` stores the state AFTER its own op:
 *  an add / update / move is named from `after` (which holds the entity), a
 *  DELETE only from `before` (the predecessor entry's state — the post-op
 *  snapshot no longer holds what the op removed). Hence the fallback chain,
 *  and hence `Deleted layer 「Clip 01」` renders a name rather than a uuid.
 *
 *  Returns a PARALLEL array (same length, same order as `affected`) so the two
 *  cannot desync. A ref neither snapshot names falls back to its raw id. */
export function resolveEntityLabels(after: Project, before: Project | null, affected: EntityRef[]): EntityLabel[] {
  if (affected.length === 0) return []
  // Flatten each snapshot's layers ONCE, not once per ref: view() calls this for
  // every entry it returns, on every panel refetch.
  const afterLayers = after.tracks.flatMap((t) => t.layers)
  const beforeLayers = before !== null ? before.tracks.flatMap((t) => t.layers) : null
  return affected.map((ref): EntityLabel =>
    labelIn(after, afterLayers, ref)
      ?? (before !== null && beforeLayers !== null ? labelIn(before, beforeLayers, ref) : null)
      ?? { text: ref.id })
}
