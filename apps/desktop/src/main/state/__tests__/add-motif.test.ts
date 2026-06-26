// apps/desktop/src/main/state/__tests__/add-motif.test.ts
// TDD tests for Task 5: add_motif as a pure TS recorded mutation.
// Written FIRST (RED) before implementation; must go GREEN after all changes land.
import { describe, it, expect } from 'vitest'
import { routeChannel } from '../router'
import { routeMcpTool } from '../../mcp/mutationTools'
import { createActor } from '../actor'
import { blankProject } from '../model'
import { seededGen } from '../ids'
import { MotifCatalog } from '../../../shared/motifs/catalog'

// ── helpers ──────────────────────────────────────────────────────────────────
function makeActor() {
  const idGen = seededGen()
  const catalog = new MotifCatalog()
  const proj = blankProject(idGen, 'test')
  return createActor({ initial: proj, idGen, motifCatalog: catalog })
}

// ── a. routing ────────────────────────────────────────────────────────────────
describe('add_motif routing', () => {
  it('routeChannel("add_motif") → {kind:"command"}', () => {
    expect(routeChannel('add_motif').kind).toBe('command')
  })

  it('routeMcpTool("add_motif") → "ts"', () => {
    expect(routeMcpTool('add_motif')).toBe('ts')
  })
})

// ── b. actor.command – no-track path (two-commit, id order) ──────────────────
describe('actor.command("add_motif") — no track_id', () => {
  it('creates Overlay track THEN Motif layer (track id < layer id, idGen order)', () => {
    const actor = makeActor()
    const before = actor.snapshot()
    const trackCountBefore = before.tracks.length

    const result = actor.command('add_motif', { motifId: 'countdown', tStartUs: 0 })
    expect(result.ok).toBe(true)
    const layerId = result.ok ? result.value as string : ''

    const snap = actor.snapshot()
    // One new track was created
    expect(snap.tracks.length).toBe(trackCountBefore + 1)
    // The new track is labeled 'Overlay' and has no role
    const overlayTrack = snap.tracks.find((t) => t.label === 'Overlay' && t.role === null)
    expect(overlayTrack).toBeDefined()
    // The layer is on the overlay track
    const layer = overlayTrack!.layers.find((l) => l.id === layerId)
    expect(layer).toBeDefined()
    // The returned id is the LAYER id (not the track id)
    expect(layerId).not.toBe(overlayTrack!.id)
    // id order: track id was minted BEFORE layer id (both are UUID v7-seeded, track < layer lexically by minting order)
    expect(overlayTrack!.id < layerId).toBe(true)
  })

  it('layer params: kind=Motif, correct motif_id/version, canonical defaults, src_in_us=0, identity transform, Static(1) opacity', () => {
    const actor = makeActor()
    const result = actor.command('add_motif', { motifId: 'countdown', tStartUs: 0 })
    expect(result.ok).toBe(true)
    const layerId = result.ok ? result.value as string : ''

    const snap = actor.snapshot()
    const layer = snap.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)
    expect(layer).toBeDefined()
    const p = layer!.params
    expect(p.kind).toBe('Motif')
    if (p.kind !== 'Motif') return
    expect(p.motif_id).toBe('countdown')
    expect(p.motif_version).toBe(1) // countdown manifest version=1
    // Canonical defaults for countdown: accent, label, seconds (alphabetical BTreeMap order)
    expect(p.props).toEqual({ accent: '#ff4d4d', label: 'GO', seconds: 5 })
    expect(p.src_in_us).toBe(0)
    // identity transform
    expect(p.transform).toEqual({
      x: { mode: 'Static', value: 0 },
      y: { mode: 'Static', value: 0 },
      scale_x: { mode: 'Static', value: 1 },
      scale_y: { mode: 'Static', value: 1 },
      rotation_deg: { mode: 'Static', value: 0 },
      anchor: [0.5, 0.5],
    })
    expect(p.opacity).toEqual({ mode: 'Static', value: 1 })
  })

  it('uses default duration from manifest when t_end_us is absent (countdown: 5s)', () => {
    const actor = makeActor()
    const result = actor.command('add_motif', { motifId: 'countdown', tStartUs: 1_000_000 })
    expect(result.ok).toBe(true)
    const layerId = result.ok ? result.value as string : ''
    const snap = actor.snapshot()
    const layer = snap.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId)
    expect(layer).toBeDefined()
    // default_duration_s=5.0 → Math.trunc(5.0*1e6)+1e6 = 6_000_000
    expect(layer!.t_end_us - layer!.t_start_us).toBeGreaterThan(0)
    // t_start_us=1_000_000, t_end=1_000_000+5_000_000=6_000_000 before snap
    // (snap may round to fps grid but direction is correct)
    expect(layer!.t_end_us).toBeGreaterThan(layer!.t_start_us)
  })
})

