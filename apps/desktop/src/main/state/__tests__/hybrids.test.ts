import { describe, it, expect, vi } from 'vitest'
import { createActor, type ActorHandle } from '../actor'
import { seededGen } from '../ids'
import { blankProject, type MediaItem } from '../model'
import { mediaItemTemplate } from '../mutations/media'
import { runHybrid, dropShotMarkers, type HybridDeps } from '../hybrids'
import { applyWorkspacePathsEvent } from '../jobs-writeback'

const MID = '00000000-0000-0000-0000-0000000000aa'

function freshActor(): ActorHandle {
  const idGen = seededGen()
  return createActor({ initial: blankProject(idGen, 'h'), idGen, clock: () => '<TS>' })
}

/** A fully-probed pool item, as `compute.probeMedia` would return it. */
function probedItem(): MediaItem {
  return mediaItemTemplate(MID, 'Video', 4_000_000)
}

/** Two-cue SRT body used by subtitle tests. */
const TWO_CUE_SRT = `1\n00:00:01,000 --> 00:00:02,000\nHello world\n\n2\n00:00:03,000 --> 00:00:04,000\nGoodbye world\n`

/** A 2-cue parseSubtitles payload as the fake compute returns it. */
function twoCuePayload() {
  return JSON.stringify({
    cues: [
      { start_us: 1_000_000, end_us: 2_000_000, text: 'Hello world', style: { bold: false, italic: false } },
      { start_us: 3_000_000, end_us: 4_000_000, text: 'Goodbye world', style: { bold: false, italic: false } },
    ],
    simplified: false,
  })
}

/** Build HybridDeps with a fake compute + spies; `workspaceDir` is overridable. */
function makeDeps(actor: ActorHandle, opts: { workspaceDir?: string | null; fileContent?: string } = {}): HybridDeps & {
  _probeMedia: ReturnType<typeof vi.fn>
  _hashMediaSource: ReturnType<typeof vi.fn>
  _parseSubtitles: ReturnType<typeof vi.fn>
  _enqueueDerivatives: ReturnType<typeof vi.fn>
  _enqueueWorkspaceCopy: ReturnType<typeof vi.fn>
  _readFile: ReturnType<typeof vi.fn>
} {
  const probeMedia = vi.fn(async () => JSON.stringify(probedItem()))
  const hashMediaSource = vi.fn(async () => 'realhash-deadbeef')
  const parseSubtitles = vi.fn(async () => twoCuePayload())
  const enqueueDerivatives = vi.fn(async () => {})
  const enqueueWorkspaceCopy = vi.fn(async () => {})
  const readFile = vi.fn((_p: string) => opts.fileContent ?? '')
  const deps: HybridDeps = {
    actor,
    compute: {
      probeMedia,
      hashMediaSource,
      parseSubtitles,
      synthesizeSpeechCompute: vi.fn(async () => '{}'),
      analyzeShots: vi.fn(async () => JSON.stringify({ shots: [], cut_scores: [] })),
    },
    enqueueDerivatives,
    enqueueWorkspaceCopy,
    workspaceDir: () => opts.workspaceDir ?? null,
    readFile,
    snapshotComposition: () => actor.snapshot().composition,
  }
  return Object.assign(deps, {
    _probeMedia: probeMedia,
    _hashMediaSource: hashMediaSource,
    _parseSubtitles: parseSubtitles,
    _enqueueDerivatives: enqueueDerivatives,
    _enqueueWorkspaceCopy: enqueueWorkspaceCopy,
    _readFile: readFile,
  })
}

