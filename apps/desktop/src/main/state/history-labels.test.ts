// apps/desktop/src/main/state/history-labels.test.ts
import { describe, it, expect } from 'vitest'
import en from '../../renderer/i18n/locales/en-US'
import zh from '../../renderer/i18n/locales/zh-CN'
import { ENTITY_LABEL_KEYS, HISTORY_SUMMARY, HISTORY_SUMMARY_KEYS, removedMediaSummary, resolveEntityLabels,
  restoredCheckpointSummary, roleGainSummary, type EntityLabel, type HistorySummary } from './history-labels'
import type { EntityRef } from './history'
import { blankProject, type Layer, type MediaItem, type Project } from './model'
import { seededGen } from './ids'
import { colorParams, textParamsDefault } from './mutations/add'
import { videoClipParams } from './mutations/media'
import { TEXT_NAME_MAX, textSnippet } from '../../shared/textSnippet'

/** Dotted leaf keys of a locale subtree, e.g. `history.layer.add`. */
function leafKeys(obj: Record<string, unknown>, prefix: string): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : leafKeys(v as Record<string, unknown>, `${prefix}${k}.`))
}
const sorted = (xs: readonly string[]): string[] => [...xs].sort()
const LOCALES = { 'en-US': en, 'zh-CN': zh }
const at = (loc: unknown, dotted: string): unknown => dotted.split('.').reduce<any>((acc, k) => acc?.[k], loc)
const placeholders = (s: string): string[] => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
/** The three templated summaries, with throwaway values — what matters is the
 *  key + which args each supplies. */
const TEMPLATED: HistorySummary[] = [removedMediaSummary('m-1', 2), roleGainSummary('music'), restoredCheckpointSummary('cp')]

// The drift guard. `summary` → i18n-key lookups keyed on English prose are
// unpinned; this is what replaces them, so it has to be airtight in both
// directions — an orphan locale key is as much a bug as a missing one.
describe('history label keys', () => {
  it('has no duplicate keys', () => {
    expect(new Set(HISTORY_SUMMARY_KEYS).size).toBe(HISTORY_SUMMARY_KEYS.length)
  })
  for (const [name, loc] of Object.entries(LOCALES)) {
    it(`matches the ${name} locale key set exactly`, () => {
      expect(sorted(leafKeys(loc.history as unknown as Record<string, unknown>, 'history.'))).toEqual(sorted(HISTORY_SUMMARY_KEYS))
    })
  }
  it('keeps every table entry`s English text as its en-US value', () => {
    // Only the static table is checked; the templated three are covered by the
    // placeholder tests below.
    for (const s of Object.values(HISTORY_SUMMARY)) expect(at(en, s.key), s.key).toBe(s.text)
  })

  // A placeholder with no matching `label_args` entry renders literally as
  // "{{media}}" in the panel; an arg with no placeholder silently drops the
  // detail. Both directions are checked, in both locales.
  it('gives every templated key the exact placeholders its builder supplies', () => {
    for (const [name, loc] of Object.entries(LOCALES)) {
      for (const s of TEMPLATED) {
        expect(placeholders(at(loc, s.key) as string), `${name} ${s.key}`).toEqual(sorted(Object.keys(s.label_args ?? {})))
      }
    }
  })
  // `satisfies` keeps the table's literal types, so the compiler already proves no
  // static entry carries `label_args`; what it can't see is a placeholder someone
  // adds to the locale string, which would then render literally.
  it('leaves the static entries placeholder-free — they are given no args', () => {
    for (const [name, loc] of Object.entries(LOCALES)) {
      for (const s of Object.values(HISTORY_SUMMARY)) {
        expect(placeholders(at(loc, s.key) as string), `${name} ${s.key}`).toEqual([])
      }
    }
  })
  it('resolves every label_key an entity label can emit', () => {
    for (const [name, loc] of Object.entries(LOCALES)) {
      for (const key of ENTITY_LABEL_KEYS) expect(typeof at(loc, key), `${name} ${key}`).toBe('string')
    }
  })
  // The positional track name is the one entity label that carries args; a
  // placeholder mismatch renders "{{n}}" beside a lane in the panel.
  it('gives the positional track key exactly the `n` placeholder', () => {
    for (const [name, loc] of Object.entries(LOCALES)) {
      expect(placeholders(at(loc, 'tracks.positional') as string), name).toEqual(['n'])
    }
  })
})

