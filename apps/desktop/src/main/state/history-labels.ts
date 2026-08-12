// apps/desktop/src/main/state/history-labels.ts
import type { EntityRef } from './history'
import type { Layer, Project, Uuid } from './model'
import { mediaLabel, TRACK_ROLE_WIRE } from './summary'

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
  layerMoveToNewTrack: { key: 'history.layer.move_to_new_track', text: 'Moved to a new track' },
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
 *  the last resort) its raw id. `{ label_key }` is a DERIVED name, which ONLY
 *  the renderer can translate, so the key (plus any interpolation values)
 *  travels instead of an English word: main holds no locale bundle, and shipping
 *  "Color" into a zh-CN panel would name a clip differently from the clip
 *  itself.
 *
 *  Render it as `'text' in l ? l.text : t(l.label_key, l.label_args ?? {})`. */
export type EntityLabel =
  | { text: string }
  | { label_key: string; label_args?: Record<string, string | number> }

/** renderer/lib/layerName.ts's own expression, `t("kinds." + kind.toLowerCase())`. */
const kindKey = (kind: string): { label_key: string } => ({ label_key: `kinds.${kind.toLowerCase()}` })

/** A track with no stored label, named exactly as renderer/lib/trackName.ts
 *  names it: from its role, else from its 1-based slot in the track vector.
 *  `index` is that slot, which is the same number the renderer computes — the
 *  header and the history row cannot disagree. */
function derivedTrackKey(role: string | null, index: number): { label_key: string; label_args?: Record<string, number> } {
  const wire = role !== null ? TRACK_ROLE_WIRE[role] : undefined
  if (wire !== undefined) return { label_key: `tracks.roles.${wire}` }
  return { label_key: 'tracks.positional', label_args: { n: index + 1 } }
}

/** Every `label_key` a label can carry: the six LayerParams discriminants,
 *  `Marker` (markers have no kind discriminant of their own — the rung exists so
 *  a blank-labelled marker names its kind instead of falling through to a
 *  36-char uuid), and the derived track names. Enumerated so the locale test can
 *  check they all resolve — an unresolvable one renders as a raw key in the
 *  panel. */
export const ENTITY_LABEL_KEYS: readonly string[] = [
  ...['VideoClip', 'ImageOverlay', 'Audio', 'Text', 'Color', 'Motif', 'Marker'].map((k) => kindKey(k).label_key),
  ...[...Object.keys(TRACK_ROLE_WIRE), null].map((role) => derivedTrackKey(role, 0).label_key),
]

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

/** One ref's name in ONE snapshot, or null when that snapshot doesn't hold it.
 *  `layers` is the caller's memoized flattening of `p` — see resolveEntityLabels.
 *
 *  Every branch runs the same chain the Layer one does: own label (BLANK COUNTS
 *  AS ABSENT — the panel filters zero-length names out, so an untrimmed `'  '`
 *  would render a row with no entity name at all), then the kind rung. Only a ref
 *  the snapshot does not hold returns null. */
function labelIn(p: Project, layers: Layer[], ref: EntityRef): EntityLabel | null {
  switch (ref.kind) {
    case 'Layer': {
      const l = layers.find((x) => x.id === ref.id)
      return l ? layerLabel(p, l) : null
    }
    case 'Track': {
      const index = p.tracks.findIndex((x) => x.id === ref.id)
      if (index < 0) return null
      const t = p.tracks[index]
      const own = t.label?.trim()
      // The DERIVED name, not the dominant-layer-class one: a role-stamped
      // track's label is null, and the kind rung would render "Video" in a
      // history row while its header reads "A roll".
      return own ? { text: own } : derivedTrackKey(t.role, index)
    }
    case 'Marker': {
      const m = p.markers.find((x) => x.id === ref.id)
      if (!m) return null
      const own = m.label.trim()
      // Markers carry no kind discriminant, so the rung is the word itself —
      // without it a blank-labelled marker fell through to the raw uuid, which
      // is exactly what this module's "Never the uuid" rule forbids.
      return own ? { text: own } : kindKey('Marker')
    }
  }
}

/** Memoized `tracks.flatMap(t => t.layers)` keyed on snapshot IDENTITY, for the
 *  span of ONE `view()` call.
 *
 *  Consecutive stack entries SHARE snapshot objects — entry i's `after` is entry
 *  i+1's `before` — so a naive resolve flattens every snapshot twice, and this is
 *  synchronous main-process work on every commit while the panel is open (a gizmo
 *  drag commits repeatedly). The Map is per-call and dropped with it, so it can
 *  never serve a stale flattening: `History` replaces snapshot objects wholesale
 *  on every patch-everywhere path rather than mutating them. */
export function createLayerFlattener(): (p: Project) => Layer[] {
  const cache = new Map<Project, Layer[]>()
  return (p) => {
    const hit = cache.get(p)
    if (hit) return hit
    const flat = p.tracks.flatMap((t) => t.layers)
    cache.set(p, flat)
    return flat
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
 *  cannot desync. A ref neither snapshot names falls back to its raw id.
 *
 *  `flatten` is the caller's memo — `view()` passes ONE flattener across every
 *  entry so a snapshot shared by two adjacent entries is flattened once, not
 *  twice. The default keeps a lone call self-contained. */
export function resolveEntityLabels(
  after: Project, before: Project | null, affected: EntityRef[],
  flatten: (p: Project) => Layer[] = createLayerFlattener(),
): EntityLabel[] {
  if (affected.length === 0) return []
  // `flatten(before)` is reached only when `after` cannot name the ref, so an
  // entry whose refs all resolve from its own snapshot never touches the
  // predecessor at all.
  return affected.map((ref): EntityLabel =>
    labelIn(after, flatten(after), ref)
      ?? (before !== null ? labelIn(before, flatten(before), ref) : null)
      ?? { text: ref.id })
}
