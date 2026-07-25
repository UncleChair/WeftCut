import { describe, it, expect } from 'vitest'
import { seededGen } from '../ids'
import { blankProject, type Layer, type MotifParams, type Project } from '../model'
import { applyAddLayer, colorParams, textParamsDefault } from './add'
import { videoClipParams, audioParams } from './media'
import { isCommandFailure } from '../errors'
import { applyUpdateLayerParams, applyUpdateLayerParamTrack } from './params'
import { MotifCatalog } from '../../../shared/motifs/catalog'
import { validate } from '../validate'

const MID = '00000000-0000-0000-0000-0000000000aa'
function expectCmd(fn: () => void, code: string) {
  try { fn(); throw new Error(`expected ${code}`) } catch (e) { expect(isCommandFailure(e) && e.err.error).toBe(code) }
}
function layerOf(p: Project, id: string): Layer {
  for (const t of p.tracks) { const l = t.layers.find((x) => x.id === id); if (l) return l }
  throw new Error('not found')
}

describe('applyUpdateLayerParams (field merge)', () => {
  it('Text patch sets content/opacity/x (animated fields → Static)', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const id = applyAddLayer(p, g, p.tracks[1].id, textParamsDefault('hi'), 0, 1_000_000)
    applyUpdateLayerParams(p, id, { kind: 'Text', content: 'world', opacity: 0.5, x: 10 }, new MotifCatalog())
    const t = layerOf(p, id).params as Extract<Layer['params'], { kind: 'Text' }>
    expect([t.content, t.opacity, t.transform.x]).toEqual(['world', { mode: 'Static', value: 0.5 }, { mode: 'Static', value: 10 }])
  })
  it('Color patch sets color + width', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const id = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 100, 100), 0, 1_000_000)
    applyUpdateLayerParams(p, id, { kind: 'Color', color: { r: 1, g: 2, b: 3, a: 255 }, width: 640 }, new MotifCatalog())
    const c = layerOf(p, id).params as Extract<Layer['params'], { kind: 'Color' }>
    expect([c.color, c.width, c.height]).toEqual([{ mode: 'Static', value: { r: 1, g: 2, b: 3, a: 255 } }, 640, 100])
  })
  it('VideoClip patch sets src range + scale + speed + flip', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const id = applyAddLayer(p, g, p.tracks[0].id, videoClipParams(MID, 0, 4_000_000), 0, 4_000_000)
    applyUpdateLayerParams(p, id, { kind: 'VideoClip', src_in_us: 500_000, src_out_us: 3_000_000, scale_x: 2, speed: 1.5, flip_h: true }, new MotifCatalog())
    const v = layerOf(p, id).params as Extract<Layer['params'], { kind: 'VideoClip' }>
    expect([v.src_in_us, v.src_out_us, v.transform.scale_x, v.speed, v.flip_h]).toEqual([500_000, 3_000_000, { mode: 'Static', value: 2 }, 1.5, true])
  })
  it('Audio patch sets gain/mute/role', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const id = applyAddLayer(p, g, p.tracks[0].id, audioParams(MID, 0, 3_000_000), 0, 3_000_000)
    applyUpdateLayerParams(p, id, { kind: 'Audio', gain_db: -6, mute: true, role: 'dialogue' }, new MotifCatalog())
    const a = layerOf(p, id).params as Extract<Layer['params'], { kind: 'Audio' }>
    expect([a.gain_db, a.mute, a.role]).toEqual([{ mode: 'Static', value: -6 }, true, 'dialogue'])
  })
  it('Motif patch merges props field-wise (does not replace the map)', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const motif: MotifParams = { kind: 'Motif', motif_id: 'm', motif_version: 1, props: { a: 1, b: 2 },
      src_in_us: 0, transform: textParamsDefaultTransform(), opacity: { mode: 'Static', value: 1 } }
    p.tracks[0].layers.push({ id: 'mo', label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {}, params: motif, effects: [] })
    applyUpdateLayerParams(p, 'mo', { kind: 'Motif', opacity: 0.3, props: { b: 9, c: 3 } }, new MotifCatalog())
    const m = layerOf(p, 'mo').params as MotifParams
    expect([m.props, m.opacity]).toEqual([{ a: 1, b: 9, c: 3 }, { mode: 'Static', value: 0.3 }])
  })
  it('kind mismatch → LayerParamsKindMismatch', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const id = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 10, 10), 0, 1_000_000)
    expectCmd(() => applyUpdateLayerParams(p, id, { kind: 'Text', content: 'x' }, new MotifCatalog()), 'LayerParamsKindMismatch')
  })
  it('locked track → TrackLocked; missing layer → LayerNotFound', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const id = applyAddLayer(p, g, p.tracks[0].id, colorParams({ r: 0, g: 0, b: 0, a: 255 }, 10, 10), 0, 1_000_000)
    p.tracks[0].locked = true
    expectCmd(() => applyUpdateLayerParams(p, id, { kind: 'Color', width: 1 }, new MotifCatalog()), 'TrackLocked')
    expectCmd(() => applyUpdateLayerParams(p, 'ghost', { kind: 'Color', width: 1 }, new MotifCatalog()), 'LayerNotFound')
  })
})