function fresh(): Project { return blankProject(seededGen(), 'labels') }
const COMP = { width: 1920, height: 1080 }
function mediaItem(id: string, path: string, label: string | null): MediaItem {
  return {
    id, label, path_abs: path, path_rel: null, kind: 'Video',
    metadata: { duration_us: 1_000_000, video: null, audio: null, container_format: null },
    file_hash_blake3: '0', file_size: 0, file_mtime: 0, imported_at: '2026-01-01T00:00:00Z',
    decode_route: { route: 'bypass' }, conform_path: null, waveform_path: null, thumbnails_dir: null,
  }
}
function layer(p: Project, l: Layer): Project {
  return { ...p, tracks: p.tracks.map((t, i) => (i === 0 ? { ...t, layers: [...t.layers, l] } : t)) }
}
function mkLayer(id: string, label: string | null, params: Layer['params']): Layer {
  return { id, label, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {}, params, effects: [] }
}

/** The naming chain alone, with no predecessor snapshot to fall back to. The
 *  two-snapshot behaviour has its own cases at the bottom of this block. */
const labels = (p: Project, refs: EntityRef[]): EntityLabel[] => resolveEntityLabels(p, null, refs)

// The naming chain is renderer/lib/layerName.ts `layerDisplayName`'s, rung for
// rung — a history row must not name a clip differently from the clip itself.
describe('resolveEntityLabels', () => {
  it('prefers a layer`s own label', () => {
    const p = layer(fresh(), mkLayer('L1', 'Clip 01', colorParams({ r: 0, g: 0, b: 0, a: 255 }, 16, 9)))
    expect(labels(p, [{ kind: 'Layer', id: 'L1' }])).toEqual([{ text: 'Clip 01' }])
  })
  it('falls back to the media label, then the file basename', () => {
    const base = fresh()
    const p = layer({ ...base, media_pool: { M1: mediaItem('M1', '/clips/take 7.mp4', null) } },
      mkLayer('L1', null, videoClipParams('M1', 0, 1_000_000)))
    expect(labels(p, [{ kind: 'Layer', id: 'L1' }])).toEqual([{ text: 'take 7.mp4' }])
  })
  // The kind rung travels as a KEY, not an English word: only the renderer holds
  // the locale bundle, and a zh-CN row reading "Color" would name a clip
  // differently from the clip itself.
  it('emits the kind KEY for a media-less layer (blank label counts as absent)', () => {
    const p = layer(fresh(), mkLayer('L1', '  ', colorParams({ r: 0, g: 0, b: 0, a: 255 }, 16, 9)))
    expect(labels(p, [{ kind: 'Layer', id: 'L1' }])).toEqual([{ label_key: 'kinds.color' }])
  })
  // Text is the one kind with a rung BELOW media and above the kind: nothing
  // writes a caption's label, so `kinds.text` would name every cue in an
  // imported .srt identically. It travels as `text`, not a key — the renderer
  // has nothing to translate in the user's own words — and it arrives collapsed
  // to one line, because a history row is one line.
  it('names an unlabelled Text layer by its content, collapsed to one line', () => {
    const p = layer(fresh(), mkLayer('L1', null, textParamsDefault('first line\nsecond line', COMP)))
    expect(labels(p, [{ kind: 'Layer', id: 'L1' }])).toEqual([{ text: 'first line second line' }])
  })
  it('still reaches the kind KEY when the Text layer has no words yet', () => {
    const p = layer(fresh(), mkLayer('L1', null, textParamsDefault('   ', COMP)))
    expect(labels(p, [{ kind: 'Layer', id: 'L1' }])).toEqual([{ label_key: 'kinds.text' }])
  })
  // Both sides call shared/textSnippet at shared TEXT_NAME_MAX, so equal
  // strings hold by construction. What this pins is that THIS side still routes
  // through it: a local `slice(0, 64)` here would pass every case above and
  // still hand one caption two names.
  it('caps a pasted paragraph through the shared rule, not a local slice', () => {
    const long = 'x'.repeat(500)
    const p = layer(fresh(), mkLayer('L1', null, textParamsDefault(long, COMP)))
    expect(labels(p, [{ kind: 'Layer', id: 'L1' }])).toEqual([{ text: textSnippet(long, TEXT_NAME_MAX) }])
  })
  // The track rungs are renderer/lib/trackName.ts's, so a history row names a
  // lane exactly as its header does — role first, then the 1-based slot in the
  // track vector, which is the same number the renderer counts.
  it('names a track by its label, else its role, else its position', () => {
    const p = fresh()
    const [t0, t1] = p.tracks
    expect(labels({ ...p, tracks: [{ ...t0, label: 'A-Roll' }, t1] }, [{ kind: 'Track', id: t0.id }])).toEqual([{ text: 'A-Roll' }])
    expect(labels(p, [{ kind: 'Track', id: t0.id }])).toEqual([{ label_key: 'tracks.roles.a-roll' }])
    expect(labels(p, [{ kind: 'Track', id: t1.id }])).toEqual([{ label_key: 'tracks.roles.b-roll' }])
    const extra = { ...t1, id: 'T-extra', role: null, label: null }
    expect(labels({ ...p, tracks: [t0, t1, extra] }, [{ kind: 'Track', id: 'T-extra' }]))
      .toEqual([{ label_key: 'tracks.positional', label_args: { n: 3 } }])
  })
  // Every branch trims, not just the Layer one. The panel filters zero-length
  // names out, so an untrimmed '   ' renders a row with NO entity name at all —
  // strictly worse than the kind rung the same track would get from `null`.
  it('treats a blank track label as absent, exactly as the layer chain does', () => {
    const p = fresh()
    const [t0, t1] = p.tracks
    for (const blank of ['', '   ']) {
      expect(labels({ ...p, tracks: [{ ...t0, label: blank }, t1] }, [{ kind: 'Track', id: t0.id }]))
        .toEqual([{ label_key: 'tracks.roles.a-roll' }])
    }
  })
  const marker = (label: string) =>
    ({ id: 'M', t_us: 0, end_t_us: null, label, color: { r: 0, g: 0, b: 0, a: 255 }, metadata: {} })
  it('names a marker by its label', () => {
    const p = fresh()
    expect(labels({ ...p, markers: [marker('Shot 3')] }, [{ kind: 'Marker', id: 'M' }])).toEqual([{ text: 'Shot 3' }])
  })
  // Markers carry no kind discriminant of their own, so before this rung existed
  // a blank-labelled marker fell through to the raw uuid — contradicting this
  // module's "Never the uuid" rule and putting 36 characters in a history row.
  it('gives a blank-labelled marker its kind rung rather than the uuid', () => {
    const p = fresh()
    for (const blank of ['', '   ']) {
      expect(labels({ ...p, markers: [marker(blank)] }, [{ kind: 'Marker', id: 'M' }]))
        .toEqual([{ label_key: 'kinds.marker' }])
    }
  })
  it('falls back to the raw id for a ref the snapshot does not hold', () => {
    expect(labels(fresh(), [{ kind: 'Layer', id: 'gone' }, { kind: 'Track', id: 'gone-t' }, { kind: 'Marker', id: 'gone-m' }]))
      .toEqual([{ text: 'gone' }, { text: 'gone-t' }, { text: 'gone-m' }])
  })
  it('stays parallel to affected — same length, same order', () => {
    const p = layer(fresh(), mkLayer('L1', 'Clip 01', colorParams({ r: 0, g: 0, b: 0, a: 255 }, 16, 9)))
    const refs = [{ kind: 'Layer' as const, id: 'gone' }, { kind: 'Layer' as const, id: 'L1' }, { kind: 'Track' as const, id: p.tracks[0].id }]
    expect(labels(p, refs)).toHaveLength(refs.length)
    expect(labels(p, refs)[1]).toEqual({ text: 'Clip 01' })
  })

  // ── the `before` snapshot: a HistoryEntry stores the state AFTER its own op,
  //    so a delete is nameable ONLY from its predecessor. Without this the
  //    `Deleted layer` row — the one a user most wants to identify — shows a uuid,
  //    which is the whole thing main-side resolution exists to avoid.
  it('names a ref the AFTER snapshot dropped from the BEFORE snapshot', () => {
    const before = layer(fresh(), mkLayer('L1', 'Clip 01', colorParams({ r: 0, g: 0, b: 0, a: 255 }, 16, 9)))
    const after = fresh() // the delete landed
    expect(resolveEntityLabels(after, before, [{ kind: 'Layer', id: 'L1' }])).toEqual([{ text: 'Clip 01' }])
  })
  it('prefers AFTER over BEFORE, so a rename shows the NEW name', () => {
    const before = layer(fresh(), mkLayer('L1', 'Old name', colorParams({ r: 0, g: 0, b: 0, a: 255 }, 16, 9)))
    const after = layer(fresh(), mkLayer('L1', 'New name', colorParams({ r: 0, g: 0, b: 0, a: 255 }, 16, 9)))
    expect(resolveEntityLabels(after, before, [{ kind: 'Layer', id: 'L1' }])).toEqual([{ text: 'New name' }])
  })
  it('still falls back to the raw id when NEITHER snapshot holds the ref', () => {
    expect(resolveEntityLabels(fresh(), fresh(), [{ kind: 'Layer', id: 'ghost' }])).toEqual([{ text: 'ghost' }])
  })
})
