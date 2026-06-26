import { describe, it, expect } from 'vitest'
import type { Manifest } from '../../shared/motifs/catalog'
import type { BuiltinMotif } from './authoring'
import { currentVersions, buildStalenessReport, buildAckEntries } from './staleness'

function man(id: string, name: string, version: number): Manifest {
  return { id, name, version, size: [100, 100], default_duration_s: 1, fonts: [], props_schema: {} }
}
function cur(entries: Array<[string, string, number]>): Map<string, { name: string; version: number }> {
  return new Map(entries.map(([id, name, v]) => [id, { name, version: v }]))
}

describe('buildStalenessReport', () => {
  it('groups by motif and takes the min placed version', () => {
    const r = buildStalenessReport(
      [{ motifId: 'lower-third', placedVersion: 1 }, { motifId: 'lower-third', placedVersion: 2 }],
      cur([['lower-third', 'Lower Third', 3]]),
    )
    expect(r).toEqual([{ motif_id: 'lower-third', name: 'Lower Third', placed_version: 1, current_version: 3, layer_count: 2 }])
  })

  it('skips equal and unknown ids', () => {
    const r = buildStalenessReport(
      [{ motifId: 'a', placedVersion: 2 }, { motifId: 'ghost', placedVersion: 1 }],
      cur([['a', 'A', 2]]),
    )
    expect(r).toEqual([])
  })

  it('counts only stale layers and reports downgrades', () => {
    const r = buildStalenessReport(
      [{ motifId: 'a', placedVersion: 3 }, { motifId: 'a', placedVersion: 1 }],
      cur([['a', 'A', 1]]),
    )
    expect(r).toEqual([{ motif_id: 'a', name: 'A', placed_version: 3, current_version: 1, layer_count: 1 }])
  })

  it('orders deterministically by motif id', () => {
    const r = buildStalenessReport(
      [{ motifId: 'b', placedVersion: 1 }, { motifId: 'a', placedVersion: 1 }],
      cur([['b', 'B', 2], ['a', 'A', 2]]),
    )
    expect(r.map((e) => e.motif_id)).toEqual(['a', 'b'])
  })
})

describe('buildAckEntries', () => {
  it('bumps only stale layers and keeps props', () => {
    const props = { accent: '#fff' }
    const entries = buildAckEntries(
      [
        { layerId: 'stale', motifId: 'a', placedVersion: 1, props },
        { layerId: 'fresh', motifId: 'a', placedVersion: 3, props },
        { layerId: 'ghost', motifId: 'ghost', placedVersion: 1, props },
      ],
      cur([['a', 'A', 3]]),
    )
    expect(entries).toEqual([{ layer_id: 'stale', motif_id: 'a', motif_version: 3, props }])
  })
})

describe('currentVersions', () => {
  it('merges built-ins and published user motifs; published wins on collision', () => {
    const builtins: BuiltinMotif[] = [{ id: 'countdown', manifest: man('countdown', 'Countdown', 1), html: '' }]
    const m = currentVersions(builtins, [man('user-x', 'User X', 7)])
    expect(m.get('countdown')).toEqual({ name: 'Countdown', version: 1 })
    expect(m.get('user-x')).toEqual({ name: 'User X', version: 7 })
  })

  it('published overrides builtin on id collision', () => {
    const builtins: BuiltinMotif[] = [{ id: 'x', manifest: man('x', 'BuiltIn', 1), html: '' }]
    const m = currentVersions(builtins, [man('x', 'UserX', 9)])
    expect(m.get('x')).toEqual({ name: 'UserX', version: 9 })
  })
})