describe('applyUpdateLayerParamTrack', () => {
  const kfTrack = () => ({ mode: 'Keyframed' as const, value: [
    { id: '00000000-0000-0000-0000-0000000000f1', t_us: 0, value: 0, interp: { kind: 'Linear' as const } },
    { id: '00000000-0000-0000-0000-0000000000f2', t_us: 1_000_000, value: 1, interp: { kind: 'Linear' as const } },
  ] })
  function textLayer(): { p: Project; id: string } {
    const g = seededGen(); const p = blankProject(g, 'kf')
    const id = applyAddLayer(p, g, p.tracks[1].id, textParamsDefault('t'), 0, 2_000_000)
    return { p, id }
  }
  it('writes a keyframed track to opacity', () => {
    const { p, id } = textLayer()
    applyUpdateLayerParamTrack(p, id, 'opacity', kfTrack())
    const t = layerOf(p, id).params as Extract<Layer['params'], { kind: 'Text' }>
    expect(t.opacity.mode).toBe('Keyframed')
    expect((t.opacity.value as { t_us: number }[]).map((k) => k.t_us)).toEqual([0, 1_000_000])
  })
  it('empty Keyframed track → EmptyKeyframeTrack', () => {
    const { p, id } = textLayer()
    expectCmd(() => applyUpdateLayerParamTrack(p, id, 'opacity', { mode: 'Keyframed', value: [] }), 'EmptyKeyframeTrack')
  })
  it('unknown param key → UnknownKeyframeParam', () => {
    const { p, id } = textLayer()
    expectCmd(() => applyUpdateLayerParamTrack(p, id, 'bogus', kfTrack()), 'UnknownKeyframeParam')
  })
  it('effect-param path lazily inserts the slot for an existing effect, then writes', () => {
    const { p, id } = textLayer()
    const layer = layerOf(p, id)
    layer.effects.push({ id: '00000000-0000-0000-0000-0000000000e1', kind: 'blur', enabled: true, params: {} })
    applyUpdateLayerParamTrack(p, id, 'effects[00000000-0000-0000-0000-0000000000e1].params[intensity]', kfTrack())
    expect(layerOf(p, id).effects[0].params.intensity.mode).toBe('Keyframed')
  })
  it('locked track → TrackLocked (checked before normalize)', () => {
    const { p, id } = textLayer()
    p.tracks[1].locked = true
    expectCmd(() => applyUpdateLayerParamTrack(p, id, 'opacity', { mode: 'Keyframed', value: [] }), 'TrackLocked')
  })
})

// local helper for the hand-built Motif layer (mirrors add.ts defaultTransform)
function textParamsDefaultTransform() {
  const s = (v: number) => ({ mode: 'Static' as const, value: v })
  return { x: s(0), y: s(0), scale_x: s(1), scale_y: s(1), rotation_deg: s(0), anchor: [0.5, 0.5] as [number, number] }
}

