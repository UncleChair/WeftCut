// Main-process leg of the chip edge-drag golden (spec D6). Reads the SAME
// fixture as the renderer leg
// (src/renderer/timeline/transitionEdgeClamp.golden.test.ts) and drives each
// case's CLAMPED commit through the full actor — mutation + commit validate —
// so a ghost the renderer allows is proven to land, and one step beyond the
// clamp is proven to refuse. Loaded via readFileSync (the mcp catalog-snapshot
// precedent): tsconfig.main resolves cross-project imports to emitted .d.ts,
// which JSON modules don't get.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { seededGen } from '../ids'
import { blankProject } from '../model'
import { createActor, type ActorHandle } from '../actor'

interface GoldenCase {
  name: string
  fps: { num: number; den: number }
  edge: 'left' | 'right'
  setup: { mediaDurationUs: number | null; aStartUs: number; cutUs: number; bEnd0Us: number; addDurationUs: number }
  geometry: { aEndUs: number; bStartUs: number; bEndUs: number; extendedUs: number; aSrcOutUs: number | null }
  rawTargetUs: number
  clampedUs: number
  commit: { durationUs: number; extendedUs: number }
  after: { aEndUs: number; bStartUs: number; durationUs: number; extendedUs: number; aSrcOutUs: number | null }
  beyond: { durationUs: number; extendedUs: number }
  beyondError: string
}

const fixture = JSON.parse(
  readFileSync('src/renderer/timeline/transitionEdgeClampGolden.fixture.json', 'utf8'),
) as { cases: GoldenCase[] }

/** Build the case's post-setup world through the actor: A (video when the
 *  fixture names a media duration, else color) adjacent to B at the cut, then
 *  the default overlap add. Returns the transition id. */
function buildCase(c: GoldenCase): { actor: ActorHandle; tid: string; a: string; b: string } {
  const gen = seededGen()
  const initial = blankProject(gen, 'golden')
  initial.composition.fps = { ...c.fps }
  const actor = createActor({ initial, idGen: gen, clock: () => '<TS>', emitLog: () => {} })
  const track = initial.tracks[0].id
  const aSpan = c.setup.cutUs - c.setup.aStartUs
  let a: string
  if (c.setup.mediaDurationUs !== null) {
    expect(actor.dispatch('add_media', { id: 'm-golden', kind: 'Video', duration_us: c.setup.mediaDurationUs }).ok).toBe(true)
    a = (actor.dispatch('add_layer', { track, kind: 'video', media: 'm-golden', src_in_us: 0, src_out_us: aSpan, t_start_us: c.setup.aStartUs, t_end_us: c.setup.cutUs }) as { ok: true; value: string }).value
  } else {
    a = (actor.dispatch('add_layer', { track, kind: 'color', t_start_us: c.setup.aStartUs, t_end_us: c.setup.cutUs }) as { ok: true; value: string }).value
  }
  const b = (actor.dispatch('add_layer', { track, kind: 'color', t_start_us: c.setup.cutUs, t_end_us: c.setup.bEnd0Us }) as { ok: true; value: string }).value
  const r = actor.dispatch('add_transition', { from: a, to: b, duration_us: c.setup.addDurationUs })
  expect(r.ok).toBe(true)
  return { actor, tid: (r as { ok: true; value: string }).value, a, b }
}

function layerOf(actor: ActorHandle, id: string) {
  for (const t of actor.snapshot().tracks) {
    const l = t.layers.find((x) => x.id === id)
    if (l) return l
  }
  throw new Error('layer not found')
}
function srcOutOf(actor: ActorHandle, id: string): number | null {
  const pa = layerOf(actor, id).params as { kind: string; src_out_us?: number }
  return pa.kind === 'VideoClip' || pa.kind === 'Audio' ? (pa.src_out_us as number) : null
}

describe('transition edge clamp golden (main-process leg, through the actor)', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const { actor, tid, a, b } = buildCase(c)
      // The fixture's post-setup geometry is what the renderer leg feeds its
      // kernels — assert it here so the two legs provably describe ONE world.
      expect(layerOf(actor, a).t_end_us).toBe(c.geometry.aEndUs)
      expect(layerOf(actor, b).t_start_us).toBe(c.geometry.bStartUs)
      expect(layerOf(actor, b).t_end_us).toBe(c.geometry.bEndUs)
      expect(srcOutOf(actor, a)).toBe(c.geometry.aSrcOutUs)
      expect(actor.snapshot().transitions[0]).toMatchObject({
        id: tid,
        duration_us: c.geometry.aEndUs - c.geometry.bStartUs,
        extended_us: c.geometry.extendedUs,
      })

      // One step beyond the clamp refuses atomically (before the accept, so
      // the refusal is judged against the exact fixture geometry).
      const beyond = actor.dispatch('update_transition', { transition: tid, duration_us: c.beyond.durationUs, extended_us: c.beyond.extendedUs })
      expect(beyond.ok).toBe(false)
      if (!beyond.ok) expect(beyond.error.error).toBe(c.beyondError)
      expect(layerOf(actor, a).t_end_us).toBe(c.geometry.aEndUs) // untouched
      expect(layerOf(actor, b).t_start_us).toBe(c.geometry.bStartUs)

      // The clamped commit — the exact patch the renderer's pointerup sends —
      // is accepted and lands the expected geometry.
      const r = actor.dispatch('update_transition', { transition: tid, duration_us: c.commit.durationUs, extended_us: c.commit.extendedUs })
      expect(r.ok).toBe(true)
      expect(layerOf(actor, a).t_end_us).toBe(c.after.aEndUs)
      expect(layerOf(actor, b).t_start_us).toBe(c.after.bStartUs)
      expect(srcOutOf(actor, a)).toBe(c.after.aSrcOutUs)
      expect(actor.snapshot().transitions[0]).toMatchObject({
        duration_us: c.after.durationUs,
        extended_us: c.after.extendedUs,
      })
    })
  }
})
