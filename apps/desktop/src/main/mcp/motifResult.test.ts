import { describe, it, expect } from 'vitest'
import { shapeMotifMcpResult } from './motifResult'

describe('shapeMotifMcpResult', () => {
  it('list_motifs strips html and json-serializes (sorted keys)', () => {
    const raw = [{ id: 'a', name: 'A', status: 'builtin', html: '<x>', content_hash: 'h' }]
    const r = shapeMotifMcpResult('list_motifs', raw)
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed[0].html).toBeUndefined()
    expect(parsed[0].id).toBe('a')
  })
  it('get_motif_source returns json of {manifest, html}', () => {
    const r = shapeMotifMcpResult('get_motif_source', { manifest: { id: 'a' }, html: '<x>' })
    expect(JSON.parse(r.content[0].text)).toEqual({ html: '<x>', manifest: { id: 'a' } })
  })
  it('write_motif_draft / install_motif return a bare text id', () => {
    expect(shapeMotifMcpResult('write_motif_draft', 'foo-2').content[0].text).toBe('foo-2')
    expect(shapeMotifMcpResult('install_motif', 'foo').content[0].text).toBe('foo')
  })
  it('delete_motif returns empty content', () => {
    expect(shapeMotifMcpResult('delete_motif', null).content).toEqual([])
  })
  it('motif_staleness_report → json array', () => {
    const r = shapeMotifMcpResult('motif_staleness_report', [{ motif_id: 'a', name: 'A', placed_version: 1, current_version: 2, layer_count: 1 }])
    expect(r.content[0].type).toBe('text')              // toolJson serializes to a text block
    expect(JSON.parse((r.content[0] as { text: string }).text)).toHaveLength(1)
  })
  it('acknowledge_motif_staleness → text count', () => {
    const r = shapeMotifMcpResult('acknowledge_motif_staleness', 3)
    expect(r.content[0]).toMatchObject({ type: 'text', text: '3' })
  })
  it('throws on an unhandled tool', () => {
    expect(() => shapeMotifMcpResult('nope', 1)).toThrow(/unhandled tool/)
  })
})
