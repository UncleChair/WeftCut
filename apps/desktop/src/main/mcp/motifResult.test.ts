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
  it('throws on an unhandled tool', () => {
    expect(() => shapeMotifMcpResult('nope', 1)).toThrow(/unhandled tool/)
  })
})