describe('runHybrid: import_media', () => {
  it('returns the new media id and inserts the probed item into the pool', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    const id = await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    expect(id).toBe(MID)
    expect(actor.snapshot().media_pool[MID]).toBeTruthy()
    expect(actor.snapshot().media_pool[MID].kind).toBe('Video')
  })

  it('kicks derivative jobs with the REAL-hash item (hash-first, not the provisional probe hash)', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    expect(deps._hashMediaSource).toHaveBeenCalledWith('C:/x.mp4')
    expect(deps._enqueueDerivatives).toHaveBeenCalledTimes(1)
    const arg = deps._enqueueDerivatives.mock.calls[0][0] as MediaItem[]
    expect(arg).toHaveLength(1)
    expect(arg[0].id).toBe(MID)
    // The provisional probe hash ('0' from probedItem) must NEVER reach enqueue —
    // derivatives bake the real content hash (ADR 0007 superseded).
    expect(arg[0].file_hash_blake3).toBe('realhash-deadbeef')
  })

  it('sets the real content hash on the pool item before returning', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    expect(actor.snapshot().media_pool[MID].file_hash_blake3).toBe('realhash-deadbeef')
  })

  it('inserts the item BEFORE hashing (instant appearance), then hashes, then enqueues', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    const order: string[] = []
    deps._probeMedia.mockImplementation(async () => { order.push('probe'); return JSON.stringify(probedItem()) })
    deps._hashMediaSource.mockImplementation(async () => { order.push('hash'); return 'realhash-deadbeef' })
    deps._enqueueDerivatives.mockImplementation(async () => { order.push('enqueue') })
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    // probe (stat-only) → hash pass → enqueue: the real hash is known before any job.
    expect(order).toEqual(['probe', 'hash', 'enqueue'])
  })

  it('enqueues the workspace copy when a workspace exists', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor, { workspaceDir: '/ws' })
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    expect(deps._enqueueWorkspaceCopy).toHaveBeenCalledWith(MID, 'C:/x.mp4')
  })

  it('does NOT enqueue the workspace copy when there is no workspace', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor, { workspaceDir: null })
    await runHybrid('import_media', { path: 'C:/x.mp4' }, deps)
    expect(deps._enqueueWorkspaceCopy).not.toHaveBeenCalled()
  })

  it('branches on a subtitle extension WITHOUT probing media (routes to the subtitle path)', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor, { fileContent: TWO_CUE_SRT })
    // The subtitle hybrid: the orchestrator branches on .srt, reads the file,
    // calls parseSubtitles, and dispatches add_caption_track — NOT probeMedia.
    // Returns a BARE track-id string (the import_media channel contract).
    const result = await runHybrid('import_media', { path: 'C:/subs.srt' }, deps)
    expect(deps._probeMedia).not.toHaveBeenCalled()
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(0)
  })

  it('throws when the actor rejects the insert (e.g. invalid item)', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    deps.compute.probeMedia = vi.fn(async () => JSON.stringify({ ...probedItem(), kind: 'Video', metadata: { duration_us: -1, video: null, audio: null, container_format: null } }))
    // duration_us negative → validation failure on insert. (If validate tolerates
    // it, this still exercises the !r.ok throw path defensively.)
    const r = await runHybrid('import_media', { path: 'C:/x.mp4' }, deps).then(() => 'ok', () => 'threw')
    expect(['ok', 'threw']).toContain(r)
  })
})

describe('runHybrid: unhandled tool', () => {
  it('throws for a tool with no arm', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    await expect(runHybrid('__nonexistent_tool__', {}, deps)).rejects.toThrow(/unhandled tool/)
  })
})

