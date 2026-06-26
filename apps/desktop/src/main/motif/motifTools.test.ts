import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UserMotifStore } from './store'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { runMotifTool, type MotifToolDeps } from './motifTools'
import type { BuiltinMotif, MotifLayerRef } from './authoring'

function m(name: string, id = 'ignored'): Manifest {
  return { id, name, version: 1, size: [100, 100], default_duration_s: 1, fonts: [], props_schema: {} }
}
function doc(man: Manifest, body = 'x'): string {
  return composeMotifHtml(man, `<head></head><body>${body}<script>motif.define({setup(){}})</script></body>`)
}

let store: UserMotifStore
let emitted: number
let refreshed: number
let rebinds: unknown[][]
let layers: MotifLayerRef[]
let deps: MotifToolDeps
const BUILTINS: BuiltinMotif[] = [{ id: 'countdown', manifest: m('Countdown', 'countdown'), html: doc(m('Countdown', 'countdown'), 'CD') }]

beforeEach(() => {
  store = new UserMotifStore(mkdtempSync(path.join(tmpdir(), 'motiftools-')))
  emitted = 0; refreshed = 0; rebinds = []; layers = []
  deps = {
    store, builtins: BUILTINS,
    motifLayers: () => layers,
    dispatchRebind: (u) => { rebinds.push(u) },
    emitChanged: () => { emitted++ },
    refreshCatalog: () => { refreshed++ },
    readFile: (p) => { throw new Error('unexpected readFile ' + p) },
  }
})

describe('runMotifTool', () => {
  it('list_motifs returns the full payload with html', () => {
    const out = runMotifTool('list_motifs', {}, deps) as Record<string, unknown>[]
    expect(out.find((e) => e.id === 'countdown')!.status).toBe('builtin')
    expect(typeof out[0].html).toBe('string')
  })

  it('get_motif_source reads an id (renderer arg shape { id })', () => {
    const out = runMotifTool('get_motif_source', { id: 'countdown' }, deps) as { manifest: Manifest }
    expect(out.manifest.id).toBe('countdown')
  })

  it('write_motif_draft unwraps the renderer { args: { manifest, html } } shape, emits + refreshes', () => {
    const id = runMotifTool('write_motif_draft', { args: { manifest: m('Foo'), html: '<head></head><body>B</body>' } }, deps) as string
    expect(store.getDraft(id)).not.toBeNull()
    expect(emitted).toBe(1); expect(refreshed).toBe(1)
  })

  it('write_motif_draft also accepts the MCP flat { manifest, html, from } shape', () => {
    const id = runMotifTool('write_motif_draft', { manifest: m('Foo'), html: '<head></head><body>B</body>', from: 'countdown' }, deps) as string
    expect(store.readDraftTarget(id)).toBe('countdown')
  })

  it('amend_motif_draft uses camelCase { draftId, source }', () => {
    store.writeDraft('d1', doc(m('D', 'd1'), 'one'))
    runMotifTool('amend_motif_draft', { draftId: 'd1', source: doc(m('D', 'hacker'), 'TWO') }, deps)
    expect(store.getDraft('d1')!.html).toContain('TWO')
    expect(emitted).toBe(1)
  })

  it('create_edit_draft uses camelCase { sourceId }', () => {
    const id = runMotifTool('create_edit_draft', { sourceId: 'countdown' }, deps) as string
    expect(store.getDraft(id)).not.toBeNull(); expect(emitted).toBe(1)
  })

  it('import_motif reads the file then mints a draft', () => {
    deps.readFile = vi.fn(() => doc(m('Imported', 'x'), 'IMP'))
    const id = runMotifTool('import_motif', { path: '/some/file.html' }, deps) as string
    expect(store.getDraft(id)!.html).toContain('IMP'); expect(emitted).toBe(1)
  })

  it('delete_motif removes a published motif and emits', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    runMotifTool('delete_motif', { id: 'foo' }, deps)
    expect(store.getMotif('foo')).toBeNull(); expect(emitted).toBe(1)
  })

  it('install_motif (New) publishes, returns id, no rebind dispatched', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo')))
    const id = runMotifTool('install_motif', { args: { draft_id: 'foo', mode: { kind: 'new' } } }, deps) as string
    expect(id).toBe('foo'); expect(rebinds).toEqual([]); expect(emitted).toBe(1); expect(refreshed).toBe(1)
  })

  it('install_motif (Update) dispatches the rebind built from the live layers', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    store.writeDraft('wip', doc(m('Foo', 'wip')))
    layers = [{ layerId: 'la', motifId: 'wip', props: {} }]
    const id = runMotifTool('install_motif', { args: { draft_id: 'wip', mode: { kind: 'update', target_id: 'foo' } } }, deps) as string
    expect(id).toBe('foo')
    expect(rebinds.length).toBe(1)
    expect((rebinds[0] as any[])[0]).toMatchObject({ layer_id: 'la', motif_id: 'foo', motif_version: 2 })
  })

  it('install_motif accepts the MCP flat string mode "new"', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo')))
    const id = runMotifTool('install_motif', { draft_id: 'foo', mode: 'new' }, deps) as string
    expect(id).toBe('foo')
  })

  it('throws on an unhandled tool', () => {
    expect(() => runMotifTool('nope', {}, deps)).toThrow(/unhandled tool/)
  })
})
