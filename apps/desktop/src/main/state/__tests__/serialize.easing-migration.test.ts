import { describe, expect, it } from 'vitest'
import { parseProject, serializeProject } from '../serialize'
import type { Animated, Project } from '../model'
import { evalTrack, loadTrack, type Kf } from '../../../renderer/eval'

// The one-step named-ease migration (serialize.ts convergeNamedEases):
// EaseIn/EaseOut-bearing projects load with the kinds REWRITTEN to their baked
// bezier params, and the rewritten tracks evaluate to the same numbers the
// named variants always produced. Spec: .scratch/keyframe-easing/spec.md
// §Migration.

const EASE_IN_BAKED = { kind: 'Bezier', p1: [0.42, 0], p2: [1, 1] }
const EASE_OUT_BAKED = { kind: 'Bezier', p1: [0, 0], p2: [0.58, 1] }

/** 0→10 over 10 s under one legacy named ease — the shape the eval pins below. */
const legacyKeys = (kind: 'EaseIn' | 'EaseOut') => [
  { id: '00000000-0000-7000-8000-000000000001', t_us: 0, value: 0.0, interp: { kind } },
  { id: '00000000-0000-7000-8000-000000000002', t_us: 10_000_000, value: 10.0, interp: { kind: 'Linear' } },
]

/** Minimal parseable wire project (schema v10) carrying named eases in every
 *  track HOME the walk must reach: a transform field, opacity, an effect
 *  param, and a color track. */
function wireProject(): Record<string, unknown> {
  return {
    schema_version: 10,
    project_id: 'p',
    metadata: { name: 'm', created_at: '<TS>', modified_at: '<TS>', description: null },
    composition: {
      width: 1920, height: 1080, fps: { num: 30, den: 1 }, duration_us: 10_000_000,
      duration_pinned: false, sample_rate: 48000, channels: 2, color_space: 'Bt709',
      background: { r: 0, g: 0, b: 0, a: 255 },
    },
    media_pool: {},
    tracks: [
      {
        id: 't1', label: null, enabled: true, locked: false, muted: false, solo: false,
        removable: true, role: null, transient: false, height_px: 64,
        layers: [
          {
            id: 'l1', label: null, t_start_us: 0, t_end_us: 10_000_000,
            enabled: true, locked: false, metadata: {},
            params: {
              kind: 'ImageOverlay', media: '00000000-0000-7000-8000-00000000000a',
              transform: {
                x: { mode: 'Keyframed', value: legacyKeys('EaseOut') },
                y: { mode: 'Static', value: 0 },
                scale_x: { mode: 'Static', value: 1 }, scale_y: { mode: 'Static', value: 1 },
                rotation_deg: { mode: 'Static', value: 0 }, scale_linked: true,
              },
              opacity: { mode: 'Keyframed', value: legacyKeys('EaseIn') },
              blend_mode: 'Normal', fade_in_us: 0, fade_out_us: 0,
            },
            effects: [
              {
                id: 'fx1', kind: 'blur', enabled: true,
                params: { amount: { mode: 'Keyframed', value: legacyKeys('EaseIn') } },
              },
            ],
          },
          {
            id: 'l2', label: null, t_start_us: 0, t_end_us: 10_000_000,
            enabled: true, locked: false, metadata: {},
            params: {
              kind: 'Color', width: 64, height: 64,
              color: {
                mode: 'Keyframed',
                value: [
                  { id: 'c1', t_us: 0, value: { r: 0, g: 0, b: 0, a: 255 }, interp: { kind: 'EaseOut' } },
                  { id: 'c2', t_us: 10_000_000, value: { r: 255, g: 0, b: 0, a: 255 }, interp: { kind: 'Linear' } },
                ],
              },
            },
            effects: [],
          },
        ],
      },
    ],
    markers: [], transitions: [], groups: [], audio_roles: {},
    settings: {
      preview_width: 1280, preview_height: 720, autosave_interval_secs: 60,
      history_capacity: 200, auto_pair_audio_on_import: true,
      prefer_proxies: false, proxy_overrides: {},
    },
  }
}

const load = () => parseProject(JSON.parse(JSON.stringify(wireProject())), { onGridRepair: () => {} })

function keyframed(track: Animated<number>) {
  if (track.mode !== 'Keyframed') throw new Error('expected Keyframed')
  return track.value
}

describe('EaseIn/EaseOut load migration', () => {
  it('rewrites the named kinds to their baked beziers in EVERY track home', () => {
    const p = load()
    const l1 = p.tracks[0].layers[0]
    const params = l1.params as Extract<typeof l1.params, { kind: 'ImageOverlay' }>
    expect(keyframed(params.transform.x)[0].interp).toEqual(EASE_OUT_BAKED)
    expect(keyframed(params.opacity)[0].interp).toEqual(EASE_IN_BAKED)
    expect(keyframed(l1.effects[0].params.amount)[0].interp).toEqual(EASE_IN_BAKED)
    const l2p = p.tracks[0].layers[1].params as Extract<typeof l1.params, { kind: 'Color' }>
    expect(l2p.color.mode).toBe('Keyframed')
    expect((l2p.color as { value: { interp: unknown }[] }).value[0].interp).toEqual(EASE_OUT_BAKED)
    // Untouched neighbours stay untouched.
    expect(keyframed(params.opacity)[1].interp).toEqual({ kind: 'Linear' })
  })

  it('migrated tracks evaluate numerically identical to the retired named eases', () => {
    // Reference values derived INDEPENDENTLY (CPython bisection on the cubic
    // Bernstein form) from what the named variants always meant:
    // EaseIn = cubic-bezier(0.42,0,1,1), EaseOut = cubic-bezier(0,0,0.58,1).
    const p = load()
    const params = p.tracks[0].layers[0].params as { transform: { x: Animated<number> }; opacity: Animated<number> }
    loadTrack(9001, keyframed(params.opacity) as unknown as Kf[])
    for (const [tUs, want] of [
      [2_500_000, 0.9346465071882484],
      [5_000_000, 3.1535681257253945],
      [7_500_000, 6.218618691748899],
    ] as const) {
      expect(Math.abs(evalTrack(tUs, 0) - want), `EaseIn t=${tUs}`).toBeLessThan(1e-6)
    }
    loadTrack(9002, keyframed(params.transform.x) as unknown as Kf[])
    for (const [tUs, want] of [
      [2_500_000, 3.7813813082510968],
      [5_000_000, 6.8464318742746055],
      [7_500_000, 9.065353492811752],
    ] as const) {
      expect(Math.abs(evalTrack(tUs, 0) - want), `EaseOut t=${tUs}`).toBeLessThan(1e-6)
    }
  })

  it('is idempotent: a migrated project re-parses byte-identically', () => {
    const once = load()
    const twice = parseProject(
      JSON.parse(JSON.stringify(serializeProject(once as Project))),
      { onGridRepair: () => {} },
    )
    expect(JSON.stringify(serializeProject(twice))).toBe(JSON.stringify(serializeProject(once as Project)))
  })
})
