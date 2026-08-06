// apps/desktop/src/main/state/__tests__/mcp.agent-hardening.test.ts
// Regression gates for .scratch/mcp-agent-hardening: (02) update_effect must
// reject an unparseable patch, never commit nothing and report success; (03)
// add_video_layer must place the video and its auto-paired audio atomically or
// not at all; (04) a clip's paired audio must land on its OWN track's audio
// lane, not a shared one.
import { describe, it, expect } from 'vitest'
import { freshActor, aRollId, bRollId } from './pbt/harness'

const VIDEO_MEDIA = '00000000-0000-7000-8000-000000000201'

type Actor = ReturnType<typeof freshActor>

function addVideoWithAudio(actor: Actor, mediaId = VIDEO_MEDIA): string {
  const r = actor.dispatch('add_media', { id: mediaId, kind: 'Video', duration_us: 10_000_000, with_audio: true })
  expect(r.ok, 'setup video media must succeed').toBe(true)
  return mediaId
}

function videoLayerArgs(trackId: string, mediaId: string, t0: number, t1: number): string {
  return JSON.stringify({ track_id: trackId, media_id: mediaId, src_in_us: 0, src_out_us: t1 - t0, t_start_us: t0, t_end_us: t1 })
}

function totalLayerCount(actor: Actor): number {
  return actor.snapshot().tracks.reduce((n, t) => n + t.layers.length, 0)
}

// ── Issue 03/04: paired A/V placement ────────────────────────────────────────

describe('add_video_layer auto-pair — combined-row placement (issue 04)', () => {
  it('lands video + dialogue audio + group on the SAME track', () => {
    const a = freshActor()
    const media = addVideoWithAudio(a)
    const trackId = aRollId(a)
    const r = a.mcpCall('add_video_layer', videoLayerArgs(trackId, media, 0, 5_000_000))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ids = JSON.parse(r.result.content[0].text) as { video_layer_id: string; audio_layer_id: string; group_id: string }
    const track = a.snapshot().tracks.find((t) => t.id === trackId)!
    const video = track.layers.find((l) => l.id === ids.video_layer_id)
    const audio = track.layers.find((l) => l.id === ids.audio_layer_id)
    expect(video?.params.kind).toBe('VideoClip')
    expect(audio?.params.kind).toBe('Audio')
    expect(audio?.params.kind === 'Audio' && audio.params.role).toBe('dialogue')
    const group = a.snapshot().groups.find((g) => g.id === ids.group_id)
    expect(new Set(group?.members)).toEqual(new Set([ids.video_layer_id, ids.audio_layer_id]))
  })

  it('two clips at overlapping times on DIFFERENT tracks both succeed (the run2–4 failure)', () => {
    // Each pair's audio must stay on its own track: a shared audio lane makes
    // the second placement collide on a visually empty roll.
    const a = freshActor()
    const media = addVideoWithAudio(a)
    const r1 = a.mcpCall('add_video_layer', videoLayerArgs(aRollId(a), media, 0, 5_000_000))
    const r2 = a.mcpCall('add_video_layer', videoLayerArgs(bRollId(a), media, 1_000_000, 6_000_000))
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    const snap = a.snapshot()
    expect(snap.tracks[0].layers).toHaveLength(2) // video + paired audio, A roll
    expect(snap.tracks[1].layers).toHaveLength(2) // video + paired audio, B roll
  })
})