describe('applyUpdateLayerParams — Motif content-window clamp', () => {
  // countdown manifest: max_duration_prop = "seconds" → contentDur = seconds * 1e6
  function makeCountdownProject() {
    const g = seededGen()
    const p = blankProject(g, 'clamp-test')
    // fps 30/1 for clean integer frame boundaries
    p.composition.fps = { num: 30, den: 1 }
    const motif: MotifParams = {
      kind: 'Motif',
      motif_id: 'countdown',
      motif_version: 1,
      // props.seconds=10 → contentDur=10s; t_end=10s, src_in=0 → window fits exactly
      props: { seconds: 10, label: 'GO', accent: '#ff4d4d' },
      src_in_us: 0,
      transform: textParamsDefaultTransform(),
      opacity: { mode: 'Static', value: 1 },
    }
    p.tracks[0].layers.push({
      id: 'mo1',
      label: null,
      t_start_us: 0,
      t_end_us: 10_000_000,
      enabled: true,
      locked: false,
      metadata: {},
      params: motif,
      effects: [],
    })
    return { p, g }
  }

  it('shrink: seconds 10→3 clamps t_end to 3s (src_in stays 0)', () => {
    const { p } = makeCountdownProject()
    const catalog = new MotifCatalog() // countdown is built-in
    applyUpdateLayerParams(p, 'mo1', { kind: 'Motif', props: { seconds: 3 } }, catalog)
    const layer = p.tracks[0].layers.find((l) => l.id === 'mo1')!
    const m = layer.params as MotifParams
    expect(m.src_in_us).toBe(0)
    expect(layer.t_end_us).toBe(3_000_000)
  })

  it('grow: seconds 10→15 leaves geometry unchanged (manifest cap is from prop, 15 > 10 but no max_duration_s cap applies after prop update)', () => {
    // NOTE: countdown max_duration_prop="seconds" so contentDur = props.seconds * 1e6
    // After setting seconds=15, contentDur=15s; window is 0..10s (10s wide) which fits → no clamp.
    const { p } = makeCountdownProject()
    const catalog = new MotifCatalog()
    applyUpdateLayerParams(p, 'mo1', { kind: 'Motif', props: { seconds: 15 } }, catalog)
    const layer = p.tracks[0].layers.find((l) => l.id === 'mo1')!
    const m = layer.params as MotifParams
    expect(m.src_in_us).toBe(0)
    expect(layer.t_end_us).toBe(10_000_000)
  })

  // Regression: the zero-width guard used to floor at `tStart + 1` µs, which is
  // off-grid — with validate's grid backstop that turned a silent 1 µs sliver into
  // a REJECTED edit. Floor is one frame, and the result must survive validate.
  it.each([
    { fps: { num: 30, den: 1 }, expected: 33_333 },
    { fps: { num: 30_000, den: 1001 }, expected: 33_367 },
  ])('content under one frame clamps to exactly one frame at $fps.num/$fps.den', ({ fps, expected }) => {
    const { p } = makeCountdownProject()
    p.composition.fps = fps
    applyUpdateLayerParams(p, 'mo1', { kind: 'Motif', props: { seconds: 0.01 } }, new MotifCatalog())
    const layer = p.tracks[0].layers.find((l) => l.id === 'mo1')!
    expect(layer.t_start_us).toBe(0)
    expect(layer.t_end_us).toBe(expected)
    expect(() => validate(p)).not.toThrow()
  })

  it('no catalog entry → no clamp (motif_id not in catalog)', () => {
    // Uses a motif_id not in the catalog; field merge only, no clamp.
    const g = seededGen()
    const p = blankProject(g, 'no-clamp')
    const motif: MotifParams = {
      kind: 'Motif',
      motif_id: 'unknown-id',
      motif_version: 1,
      props: { seconds: 5 },
      src_in_us: 0,
      transform: textParamsDefaultTransform(),
      opacity: { mode: 'Static', value: 1 },
    }
    p.tracks[0].layers.push({ id: 'mo2', label: null, t_start_us: 0, t_end_us: 10_000_000, enabled: true, locked: false, metadata: {}, params: motif, effects: [] })
    const catalog = new MotifCatalog()
    applyUpdateLayerParams(p, 'mo2', { kind: 'Motif', props: { seconds: 3 } }, catalog)
    const layer = p.tracks[0].layers.find((l) => l.id === 'mo2')!
    // No clamp because no catalog entry
    expect(layer.t_end_us).toBe(10_000_000)
  })

  it('existing Motif tests pass unchanged (catalog=new MotifCatalog(), motif_id "m" not in catalog → no clamp)', () => {
    const g = seededGen(); const p = blankProject(g, 'p')
    const motif: MotifParams = { kind: 'Motif', motif_id: 'm', motif_version: 1, props: { a: 1, b: 2 },
      src_in_us: 0, transform: textParamsDefaultTransform(), opacity: { mode: 'Static', value: 1 } }
    p.tracks[0].layers.push({ id: 'mo', label: null, t_start_us: 0, t_end_us: 1_000_000, enabled: true, locked: false, metadata: {}, params: motif, effects: [] })
    applyUpdateLayerParams(p, 'mo', { kind: 'Motif', opacity: 0.3, props: { b: 9, c: 3 } }, new MotifCatalog())
    const m = layerOf(p, 'mo').params as MotifParams
    expect([m.props, m.opacity]).toEqual([{ a: 1, b: 9, c: 3 }, { mode: 'Static', value: 0.3 }])
  })
})