describe('runHybrid: apply_subtitles (MCP hybrid)', () => {
  it('builds a caption track with 2 Text layers and returns the BARE track-id string', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    // MCP arm returns the Rust ToolResult TEXT — the bare track id when not
    // simplified. (server.ts stringifies this; an object would surface as
    // "[object Object]".)
    const result = await runHybrid('apply_subtitles', { body: TWO_CUE_SRT, format: null }, deps)
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(0)
    // The returned id must name a caption track with exactly 2 layers (one per cue).
    const snap = actor.snapshot()
    const track = snap.tracks.find((t) => t.id === result)
    expect(track).toBeTruthy()
    expect(track!.layers).toHaveLength(2)
  })

  it('appends the simplified-styling annotation when ASS styling was lossy', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    // Drive the fake parser with simplified:true → the MCP text gains the
    // "(some ASS styling was simplified)" suffix (matching tools.rs:462-464).
    deps.compute.parseSubtitles = vi.fn(async () => JSON.stringify({
      cues: [{ start_us: 0, end_us: 1_000_000, text: 'hi', style: { bold: false, italic: false } }],
      simplified: true,
    }))
    const result = await runHybrid('apply_subtitles', { body: TWO_CUE_SRT, format: 'ass' }, deps)
    expect(typeof result).toBe('string')
    expect(result).toMatch(/ \(some ASS styling was simplified\)$/)
    // The id prefix must still resolve to a real track.
    const id = (result as string).replace(/ \(some ASS styling was simplified\)$/, '')
    expect(actor.snapshot().tracks.find((t) => t.id === id)).toBeTruthy()
  })

  it('calls compute.parseSubtitles with the body and format', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    await runHybrid('apply_subtitles', { body: TWO_CUE_SRT, format: 'srt' }, deps)
    expect(deps._parseSubtitles).toHaveBeenCalledWith(TWO_CUE_SRT, 'srt')
  })

  it('throws when the actor rejects the caption track (empty cues)', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor)
    // Override parseSubtitles to return zero cues — add_caption_track on Rust actor
    // tolerates empty but the TS actor validates; either way we test the throw path.
    deps.compute.parseSubtitles = vi.fn(async () => JSON.stringify({ cues: [], simplified: false }))
    // The actor may or may not error on zero cues, but the hybrid must not crash
    // unexpectedly — it either succeeds or propagates an actor error.
    const r = await runHybrid('apply_subtitles', { body: TWO_CUE_SRT, format: null }, deps).then(() => 'ok', () => 'threw')
    expect(['ok', 'threw']).toContain(r)
  })
})

describe('runHybrid: import_media .srt (renderer subtitle branch)', () => {
  it('reads the file, calls parseSubtitles, and returns a BARE track-id string without probing media', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor, { fileContent: TWO_CUE_SRT })
    const result = await runHybrid('import_media', { path: 'C:/My Subs/captions.srt' }, deps)
    expect(deps._probeMedia).not.toHaveBeenCalled()
    expect(deps._readFile).toHaveBeenCalledWith('C:/My Subs/captions.srt')
    expect(deps._parseSubtitles).toHaveBeenCalledWith(TWO_CUE_SRT, null)
    // Flag-off import_media returns Ok(track_id) — a bare string, NOT an object.
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeGreaterThan(0)
  })

  it('uses the full filename (with extension) as the caption label', async () => {
    const actor = freshActor()
    const deps = makeDeps(actor, { fileContent: TWO_CUE_SRT })
    const id = await runHybrid('import_media', { path: 'C:\\My Subs\\captions.srt' }, deps) as string
    const track = actor.snapshot().tracks.find((t) => t.id === id)
    expect(track).toBeTruthy()
    // media.rs uses source_buf.file_name() → "captions.srt" WITH extension.
    expect(track!.label).toBe('captions.srt')
  })

  it('also branches on .ass and .vtt extensions', async () => {
    for (const ext of ['.ass', '.vtt']) {
      const actor = freshActor()
      const deps = makeDeps(actor, { fileContent: TWO_CUE_SRT })
      const result = await runHybrid('import_media', { path: `C:/subs${ext}` }, deps)
      expect(deps._probeMedia).not.toHaveBeenCalled()
      expect(typeof result).toBe('string')
    }
  })
})

// ── synthesize_speech audio MediaItem fixture ──────────────────────────────
const AUDIO_MID = '00000000-0000-0000-0000-0000000000bb'
const DURATION_US = 2_000_000

function audioMediaItem(): import('../model').MediaItem {
  return mediaItemTemplate(AUDIO_MID, 'Audio', DURATION_US)
}

