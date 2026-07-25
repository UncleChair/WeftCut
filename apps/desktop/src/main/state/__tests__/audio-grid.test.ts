// Ticket 10's acceptance: audio geometry lives on the fixed 48 kHz mix lattice while
// visual geometry stays on the composition frame grid, and the ONE
// `gridForLayerKind` lookup is honoured at all three enforcement sites.
//
// Both DATA-LOSS dependencies are covered here WITH NEGATIVE CONTROLS, because the
// failure mode they guard is silent: a kind-blind snap does not error, it just quietly
// moves the user's audio. A passing assertion means nothing unless the kind-blind
// version of the same code demonstrably fails it — so each control re-implements the
// pre-fix behaviour inline and asserts it produces the wrong answer.
import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Project } from '../model'
import { createActor } from '../actor'
import { parseProject, serializeProject, type GridRepair } from '../serialize'
import { serializeProjectToJson } from '../persistence'
import { AUDIO_GRID, frameGrid, gridIndex, snapFrameRound, timeUsAtGridIndex } from '../snap'

// 29.97 is the discriminating rate: 48000 * 1001/30000 = 1601.6 samples per frame, so
// the frame lattice is NOT a sublattice of the 48 kHz one and each grid rejects the
// other's boundaries. At 24/25/30/50/60 and 23.976 the ratio IS an integer
// (2000/1920/1600/960/800/2002), so the two coincide and no test there can tell a
// kind-blind snap from a correct one — which is exactly why round 1 shipped without
// noticing the gap.
const FPS = { num: 30_000, den: 1001 }
const AUDIO_MEDIA = 'audio-grid-media'
const VIDEO_MEDIA = 'audio-grid-video'

/** Canonical µs of sample index `i` — the mixer's own lattice. */
const sample = (i: number) => timeUsAtGridIndex(i, AUDIO_GRID)
/** Canonical µs of composition frame `i` at 29.97. */
const frame = (i: number) => timeUsAtGridIndex(i, frameGrid(FPS))
/** One sample's width in µs (~20.83, so 20 or 21 depending on the pair). */
const sampleSpanUs = (i: number) => sample(i + 1) - sample(i)

/** The first frame index at or after `from` whose canonical µs is NOT a sample
 *  boundary. LANDMINE for anyone hand-picking fixture times: at 29.97 one frame is
 *  1601.6 samples, so every FIFTH frame lands exactly on the 48 kHz lattice
 *  (1601.6 × 5 = 8008). A round multiple of 5 — frame 30, frame 90 — would make every
 *  "the two grids differ" assertion below silently vacuous. Derived, not assumed. */
function offSampleFrame(from: number): number {
  for (let i = from; i < from + 16; i++) {
    if (snapFrameRound(frame(i), AUDIO_GRID.num, AUDIO_GRID.den) !== frame(i)) return i
  }
  throw new Error('no frame off the sample lattice — the fixture rate is not discriminating')
}
// Resolved lazily: every grid primitive is wasm-backed and `initEval()` runs in the
// suite's beforeAll, so a module-level call would fire before the wasm exists.
let vStart = 0
let vMove = 0
const V_START_FRAME = () => (vStart ||= offSampleFrame(30))
const V_MOVE_FRAME = () => (vMove ||= offSampleFrame(90))

interface Fixture {
  actor: ReturnType<typeof createActor>
  videoLayer: string
  audioLayer: string
  videoTrack: string
  audioTrack: string
}

/** A grouped A/V pair on separate tracks, both REQUESTED at the same time — which
 *  each resolves on its own lattice, so at 29.97 they start ~8 µs apart (that is where
 *  the mixer would have played the audio anyway). */