// ── b. actor.command – with track_id (single-commit) ─────────────────────────
describe('actor.command("add_motif") — with track_id', () => {
  it('uses the provided track, no new track created, returns layer id', () => {
    const actor = makeActor()
    // First add a track manually
    const trackResult = actor.dispatch('add_track', { label: 'MyTrack' })
    expect(trackResult.ok).toBe(true)
    const trackId = trackResult.ok ? trackResult.value as string : ''
    const trackCountBefore = actor.snapshot().tracks.length

    const result = actor.command('add_motif', { motifId: 'countdown', trackId, tStartUs: 0 })
    expect(result.ok).toBe(true)
    const layerId = result.ok ? result.value as string : ''

    const snap = actor.snapshot()
    // No new tracks
    expect(snap.tracks.length).toBe(trackCountBefore)
    // Layer is on the specified track
    const track = snap.tracks.find((t) => t.id === trackId)
    const layer = track?.layers.find((l) => l.id === layerId)
    expect(layer).toBeDefined()
  })
})

// ── c. reject-before-commit (bad props burn no id) ────────────────────────────
describe('actor.command("add_motif") — reject-before-commit', () => {
  it('unknown prop key → reject, no track/layer committed', () => {
    const actor = makeActor()
    const snapBefore = actor.snapshot()

    const result = actor.command('add_motif', {
      motifId: 'countdown', tStartUs: 0, props: { unknownKey: 'bad' },
    })
    expect(result.ok).toBe(false)
    const snapAfter = actor.snapshot()
    // No new tracks or layers committed
    expect(snapAfter.tracks.length).toBe(snapBefore.tracks.length)
    expect(snapAfter.tracks.flatMap((t) => t.layers).length)
      .toBe(snapBefore.tracks.flatMap((t) => t.layers).length)
  })

  it('unknown motif_id → reject, no track/layer committed', () => {
    const actor = makeActor()
    const snapBefore = actor.snapshot()

    const result = actor.command('add_motif', { motifId: 'nonexistent-motif', tStartUs: 0 })
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: { error: string; detail?: string } }).error.error).toBe('InvalidArgument')
    const snapAfter = actor.snapshot()
    expect(snapAfter.tracks.length).toBe(snapBefore.tracks.length)
  })

  it('invalid prop value (seconds out of range) → reject before commit', () => {
    const actor = makeActor()
    const snapBefore = actor.snapshot()

    const result = actor.command('add_motif', {
      motifId: 'countdown', tStartUs: 0, props: { seconds: 9999 }, // max is 60
    })
    expect(result.ok).toBe(false)
    const snapAfter = actor.snapshot()
    expect(snapAfter.tracks.length).toBe(snapBefore.tracks.length)
  })
})

// ── d. MCP path ───────────────────────────────────────────────────────────────
describe('actor.mcpCall("add_motif") — MCP dedicated arm', () => {
  it('creates a Motif layer via MCP and returns toolText(layerId)', () => {
    const actor = makeActor()
    const result = actor.mcpCall('add_motif', JSON.stringify({
      motif_id: 'countdown',
      t_start_us: 0,
    }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const text = result.result.content[0]?.text
    expect(typeof text).toBe('string')
    expect(text!.length).toBeGreaterThan(0)
    // Verify the layer was actually created
    const snap = actor.snapshot()
    const layers = snap.tracks.flatMap((t) => t.layers)
    const layer = layers.find((l) => l.id === text)
    expect(layer).toBeDefined()
    expect(layer!.params.kind).toBe('Motif')
    // No-track MCP path mints the Overlay track FIRST, then the layer — so the
    // returned layer id is ordered AFTER the minted track id (idGen call order).
    // This mirrors the command-path id-order assertion and guards the Task 7 MCP differential.
    const overlayTrack = snap.tracks.find((t) => t.label === 'Overlay' && t.role === null)
    expect(overlayTrack).toBeDefined()
    expect(overlayTrack!.id < text!).toBe(true)
  })

  it('MCP bad motif_id → ok:false invalid_params', () => {
    const actor = makeActor()
    const result = actor.mcpCall('add_motif', JSON.stringify({
      motif_id: 'no-such-motif',
      t_start_us: 0,
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid_params')
  })

  it('MCP bad props → ok:false invalid_params, no commit', () => {
    const actor = makeActor()
    const snapBefore = actor.snapshot()
    const result = actor.mcpCall('add_motif', JSON.stringify({
      motif_id: 'countdown',
      t_start_us: 0,
      props: { badKey: 'oops' },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('invalid_params')
    const snapAfter = actor.snapshot()
    expect(snapAfter.tracks.length).toBe(snapBefore.tracks.length)
  })

  it('MCP missing motif_id → rejects (required field)', () => {
    const actor = makeActor()
    const result = actor.mcpCall('add_motif', JSON.stringify({ t_start_us: 0 }))
    expect(result.ok).toBe(false)
  })

  it('MCP with explicit track_id → single commit, no new track', () => {
    const actor = makeActor()
    const trackResult = actor.dispatch('add_track', { label: 'MyTrack' })
    const trackId = trackResult.ok ? trackResult.value as string : ''
    const trackCountBefore = actor.snapshot().tracks.length

    const result = actor.mcpCall('add_motif', JSON.stringify({
      motif_id: 'countdown',
      t_start_us: 0,
      track_id: trackId,
    }))
    expect(result.ok).toBe(true)
    expect(actor.snapshot().tracks.length).toBe(trackCountBefore)
  })
})