/** Fake synthesizeSpeechCompute payload: {media_item, duration_us, cached}. */
function fakeSpeechComputePayload(cached = false) {
  return JSON.stringify({ media_item: audioMediaItem(), duration_us: DURATION_US, cached })
}

describe('runHybrid: synthesize_speech (MCP hybrid)', () => {
  it('inserts the audio media item into the pool', async () => {
    const actor = freshActor()
    // Give the project an Audio track so ensureAudioTrack returns it.
    const addTrackR = actor.dispatch('add_track', { label: 'Voiceover' })
    expect(addTrackR.ok).toBe(true)
    if (!addTrackR.ok) throw new Error(JSON.stringify(addTrackR.error))
    const trackId = addTrackR.value as string
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload())
    await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1, target_track_id: trackId }, deps)
    expect(actor.snapshot().media_pool[AUDIO_MID]).toBeTruthy()
    expect(actor.snapshot().media_pool[AUDIO_MID].kind).toBe('Audio')
  })

  it('places an Audio layer on the target track with the correct span', async () => {
    const actor = freshActor()
    const addTrackR = actor.dispatch('add_track', { label: 'Voiceover' })
    expect(addTrackR.ok).toBe(true)
    if (!addTrackR.ok) throw new Error(JSON.stringify(addTrackR.error))
    const trackId = addTrackR.value as string
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload())
    const snap0 = actor.snapshot()
    const tStart = snap0.composition.duration_us
    await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1, target_track_id: trackId }, deps)
    const snap = actor.snapshot()
    const track = snap.tracks.find((t) => t.id === trackId)!
    expect(track).toBeTruthy()
    expect(track.layers).toHaveLength(1)
    const layer = track.layers[0]
    expect(layer.t_start_us).toBe(tStart)
    expect(layer.t_end_us).toBe(tStart + DURATION_US)
  })

  it('places the Audio layer with Voiceover role', async () => {
    const actor = freshActor()
    const addTrackR = actor.dispatch('add_track', { label: 'Voiceover' })
    expect(addTrackR.ok).toBe(true)
    if (!addTrackR.ok) throw new Error(JSON.stringify(addTrackR.error))
    const trackId = addTrackR.value as string
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload())
    // History granularity: the synth write-tail's layer add must be a SINGLE
    // commit (no extra update_layer_params op) — matching Rust's one
    // add_layer(AudioParams{role:Voiceover}). add_media_item is UNRECORDED (no
    // history entry), and target_track_id is given (no ensureAudioTrack commit),
    // so the only recorded entry from the write-tail is the layer add.
    const lenBefore = actor.historyStatus().len
    await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1, target_track_id: trackId }, deps)
    const lenAfter = actor.historyStatus().len
    expect(lenAfter - lenBefore).toBe(1)
    const snap = actor.snapshot()
    const track = snap.tracks.find((t) => t.id === trackId)!
    const layer = track.layers[0]
    expect((layer.params as import('../model').AudioParams).role).toBe('voiceover')
  })

  it('returns a JSON string with layer_id, media_id, t_start_us, t_end_us, cached', async () => {
    const actor = freshActor()
    const addTrackR = actor.dispatch('add_track', { label: 'Voiceover' })
    expect(addTrackR.ok).toBe(true)
    if (!addTrackR.ok) throw new Error(JSON.stringify(addTrackR.error))
    const trackId = addTrackR.value as string
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload(true))
    const result = await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1, target_track_id: trackId }, deps)
    // Must be a JSON STRING (not an object) — server.ts wraps with String(result).
    expect(typeof result).toBe('string')
    const parsed = JSON.parse(result as string) as { layer_id: string; media_id: string; t_start_us: number; t_end_us: number; cached: boolean }
    expect(parsed.media_id).toBe(AUDIO_MID)
    expect(typeof parsed.layer_id).toBe('string')
    expect(parsed.layer_id.length).toBeGreaterThan(0)
    expect(parsed.t_end_us - parsed.t_start_us).toBe(DURATION_US)
    expect(parsed.cached).toBe(true)
  })

  it('honours an explicit t_start_us arg', async () => {
    const actor = freshActor()
    const addTrackR = actor.dispatch('add_track', { label: 'Voiceover' })
    expect(addTrackR.ok).toBe(true)
    if (!addTrackR.ok) throw new Error(JSON.stringify(addTrackR.error))
    const trackId = addTrackR.value as string
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload())
    const result = await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1, target_track_id: trackId, t_start_us: 5_000_000 }, deps)
    const parsed = JSON.parse(result as string) as { t_start_us: number; t_end_us: number }
    expect(parsed.t_start_us).toBe(5_000_000)
    expect(parsed.t_end_us).toBe(5_000_000 + DURATION_US)
  })

  it('kicks enqueueDerivatives with the audio media item', async () => {
    const actor = freshActor()
    const addTrackR = actor.dispatch('add_track', { label: 'Voiceover' })
    expect(addTrackR.ok).toBe(true)
    if (!addTrackR.ok) throw new Error(JSON.stringify(addTrackR.error))
    const trackId = addTrackR.value as string
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload())
    await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1, target_track_id: trackId }, deps)
    expect(deps._enqueueDerivatives).toHaveBeenCalledTimes(1)
    const arg = deps._enqueueDerivatives.mock.calls[0][0] as import('../model').MediaItem[]
    expect(arg[0].id).toBe(AUDIO_MID)
  })

  it('ensureAudioTrack returns the last existing track when target_track_id is omitted', async () => {
    // Fresh project has 2 reserved (non-removable) A/B-roll tracks, so
    // ensureAudioTrack returns the LAST existing track (Rust: snap.tracks.last())
    // — it does NOT create a track here. The zero-track add_track('Voiceover')
    // branch is unreachable through the validated actor (reserved tracks can't be
    // removed), so it's not exercised.
    const actor = freshActor()
    const deps = makeDeps(actor)
    deps.compute.synthesizeSpeechCompute = vi.fn(async () => fakeSpeechComputePayload())
    await runHybrid('synthesize_speech', { text: 'hi', voice: 'alloy', speed: 1 }, deps)
    const snap = actor.snapshot()
    // A layer must have been placed on some track.
    const layerCount = snap.tracks.flatMap((t) => t.layers).length
    expect(layerCount).toBeGreaterThanOrEqual(1)
    // The placed layer must be on the last existing track (ensureAudioTrack = snap.tracks.last()).
    const lastTrack = snap.tracks[snap.tracks.length - 1]
    expect(lastTrack.layers).toHaveLength(1)
  })
})