function pairedFixture(): Fixture {
  const idGen = seededGen()
  const initial = blankProject(idGen, 'audio-grid')
  initial.composition.fps = FPS
  const actor = createActor({ initial, idGen, clock: () => '<TS>' })
  actor.dispatch('add_media', { id: VIDEO_MEDIA, kind: 'Video', duration_us: 10_000_000, with_audio: false })
  actor.dispatch('add_media', { id: AUDIO_MEDIA, kind: 'Audio', duration_us: 10_000_000, with_audio: true })
  const [videoTrack, audioTrack] = actor.snapshot().tracks.map((t) => t.id)
  const at = frame(V_START_FRAME())
  const v = actor.dispatch('add_layer', { track: videoTrack, kind: 'video', media: VIDEO_MEDIA, src_in_us: 0, src_out_us: 2_000_000, t_start_us: at, t_end_us: at + 2_000_000 })
  const a = actor.dispatch('add_layer', { track: audioTrack, kind: 'audio', media: AUDIO_MEDIA, src_in_us: 0, src_out_us: 2_000_000, t_start_us: at, t_end_us: at + 2_000_000 })
  expect([v.ok, a.ok]).toEqual([true, true])
  const videoLayer = v.ok ? (v.value as string) : ''
  const audioLayer = a.ok ? (a.value as string) : ''
  expect(actor.dispatch('groups_create', { layers: [videoLayer, audioLayer], label: null, reassign: false }).ok).toBe(true)
  return { actor, videoLayer, audioLayer, videoTrack, audioTrack }
}

const findLayer = (p: Project, id: string) => p.tracks.flatMap((t) => t.layers).find((l) => l.id === id)!