describe('add_video_layer auto-pair — atomicity (issue 03)', () => {
  it('rejects the WHOLE call when the audio lane is blocked: no video layer, no group, rich error', () => {
    const a = freshActor()
    const media = addVideoWithAudio(a)
    const trackId = aRollId(a)
    // Occupy the A roll AUDIO lane only — its visual lane stays free.
    const bare = a.dispatch('add_layer', { kind: 'audio', track: trackId, media, src_in_us: 0, src_out_us: 5_000_000, t_start_us: 0, t_end_us: 5_000_000 })
    expect(bare.ok).toBe(true)
    const before = totalLayerCount(a)

    const r = a.mcpCall('add_video_layer', videoLayerArgs(trackId, media, 0, 5_000_000))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    // The MESSAGE must carry cause + options — MCP clients drop error.data.
    expect(r.error.message).toContain('paired-audio overlap')
    expect(r.error.message).toContain('create_new_track')
    expect(r.error.message).toContain('Nothing was committed')
    const data = r.error.data as { collided: string; options: Array<{ action: string }> }
    expect(data.collided).toBe('paired_audio')
    expect(data.options.length).toBeGreaterThan(0)
    // Atomic: the half-committed video of the old three-commit path is gone.
    expect(totalLayerCount(a)).toBe(before)
    expect(a.snapshot().groups).toHaveLength(0)
  })

  it('video-lane overlap still reports the generic enriched LayerOverlap', () => {
    const a = freshActor()
    const media = addVideoWithAudio(a)
    const trackId = aRollId(a)
    const first = a.mcpCall('add_video_layer', videoLayerArgs(trackId, media, 0, 5_000_000))
    expect(first.ok).toBe(true)
    const before = totalLayerCount(a)
    const r = a.mcpCall('add_video_layer', videoLayerArgs(trackId, media, 1_000_000, 6_000_000))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    expect(r.error.message).toContain('layer overlap on track')
    expect(r.error.message).toContain('create_new_track')
    expect(totalLayerCount(a)).toBe(before)
  })
})

// ── Issue 02: update_effect must reject an unparseable patch ─────────────────

describe('update_effect — strict patch (issue 02)', () => {
  function actorWithEffect(): { a: Actor; layerId: string; effectId: string } {
    const a = freshActor()
    const add = a.mcpCall('add_color_layer', JSON.stringify({
      track_id: aRollId(a), color: { r: 0, g: 0, b: 0, a: 255 }, t_start_us: 0, t_end_us: 2_000_000,
    }))
    expect(add.ok).toBe(true)
    if (!add.ok) throw new Error('setup failed')
    const layerId = add.result.content[0].text
    const eff = a.mcpCall('add_effect', JSON.stringify({ layer_id: layerId, kind: 'blur' }))
    expect(eff.ok).toBe(true)
    if (!eff.ok) throw new Error('setup failed')
    return { a, layerId, effectId: eff.result.content[0].text }
  }

  function effectParams(a: Actor, layerId: string): Record<string, unknown> {
    const layer = a.snapshot().tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)!
    return layer.effects[0].params
  }

  it('a JSON-encoded STRING patch (what a string-coerced client sends) → invalid_params, effect unchanged', () => {
    const { a, layerId, effectId } = actorWithEffect()
    const r = a.mcpCall('update_effect', JSON.stringify({
      layer_id: layerId, effect_id: effectId,
      patch: JSON.stringify({ params: { strength: { mode: 'Static', value: 8 } } }), // string, not object
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('invalid_params')
    expect(r.error.message).toContain('JSON object')
    expect(effectParams(a, layerId)).toEqual({}) // committed NOTHING — and said so
  })

  it('an unknown patch key → invalid_params naming the key, effect unchanged', () => {
    const { a, layerId, effectId } = actorWithEffect()
    const r = a.mcpCall('update_effect', JSON.stringify({
      layer_id: layerId, effect_id: effectId, patch: { paramz: { strength: { mode: 'Static', value: 8 } } },
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toContain("unknown key 'paramz'")
    expect(effectParams(a, layerId)).toEqual({})
  })

  it('a malformed param value → invalid_params naming the param, effect unchanged', () => {
    const { a, layerId, effectId } = actorWithEffect()
    const r = a.mcpCall('update_effect', JSON.stringify({
      layer_id: layerId, effect_id: effectId, patch: { params: { strength: 8 } }, // bare number, not an AnimTrack
    }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toContain("params['strength']")
    expect(effectParams(a, layerId)).toEqual({})
  })

  it('a valid patch applies enabled + params', () => {
    const { a, layerId, effectId } = actorWithEffect()
    const r = a.mcpCall('update_effect', JSON.stringify({
      layer_id: layerId, effect_id: effectId,
      patch: { enabled: false, params: { strength: { mode: 'Static', value: 8 } } },
    }))
    expect(r.ok).toBe(true)
    const layer = a.snapshot().tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)!
    expect(layer.effects[0].enabled).toBe(false)
    expect(layer.effects[0].params.strength).toEqual({ mode: 'Static', value: 8 })
  })
})