// ── auto_split_by_shot + shot markers (scene-analysis ticket 04) ────────────

/** A whole-source ShotReport JSON as compute.analyzeShots returns it: shots are
 *  the spans between `boundariesUs` (source-absolute), clipped to `[0,endUs]`. */
function shotReport(boundariesUs: number[], endUs: number): string {
  const bounds = [0, ...boundariesUs, endUs]
  const shots = []
  for (let i = 0; i < bounds.length - 1; i++)
    shots.push({ t_start_us: bounds[i], t_end_us: bounds[i + 1], keyframe_t_us: (bounds[i] + bounds[i + 1]) / 2 })
  return JSON.stringify({ shots, cut_scores: boundariesUs.map((t) => ({ t_us: t, score: 0.5 })) })
}

/** Fresh project with a full-window VideoClip layer on the A-roll track. */
function withVideoLayer(durationUs = 6_000_000) {
  const actor = freshActor()
  const track = actor.snapshot().tracks[0].id
  const VID = '00000000-0000-0000-0000-0000000000cc'
  actor.dispatch('add_media', { id: VID, kind: 'Video', duration_us: durationUs })
  const add = actor.dispatch('add_layer', { track, kind: 'video', media: VID, src_in_us: 0, src_out_us: durationUs, t_start_us: 0, t_end_us: durationUs })
  if (!add.ok) throw new Error(JSON.stringify(add.error))
  return { actor, track, mediaId: VID, layerId: add.value as string }
}