describe('audio grid — the 48 kHz mix lattice', () => {
  it('the authoring index IS the mixer sample index (leaf twin, not a parallel implementation)', () => {
    // `gridIndex(us, AUDIO_GRID)` is `frame_index_round(us, 48000, 1)`, and the mixer
    // uses `us_to_frame(us, 48000)`. Both reduce to `(us*48000 + 500000)/1000000` in
    // the leaf, so a one-sample nudge is exactly one mix sample rather than
    // approximately one. Guarded here so a future "shortcut" cannot drift them apart
    // the way `snapFrameFloor` once did.
    for (const us of [0, 1, 17, 20_833, 33_367, 1_000_000, 3_600_000_000]) {
      expect(gridIndex(us, AUDIO_GRID)).toBe(Math.floor((us * 48 + 500) / 1000))
    }
    // And the inverse is distinct + invertible at ~20.83 µs spacing, so µs storage
    // represents the lattice exactly (spec R2-D6).
    for (let i = 0; i < 1000; i++) {
      expect(gridIndex(sample(i), AUDIO_GRID)).toBe(i)
      if (i > 0) expect(sample(i)).toBeGreaterThan(sample(i - 1))
    }
  })

  it('at 29.97 the two lattices genuinely differ (else every assertion below is vacuous)', () => {
    expect(snapFrameRound(frame(1), AUDIO_GRID.num, AUDIO_GRID.den)).not.toBe(frame(1))
    expect(snapFrameRound(sample(1602), FPS.num, FPS.den)).not.toBe(sample(1602))
  })

  // ── Acceptance 1: both assertions in one test ────────────────────────────────
  it('an audio layer trims and moves to any sample boundary; a visual layer cannot leave the frame grid', () => {
    const { actor, videoLayer, audioLayer, audioTrack } = pairedFixture()

    // Audio MOVE to a sample boundary that is not a frame boundary.
    const target = sample(gridIndex(frame(V_START_FRAME()), AUDIO_GRID) + 7)
    expect(actor.dispatch('move_layer', { layer: audioLayer, to_track: audioTrack, t_start_us: target, escape_group: true }).ok).toBe(true)
    expect(findLayer(actor.snapshot(), audioLayer).t_start_us).toBe(target)

    // Audio TRIM to a sample boundary — one sample, the minimum audio duration.
    const outEdge = findLayer(actor.snapshot(), audioLayer).t_end_us
    const trimTo = sample(gridIndex(outEdge, AUDIO_GRID) - 1)
    expect(actor.dispatch('trim_layer', { layer: audioLayer, edge: 'out', new_t_us: trimTo, escape_group: true }).ok).toBe(true)
    expect(findLayer(actor.snapshot(), audioLayer).t_end_us).toBe(trimTo)

    // The VISUAL layer asked for the same sub-frame time snaps back to its frame
    // grid — the request is honoured to the nearest frame, never persisted raw.
    const videoTarget = sample(gridIndex(frame(60), AUDIO_GRID) + 7)
    expect(videoTarget).not.toBe(snapFrameRound(videoTarget, FPS.num, FPS.den))
    expect(actor.dispatch('move_layer', { layer: videoLayer, to_track: actor.snapshot().tracks[0].id, t_start_us: videoTarget, escape_group: true }).ok).toBe(true)
    const movedVideo = findLayer(actor.snapshot(), videoLayer)
    expect(movedVideo.t_start_us).toBe(snapFrameRound(videoTarget, FPS.num, FPS.den))
    expect(movedVideo.t_start_us).not.toBe(videoTarget)
  })

  // ── Acceptance 2 + data-loss dependency #1: move.ts's group fan-out ──────────
  it('a whole-group move preserves a slipped audio offset EXACTLY (sample index shifts by the delta)', () => {
    const { actor, videoLayer, audioLayer, audioTrack, videoTrack } = pairedFixture()

    // Slip the audio 7 samples late, escaping the group so only it moves.
    const slipped = sample(gridIndex(frame(V_START_FRAME()), AUDIO_GRID) + 7)
    expect(actor.dispatch('move_layer', { layer: audioLayer, to_track: audioTrack, t_start_us: slipped, escape_group: true }).ok).toBe(true)
    const before = actor.snapshot()
    const offsetBefore = findLayer(before, audioLayer).t_start_us - findLayer(before, videoLayer).t_start_us
    const audioIndexBefore = gridIndex(findLayer(before, audioLayer).t_start_us, AUDIO_GRID)
    expect(offsetBefore).not.toBe(0)

    // Now move the WHOLE group by dragging the video member.
    const newVideoStart = frame(V_MOVE_FRAME())
    expect(actor.dispatch('move_layer', { layer: videoLayer, to_track: videoTrack, t_start_us: newVideoStart, escape_group: false }).ok).toBe(true)
    const after = actor.snapshot()
    const videoDelta = findLayer(after, videoLayer).t_start_us - findLayer(before, videoLayer).t_start_us

    // The audio's SAMPLE INDEX moved by the delta expressed in samples — not by a
    // re-snap onto the video frame grid. That is what keeps the offset intact.
    const audioIndexAfter = gridIndex(findLayer(after, audioLayer).t_start_us, AUDIO_GRID)
    expect(audioIndexAfter - audioIndexBefore).toBe(
      gridIndex(findLayer(before, audioLayer).t_start_us + videoDelta, AUDIO_GRID) - audioIndexBefore,
    )
    expect(findLayer(after, audioLayer).t_start_us).toBe(
      snapFrameRound(findLayer(before, audioLayer).t_start_us + videoDelta, AUDIO_GRID.num, AUDIO_GRID.den),
    )
    // …and the slip survives the move at sample precision.
    const offsetAfter = findLayer(after, audioLayer).t_start_us - findLayer(after, videoLayer).t_start_us
    expect(Math.abs(offsetAfter - offsetBefore)).toBeLessThanOrEqual(sampleSpanUs(0))
    expect(gridIndex(offsetAfter, AUDIO_GRID)).toBe(gridIndex(offsetBefore, AUDIO_GRID))
  })

  it('NEGATIVE CONTROL: the kind-blind fan-out destroys the slip', () => {
    // The pre-fix `move.ts:50-51`, verbatim: snap every group sibling on the
    // COMPOSITION grid. Applied to the same slipped state, it must fail the
    // assertion above — proving that test discriminates rather than passing by luck.
    const { actor, videoLayer, audioLayer, audioTrack } = pairedFixture()
    const slipped = sample(gridIndex(frame(V_START_FRAME()), AUDIO_GRID) + 7)
    expect(actor.dispatch('move_layer', { layer: audioLayer, to_track: audioTrack, t_start_us: slipped, escape_group: true }).ok).toBe(true)
    const before = actor.snapshot()
    const audioStart = findLayer(before, audioLayer).t_start_us
    const offsetBefore = audioStart - findLayer(before, videoLayer).t_start_us
    const delta = frame(V_MOVE_FRAME()) - findLayer(before, videoLayer).t_start_us

    const kindBlind = snapFrameRound(audioStart + delta, FPS.num, FPS.den)
    const kindAware = snapFrameRound(audioStart + delta, AUDIO_GRID.num, AUDIO_GRID.den)
    expect(kindBlind).not.toBe(kindAware)
    // The offset the user authored is gone: the audio lands exactly on the video's
    // new frame, silently re-syncing it.
    expect(kindBlind).toBe(frame(V_MOVE_FRAME()))
    expect(offsetBefore).not.toBe(0)
    // …and the result is not even legal any more — validate's audio arm would reject
    // it, so the kind-blind fan-out cannot even be "wrong but harmless".
    expect(snapFrameRound(kindBlind, AUDIO_GRID.num, AUDIO_GRID.den)).not.toBe(kindBlind)
  })

  // ── Acceptance 3 + data-loss dependency #2: serialize.ts's repairGrid ────────
  it('a project with sample-aligned audio reopens with ZERO repairs and byte-identical geometry', () => {
    const { actor, audioLayer, audioTrack } = pairedFixture()
    const slipped = sample(gridIndex(frame(V_START_FRAME()), AUDIO_GRID) + 7)
    expect(actor.dispatch('move_layer', { layer: audioLayer, to_track: audioTrack, t_start_us: slipped, escape_group: true }).ok).toBe(true)

    const saved = serializeProjectToJson(actor.snapshot())
    const reported: GridRepair[][] = []
    const reopened = parseProject(JSON.parse(saved), { onGridRepair: (r) => reported.push([...r]) })
    expect(reported).toEqual([]) // the repair must be a no-op, not a "successful" move
    expect(JSON.stringify(serializeProject(reopened))).toBe(JSON.stringify(JSON.parse(saved)))
    expect(findLayer(reopened, audioLayer).t_start_us).toBe(slipped)
  })

  it('NEGATIVE CONTROL: the kind-blind load repair moves the audio on every open', () => {
    // The pre-fix `repairGrid`, verbatim: snap EVERY layer endpoint on the
    // composition frame grid regardless of kind. Because it runs on load, the damage
    // compounds silently — open, save, open again and the slip is simply gone.
    const { actor, audioLayer, audioTrack } = pairedFixture()
    const slipped = sample(gridIndex(frame(V_START_FRAME()), AUDIO_GRID) + 7)
    expect(actor.dispatch('move_layer', { layer: audioLayer, to_track: audioTrack, t_start_us: slipped, escape_group: true }).ok).toBe(true)
    const wire = JSON.parse(serializeProjectToJson(actor.snapshot())) as {
      composition: { fps: { num: number; den: number } }
      tracks: Array<{ layers: Array<{ id: string; t_start_us: number; t_end_us: number }> }>
    }

    const moved: string[] = []
    for (const track of wire.tracks) {
      for (const l of track.layers) {
        const snappedStart = snapFrameRound(l.t_start_us, wire.composition.fps.num, wire.composition.fps.den)
        if (snappedStart !== l.t_start_us) moved.push(l.id)
      }
    }
    expect(moved).toContain(audioLayer) // the kind-blind pass DOES report a repair here
    // The current, kind-keyed pass reports nothing for the same project (asserted in
    // the test above) — that difference is the whole fix.
  })

  it('a legacy frame-aligned audio layer IS repaired onto the sample lattice on load (repair, never reject)', () => {
    // The other direction of D4: projects written before this ticket hold audio on
    // frame boundaries, which at 29.97 are not sample boundaries. They must OPEN —
    // repaired by ≤ half a sample (~10 µs, inaudible) — not be rejected.
    const { actor, audioLayer } = pairedFixture()
    const wire = JSON.parse(serializeProjectToJson(actor.snapshot())) as Record<string, unknown> & {
      tracks: Array<{ layers: Array<Record<string, unknown>> }>
    }
    for (const track of wire.tracks) {
      for (const l of track.layers) {
        if (l.id !== audioLayer) continue
        l.t_start_us = frame(V_START_FRAME()) // legacy: frame-aligned audio
        l.t_end_us = frame(V_MOVE_FRAME())
      }
    }
    const reported: GridRepair[][] = []
    const reopened = parseProject(wire, { onGridRepair: (r) => reported.push([...r]) })
    const audio = findLayer(reopened, audioLayer)
    expect(reported.length).toBe(1)
    expect(audio.t_start_us).toBe(snapFrameRound(frame(V_START_FRAME()), AUDIO_GRID.num, AUDIO_GRID.den))
    expect(Math.abs(audio.t_start_us - frame(V_START_FRAME()))).toBeLessThan(sampleSpanUs(0))
    // Idempotent: the repaired project reopens clean.
    const second: GridRepair[][] = []
    parseProject(JSON.parse(serializeProjectToJson(reopened)), { onGridRepair: (r) => second.push([...r]) })
    expect(second).toEqual([])
  })

  it('composition.duration_us stays on the FRAME grid even when audio reaches furthest', () => {
    const { actor, audioLayer, videoLayer } = pairedFixture()
    // Delete the video so the audio tail alone defines the duration.
    expect(actor.dispatch('delete_layer', { layer: videoLayer }).ok).toBe(true)
    const end = sample(gridIndex(frame(120), AUDIO_GRID) + 3)
    expect(actor.dispatch('trim_layer', { layer: audioLayer, edge: 'out', new_t_us: end, escape_group: true }).ok).toBe(true)
    const comp = actor.snapshot().composition
    const audio = findLayer(actor.snapshot(), audioLayer)
    expect(audio.t_end_us).toBe(end)
    expect(snapFrameRound(comp.duration_us, FPS.num, FPS.den)).toBe(comp.duration_us)
    // Rounded UP, so the composition still contains the audio tail rather than
    // clipping it — a nearest-snap could land below `t_end_us`.
    expect(comp.duration_us).toBeGreaterThanOrEqual(audio.t_end_us)
  })

  // ── Ticket 11 acceptance, at the mutation level ──────────────────────────────
  it('a one-sample nudge moves the audio alone; the video member stays put', () => {
    const { actor, videoLayer, audioLayer, audioTrack } = pairedFixture()
    const before = actor.snapshot()
    const videoStart = findLayer(before, videoLayer).t_start_us
    const audioStart = findLayer(before, audioLayer).t_start_us
    const audioEnd = findLayer(before, audioLayer).t_end_us

    // Exactly what the nudge command sends: one sample INDEX later, escaping the group.
    const oneSampleLater = sample(gridIndex(audioStart, AUDIO_GRID) + 1)
    expect(actor.dispatch('move_layer', { layer: audioLayer, to_track: audioTrack, t_start_us: oneSampleLater, escape_group: true }).ok).toBe(true)

    const after = actor.snapshot()
    expect(findLayer(after, audioLayer).t_start_us).toBe(oneSampleLater)
    expect(gridIndex(findLayer(after, audioLayer).t_start_us, AUDIO_GRID)).toBe(gridIndex(audioStart, AUDIO_GRID) + 1)
    // The span rides along on its own lattice — a nudge slips, it does not trim.
    expect(gridIndex(findLayer(after, audioLayer).t_end_us, AUDIO_GRID)).toBe(gridIndex(audioEnd, AUDIO_GRID) + 1)
    // …and the video member has not moved at all.
    expect(findLayer(after, videoLayer).t_start_us).toBe(videoStart)
  })

  it('trimming the video member after a slip leaves the audio where it is', () => {
    // `trim.ts`'s aligned set requires COINCIDING edges, so once the audio is slipped
    // the video's In trim no longer pulls it — which is the right outcome for a
    // deliberately slipped track, and is documented rather than "fixed" (R2-D7).
    const { actor, videoLayer, audioLayer, audioTrack } = pairedFixture()
    const slipped = sample(gridIndex(frame(V_START_FRAME()), AUDIO_GRID) + 7)
    expect(actor.dispatch('move_layer', { layer: audioLayer, to_track: audioTrack, t_start_us: slipped, escape_group: true }).ok).toBe(true)

    const trimTo = frame(V_START_FRAME() + 10)
    expect(actor.dispatch('trim_layer', { layer: videoLayer, edge: 'in', new_t_us: trimTo, escape_group: false }).ok).toBe(true)
    const after = actor.snapshot()
    expect(findLayer(after, videoLayer).t_start_us).toBe(trimTo)
    expect(findLayer(after, audioLayer).t_start_us).toBe(slipped)
  })

  it('composition.sample_rate is untouched by all of this (export target, not a grid)', () => {
    const { actor, audioLayer, audioTrack } = pairedFixture()
    const before = actor.snapshot().composition.sample_rate
    expect(actor.dispatch('move_layer', { layer: audioLayer, to_track: audioTrack, t_start_us: sample(1234567), escape_group: true }).ok).toBe(true)
    expect(actor.snapshot().composition.sample_rate).toBe(before)
    // And it is still freely settable — no lock (spec finding 8).
    expect(actor.dispatch('set_composition', { sample_rate: 44_100 }).ok).toBe(true)
    expect(actor.snapshot().composition.sample_rate).toBe(44_100)
  })

  it('audio param tracks (gain/pan) normalize on the sample lattice, visual params on the frame grid', () => {
    const { actor, audioLayer, videoLayer } = pairedFixture()
    // A sample boundary that is deliberately NOT a frame boundary, so the two arms of
    // the write-time snap resolve the SAME request to two different times.
    const raw = sample(gridIndex(frame(V_START_FRAME()), AUDIO_GRID) + 3)
    expect(snapFrameRound(raw, FPS.num, FPS.den)).not.toBe(raw)

    const kf = (t: number) => ({ mode: 'Keyframed' as const, value: [{ id: 'k1', t_us: t, value: 0.5, interp: { kind: 'Linear' as const } }] })
    expect(actor.dispatch('update_layer_param_track', { layer: audioLayer, param_key: 'gain_db', track: kf(raw) }).ok).toBe(true)
    const audioParams = findLayer(actor.snapshot(), audioLayer).params
    if (audioParams.kind !== 'Audio' || audioParams.gain_db.mode !== 'Keyframed') throw new Error('expected a keyframed audio gain')
    const audioT = audioParams.gain_db.value[0]!.t_us
    // Audio automation is no longer coarser than the mixer that renders it: the
    // request survives verbatim because it is already on the mix lattice.
    expect(audioT).toBe(raw)

    expect(actor.dispatch('update_layer_param_track', { layer: videoLayer, param_key: 'opacity', track: kf(raw) }).ok).toBe(true)
    const videoParams = findLayer(actor.snapshot(), videoLayer).params
    if (videoParams.kind !== 'VideoClip' || videoParams.opacity.mode !== 'Keyframed') throw new Error('expected a keyframed opacity')
    expect(videoParams.opacity.value[0]!.t_us).toBe(snapFrameRound(raw, FPS.num, FPS.den))
    // The two land on different times from the same request — the point of the change.
    expect(audioT).not.toBe(videoParams.opacity.value[0]!.t_us)
  })
})
