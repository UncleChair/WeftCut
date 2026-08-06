// apps/desktop/src/main/state/__tests__/summary.projection.test.ts
//
// Focused unit tests for buildProjectSummary — the pure projection from
// Project + HistoryStatus + fileExists into the renderer's ProjectSummary view.
import { describe, it, expect } from 'vitest'
import { buildProjectSummary } from '../summary'
import { freshActor, aRollId, bRollId } from './pbt/harness'
import { mediaItemTemplate } from '../mutations/media'

describe('ProjectSummary projection', () => {
  it('projects an empty project with the two reserved tracks and zero layers', () => {
    const a = freshActor()
    const s = buildProjectSummary(a.snapshot(), a.historyStatus(), () => false)

    // Top-level counts
    expect(s.track_count).toBe(2)
    expect(s.layer_count).toBe(0)
    expect(s.duration_us).toBe(0)

    // Two reserved tracks: A-roll first, B-roll second
    expect(s.tracks).toHaveLength(2)
    expect(s.tracks[0].role).toBe('a-roll')
    expect(s.tracks[1].role).toBe('b-roll')
    expect(s.tracks[0].layers).toHaveLength(0)
    expect(s.tracks[1].layers).toHaveLength(0)

    // Composition defaults
    expect(s.composition.width).toBe(1920)
    expect(s.composition.height).toBe(1080)
    expect(s.composition.fps_num).toBe(30)
    expect(s.composition.fps_den).toBe(1)
    expect(s.composition.duration_pinned).toBe(false)

    // Fresh project has no media, markers, or groups
    expect(s.media).toHaveLength(0)
    expect(s.markers).toHaveLength(0)
    expect(s.groups).toHaveLength(0)

    // Four standard audio roles always present
    expect(s.audio_roles.map((r) => r.role)).toEqual(['dialogue', 'music', 'sfx', 'voiceover'])
  })

  it('reflects one added color layer in layer_count, duration_us, and tracks', () => {
    const a = freshActor()
    a.dispatch('add_layer', { track: aRollId(a), kind: 'color', t_start_us: 0, t_end_us: 5_000_000 })
    const s = buildProjectSummary(a.snapshot(), a.historyStatus(), () => false)

    expect(s.layer_count).toBe(1)
    // duration_us autofits to the layer end when not pinned
    expect(s.duration_us).toBe(5_000_000)

    const aRoll = s.tracks[0]
    expect(aRoll.layers).toHaveLength(1)
    const layer = aRoll.layers[0]
    expect(layer.kind).toBe('Color')
    expect(layer.t_start_us).toBe(0)
    expect(layer.t_end_us).toBe(5_000_000)
    expect(layer.enabled).toBe(true)
    expect(layer.locked).toBe(false)
    expect(layer.params.kind).toBe('Color')
  })

  it('reflects layers on both A-roll and B-roll tracks independently', () => {
    const a = freshActor()
    a.dispatch('add_layer', { track: aRollId(a), kind: 'color', t_start_us: 0, t_end_us: 3_000_000 })
    a.dispatch('add_layer', { track: bRollId(a), kind: 'color', t_start_us: 1_000_000, t_end_us: 4_000_000 })
    const s = buildProjectSummary(a.snapshot(), a.historyStatus(), () => false)

    expect(s.layer_count).toBe(2)
    // duration_us is max of all layer ends
    expect(s.duration_us).toBe(4_000_000)

    const aRoll = s.tracks.find((t) => t.role === 'a-roll')!
    const bRoll = s.tracks.find((t) => t.role === 'b-roll')!

    expect(aRoll.layers).toHaveLength(1)
    expect(aRoll.layers[0].t_end_us).toBe(3_000_000)

    expect(bRoll.layers).toHaveLength(1)
    expect(bRoll.layers[0].t_start_us).toBe(1_000_000)
    expect(bRoll.layers[0].t_end_us).toBe(4_000_000)
  })

  it('flags a media item as unavailable when fileExists returns false for its path', () => {
    const a = freshActor()
    // Import a media item into the pool with a known path
    const mediaId = 'aaaaaaaa-0000-0000-0000-000000000001'
    a.dispatch('add_media_item', { media: mediaItemTemplate(mediaId, 'Video', 10_000_000) })

    // fileExists always returns false → media.available should be false
    const s = buildProjectSummary(a.snapshot(), a.historyStatus(), () => false)

    expect(s.media).toHaveLength(1)
    const m = s.media[0]
    expect(m.id).toBe(mediaId)
    expect(m.available).toBe(false)
    // decode_route bypass passes through as-is (no existence-gated slots)
    expect(m.decode_route).toEqual({ route: 'bypass' })
  })

  it('marks a media item available and returns the label when fileExists returns true', () => {
    const a = freshActor()
    const mediaId = 'bbbbbbbb-0000-0000-0000-000000000002'
    a.dispatch('add_media_item', { media: mediaItemTemplate(mediaId, 'Video', 8_000_000) })

    // fileExists always returns true → available is true
    const s = buildProjectSummary(a.snapshot(), a.historyStatus(), () => true)

    expect(s.media).toHaveLength(1)
    const m = s.media[0]
    expect(m.available).toBe(true)
    // mediaItemTemplate sets path_abs='media/clip.bin'; label derives from basename
    expect(m.label).toBe('clip.bin')
    expect(m.duration_us).toBe(8_000_000)
  })

  it('projects history flags (can_undo / can_redo) correctly before and after a mutation', () => {
    const a = freshActor()

    // Fresh actor: nothing to undo, nothing to redo
    const before = buildProjectSummary(a.snapshot(), a.historyStatus(), () => false)
    expect(before.history.can_undo).toBe(false)
    expect(before.history.can_redo).toBe(false)
    expect(before.history.cursor).toBe(0)

    // After a mutation: can undo, cannot redo; cursor advanced off Initial
    a.dispatch('add_layer', { track: aRollId(a), kind: 'color', t_start_us: 0, t_end_us: 2_000_000 })
    const after = buildProjectSummary(a.snapshot(), a.historyStatus(), () => false)
    expect(after.history.can_undo).toBe(true)
    expect(after.history.can_redo).toBe(false)
    expect(after.history.len).toBeGreaterThan(before.history.len)
    expect(after.history.cursor).toBeGreaterThan(0)

    // After undo: cursor returns to the Initial entry (0); can_redo becomes true
    a.dispatch('undo', {})
    const undone = buildProjectSummary(a.snapshot(), a.historyStatus(), () => false)
    expect(undone.history.can_undo).toBe(false)
    expect(undone.history.can_redo).toBe(true)
    expect(undone.history.cursor).toBe(0)
  })

  it('nullifies a proxied route\'s readiness slots when the media is missing, keeps them when present', () => {
    // routeForSummary existence-gates the proxy readiness
    // paths: a serialized-but-deleted proxy must project as null, not a stale path.
    // format_version is NOT a path and passes through unchanged.
    const mediaId = 'cccccccc-0000-0000-0000-000000000003'
    const proxiedRoute = {
      route: 'proxied' as const,
      quick_proxy: 'workspace/quick.mp4',
      full_proxy: 'workspace/full.mp4',
      format_version: 7,
    }

    const buildWith = (fileExists: (p: string) => boolean) => {
      const a = freshActor()
      const item = mediaItemTemplate(mediaId, 'Video', 6_000_000)
      item.decode_route = { ...proxiedRoute }
      a.dispatch('add_media_item', { media: item })
      return buildProjectSummary(a.snapshot(), a.historyStatus(), fileExists)
    }

    // Missing media → both readiness slots nullified; format_version preserved.
    const missing = buildWith(() => false)
    expect(missing.media[0].decode_route).toEqual({
      route: 'proxied',
      quick_proxy: null,
      full_proxy: null,
      format_version: 7,
    })

    // Present media → both readiness paths survive intact.
    const present = buildWith(() => true)
    expect(present.media[0].decode_route).toEqual({
      route: 'proxied',
      quick_proxy: 'workspace/quick.mp4',
      full_proxy: 'workspace/full.mp4',
      format_version: 7,
    })
  })

  it('projects audio_channels from media metadata: 2 when audio stream present, null when absent', () => {
    const a = freshActor()

    // Media WITH audio: set channels to 2 in the metadata fixture.
    const mediaWithAudioId = 'dddddddd-0000-0000-0000-000000000004'
    const itemWithAudio = mediaItemTemplate(mediaWithAudioId, 'Video', 4_000_000, true)
    if (itemWithAudio.metadata.audio) {
      itemWithAudio.metadata.audio.channels = 2
    }
    a.dispatch('add_media_item', { media: itemWithAudio })

    // Media WITHOUT audio: omit the audio stream.
    const mediaWithoutAudioId = 'eeeeeeee-0000-0000-0000-000000000005'
    const itemWithoutAudio = mediaItemTemplate(mediaWithoutAudioId, 'Video', 4_000_000, false)
    a.dispatch('add_media_item', { media: itemWithoutAudio })

    const s = buildProjectSummary(a.snapshot(), a.historyStatus(), () => true)

    // Sort to ensure stable ordering by id.
    const mediaByLabel = s.media.sort((x, y) => x.id.localeCompare(y.id))
    const withAudio = mediaByLabel.find((m) => m.id === mediaWithAudioId)
    const withoutAudio = mediaByLabel.find((m) => m.id === mediaWithoutAudioId)

    expect(withAudio).toBeDefined()
    expect(withAudio!.audio_channels).toBe(2)

    expect(withoutAudio).toBeDefined()
    expect(withoutAudio!.audio_channels).toBeNull()
  })
})