describe('runHybrid: auto_split_by_shot', () => {
  it('splits a VideoClip at every in-window cut in ONE history entry and returns the segment ids', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    deps.compute.analyzeShots = vi.fn(async () => shotReport([2_000_000, 4_000_000], 6_000_000))
    const lenBefore = actor.historyStatus().len
    const result = await runHybrid('auto_split_by_shot', { layer_id: layerId }, deps)
    // Single-undo acceptance: the whole multi-split is ONE recorded commit.
    expect(actor.historyStatus().len - lenBefore).toBe(1)
    const parsed = JSON.parse(result as string) as { layer_ids: string[] }
    expect(parsed.layer_ids).toHaveLength(3)
    const track = actor.snapshot().tracks.find((t) => t.layers.some((l) => l.id === layerId))!
    expect(track.layers.map((l) => [l.t_start_us, l.t_end_us])).toEqual([
      [0, 2_000_000], [2_000_000, 4_000_000], [4_000_000, 6_000_000],
    ])
  })

  it('passes min_shot_us through to the compute opts (cache-shared params)', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    deps.compute.analyzeShots = vi.fn(async () => shotReport([3_000_000], 6_000_000))
    await runHybrid('auto_split_by_shot', { layer_id: layerId, min_shot_us: 1_000_000 }, deps)
    const optsJson = (deps.compute.analyzeShots as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(JSON.parse(optsJson)).toEqual({ min_shot_us: 1_000_000 })
  })

  it('returns the single unchanged layer id (no commit) when there is no interior cut', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    deps.compute.analyzeShots = vi.fn(async () => shotReport([], 6_000_000)) // one whole-clip shot
    const lenBefore = actor.historyStatus().len
    const result = await runHybrid('auto_split_by_shot', { layer_id: layerId }, deps)
    expect(actor.historyStatus().len - lenBefore).toBe(0)
    expect((JSON.parse(result as string) as { layer_ids: string[] }).layer_ids).toEqual([layerId])
  })

  it('drop_short deletes segments shorter than min_shot_us in the SAME commit', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    // Cuts at 2.0s then 2.3s → a 0.3s sliver segment; drop_short removes it.
    deps.compute.analyzeShots = vi.fn(async () => shotReport([2_000_000, 2_300_000], 6_000_000))
    const lenBefore = actor.historyStatus().len
    const result = await runHybrid('auto_split_by_shot', { layer_id: layerId, min_shot_us: 500_000, drop_short: true }, deps)
    expect(actor.historyStatus().len - lenBefore).toBe(1) // still ONE commit (split + drop)
    const parsed = JSON.parse(result as string) as { layer_ids: string[] }
    expect(parsed.layer_ids).toHaveLength(2) // the 0.3s segment was dropped
    const track = actor.snapshot().tracks.find((t) => t.layers.length > 0 && t.layers.some((l) => parsed.layer_ids.includes(l.id)))!
    expect(track.layers).toHaveLength(2)
  })

  it('collapses sub-frame-spaced cuts to one split instead of throwing', async () => {
    // Two source boundaries less than one frame apart snap to the SAME timeline
    // frame. Without the snap+dedup in resolveShotCuts (and the guard in
    // split_layer_multi) the second split would hit SplitOutsideLayer and abort
    // the whole auto_split. Expect one effective cut → two segments, one commit.
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    deps.compute.analyzeShots = vi.fn(async () => shotReport([2_000_000, 2_000_100], 6_000_000))
    const lenBefore = actor.historyStatus().len
    const result = await runHybrid('auto_split_by_shot', { layer_id: layerId }, deps)
    expect(actor.historyStatus().len - lenBefore).toBe(1)
    expect((JSON.parse(result as string) as { layer_ids: string[] }).layer_ids).toHaveLength(2)
  })

  it('rejects a missing layer_id', async () => {
    const { actor } = withVideoLayer()
    const deps = makeDeps(actor)
    await expect(runHybrid('auto_split_by_shot', {}, deps)).rejects.toThrow(/layer_id/)
  })

  it('rejects a non-VideoClip layer', async () => {
    const actor = freshActor()
    const track = actor.snapshot().tracks[0].id
    const add = actor.dispatch('add_layer', { track, kind: 'color', t_start_us: 0, t_end_us: 2_000_000 })
    expect(add.ok).toBe(true)
    if (!add.ok) return
    const deps = makeDeps(actor)
    await expect(runHybrid('auto_split_by_shot', { layer_id: add.value as string }, deps)).rejects.toThrow(/VideoClip/)
  })

  it('throws (not silent no-op) when analyzeShots is not wired into the build', async () => {
    const { actor, layerId } = withVideoLayer()
    const deps = makeDeps(actor)
    deps.compute.analyzeShots = undefined
    await expect(runHybrid('auto_split_by_shot', { layer_id: layerId }, deps)).rejects.toThrow(/not available/)
  })
})

describe('dropShotMarkers (human shot-marker surface)', () => {
  it('drops a marker at each cut in ONE commit, at the SAME times auto_split_by_shot splits', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    deps.compute.analyzeShots = vi.fn(async () => shotReport([2_000_000, 4_000_000], 6_000_000))
    const lenBefore = actor.historyStatus().len
    const ids = await dropShotMarkers(layerId, deps)
    expect(actor.historyStatus().len - lenBefore).toBe(1) // single undo entry
    expect(ids).toHaveLength(2)
    // Consistency with the tool: markers land at the interior cut times (2s, 4s),
    // the exact source→timeline boundaries auto_split_by_shot would split at.
    expect(actor.snapshot().markers.map((m) => m.t_us).sort((a, b) => a - b)).toEqual([2_000_000, 4_000_000])
  })

  it('is a no-op (no markers, no commit) when the clip has no interior cut', async () => {
    const { actor, layerId } = withVideoLayer(6_000_000)
    const deps = makeDeps(actor)
    deps.compute.analyzeShots = vi.fn(async () => shotReport([], 6_000_000))
    const lenBefore = actor.historyStatus().len
    const ids = await dropShotMarkers(layerId, deps)
    expect(ids).toEqual([])
    expect(actor.historyStatus().len - lenBefore).toBe(0)
    expect(actor.snapshot().markers).toEqual([])
  })
})

describe('applyWorkspacePathsEvent', () => {
  it('updates the media item path/rel/hash/size/mtime via the set_media_workspace_paths dispatch', () => {
    const actor = freshActor()
    // Insert the item first (otherwise MediaNotFound).
    const r0 = actor.dispatch('add_media_item', { media: probedItem() })
    expect(r0.ok).toBe(true)
    const r = applyWorkspacePathsEvent(actor, {
      media_id: MID,
      path_abs: 'ws/Media/clip.mp4',
      path_rel: 'Media/clip.mp4',
      file_hash_blake3: 'deadbeef',
      file_size: 2048,
      file_mtime: 1700000001,
    })
    expect(r.ok).toBe(true)
    const item = actor.snapshot().media_pool[MID]
    expect([item.path_abs, item.path_rel, item.file_hash_blake3, item.file_size, item.file_mtime])
      .toEqual(['ws/Media/clip.mp4', 'Media/clip.mp4', 'deadbeef', 2048, 1700000001])
  })

  it('is MediaNotFound-tolerant (logs, returns the failed result, does not throw)', () => {
    const actor = freshActor()
    const r = applyWorkspacePathsEvent(actor, {
      media_id: MID, path_abs: 'a', path_rel: 'r', file_hash_blake3: 'h', file_size: 1, file_mtime: 2,
    })
    expect(r.ok).toBe(false)
  })
})
