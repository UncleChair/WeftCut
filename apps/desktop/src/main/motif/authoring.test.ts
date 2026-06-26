import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UserMotifStore } from './store'
import { composeMotifHtml, type Manifest } from '../../shared/motifs/catalog'
import { builtinMotifs, getMotifSource, motifToPayload, listMotifsInner, type BuiltinMotif } from './authoring'
import { motifContentHash } from './contentHash'

/** Minimal manifest factory mirroring authoring_commands.rs `m()`. */
function m(name: string, id = 'ignored'): Manifest {
  return { id, name, version: 1, size: [100, 100], default_duration_s: 1, fonts: [], props_schema: {} }
}
/** A composed full-source doc (island + body) for writing to disk. */
function doc(man: Manifest, body = 'x'): string {
  return composeMotifHtml(man, `<head></head><body>${body}<script>motif.define({setup(){}})</script></body>`)
}

let root: string
let store: UserMotifStore
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'motif-auth-')); store = new UserMotifStore(root) })

// A synthetic built-in (avoids depending on disk-relocated assets in this unit).
const BUILTINS: BuiltinMotif[] = [{ id: 'countdown', manifest: m('Countdown', 'countdown'), html: doc(m('Countdown', 'countdown'), 'CD') }]

describe('getMotifSource', () => {
  it('returns a built-in by id (built-in wins)', () => {
    const s = getMotifSource(store, BUILTINS, 'countdown')
    expect(s.manifest.id).toBe('countdown')
    expect(s.html).toContain('CD')
  })
  it('returns an installed user motif', () => {
    const man = m('Foo', 'foo')
    store.writeDraft('foo', doc(man, 'FOO')); store.installDraft('foo', 'foo')
    const s = getMotifSource(store, BUILTINS, 'foo')
    expect(s.manifest.id).toBe('foo'); expect(s.html).toContain('FOO')
  })
  it('throws on unknown id', () => {
    expect(() => getMotifSource(store, BUILTINS, 'nope')).toThrow(/unknown motif id/)
  })
})

describe('motifToPayload', () => {
  it('emits manifest fields + html + status + content_hash', () => {
    const man = m('Foo', 'foo')
    const html = doc(man, 'FOO')
    const p = motifToPayload(man, html, 'installed')
    expect(p.id).toBe('foo'); expect(p.name).toBe('Foo'); expect(p.status).toBe('installed')
    expect(p.html).toBe(html)
    expect(p.content_hash).toBe(motifContentHash(man, html)) // FULL html (island included)
  })
})

describe('listMotifsInner', () => {
  it('lists builtins, then installed, then drafts (id-unique, draft shadowed by published)', () => {
    // installed "foo"
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    // a separate draft "bar"
    store.writeDraft('bar', doc(m('Bar', 'bar')))
    const list = listMotifsInner(store, BUILTINS)
    const byId = (id: string) => list.find((e) => e.id === id)
    expect(byId('countdown')!.status).toBe('builtin')
    expect(byId('foo')!.status).toBe('installed')
    expect(byId('bar')!.status).toBe('draft')
    // every entry carries html + content_hash
    for (const e of list) { expect(typeof e.html).toBe('string'); expect(typeof e.content_hash).toBe('string') }
  })
  it('a draft sharing a published id is skipped (published wins)', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    store.writeDraft('foo', doc(m('Foo', 'foo'))) // a new draft re-using the published id
    const list = listMotifsInner(store, BUILTINS)
    expect(list.filter((e) => e.id === 'foo').length).toBe(1)
    expect(list.find((e) => e.id === 'foo')!.status).toBe('installed')
  })
  it('attaches target_id to a draft with a recorded Update target', () => {
    store.writeDraft('d1', doc(m('D1', 'd1'))); store.writeDraftTarget('d1', 'countdown')
    const list = listMotifsInner(store, BUILTINS)
    expect(list.find((e) => e.id === 'd1')!.target_id).toBe('countdown')
  })
})

describe('builtinMotifs', () => {
  it('loads {id, manifest, html} for each on-disk built-in', () => {
    // Build a fake builtin dir with one motif.
    const bdir = mkdtempSync(path.join(tmpdir(), 'motif-builtins-'))
    mkdirSync(path.join(bdir, 'countdown'), { recursive: true })
    writeFileSync(path.join(bdir, 'countdown', 'index.html'), doc(m('Countdown', 'countdown'), 'CD'))
    const got = builtinMotifs(bdir)
    const cd = got.find((b) => b.id === 'countdown')
    expect(cd).toBeDefined()
    expect(cd!.manifest.id).toBe('countdown') // manifest comes from BUILTIN_MANIFESTS, not the disk island
    expect(cd!.html).toContain('CD')
    rmSync(bdir, { recursive: true, force: true })
  })
})

import {
  writeMotifDraftCore, amendDraftHtml, createEditDraftCore, importMotifFromSource, deleteMotifCore,
} from './authoring'
import { BUILTIN_IDS } from '../../shared/motifs/catalog'

describe('writeMotifDraftCore', () => {
  it('mints a unique final-ready id, forces version 1, ignores claimed id', () => {
    const man = { ...m('Foo', 'claimed'), version: 9 }
    const id = writeMotifDraftCore(store, man, '<head></head><body>B<script>motif.define({setup(){}})</script></body>', null)
    expect(id).not.toBe('claimed')
    const d = store.getDraft(id)!
    expect(d.manifest.id).toBe(id); expect(d.manifest.version).toBe(1); expect(d.html).toContain('B')
  })
  it('records the Update target when `from` is provided', () => {
    const id = writeMotifDraftCore(store, m('Foo'), '<head></head><body>x</body>', 'countdown')
    expect(store.readDraftTarget(id)).toBe('countdown')
  })
  it('rejects an invalid manifest (zero size)', () => {
    expect(() => writeMotifDraftCore(store, { ...m('Bad'), size: [0, 0] }, '<body>x</body>', null)).toThrow()
  })
  it('draft id is unique vs published AND drafts', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    const id = writeMotifDraftCore(store, m('Foo'), '<head></head><body>x</body>', null)
    expect(id).not.toBe('foo'); expect(id).toBe('foo-2')
  })
})

describe('amendDraftHtml', () => {
  it('overwrites the SAME draft id and forces id back to the draft id', () => {
    store.writeDraft('d1', doc(m('Draft One', 'd1'), 'one'))
    const edited = doc({ ...m('Renamed', 'hacker') }, 'TWO')
    amendDraftHtml(store, 'd1', edited)
    expect(store.listDraftIds()).toEqual(['d1'])      // no new draft minted
    const got = store.getDraft('d1')!
    expect(got.manifest.id).toBe('d1')                // id forced back
    expect(got.html).toContain('TWO')                 // body persisted
  })
  it('rejects an unknown draft and an invalid manifest island', () => {
    expect(() => amendDraftHtml(store, 'nope', doc(m('X')))).toThrow(/unknown draft/)
    store.writeDraft('d1', doc(m('D', 'd1')))
    expect(() => amendDraftHtml(store, 'd1', doc({ ...m('D'), size: [0, 0] }))).toThrow()
  })
})

describe('createEditDraftCore', () => {
  it('seeds a unique id and records target for an INSTALLED source', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo'), 'FOO')); store.installDraft('foo', 'foo')
    const id = createEditDraftCore(store, BUILTINS, 'foo')
    expect(id).not.toBe('foo')
    const d = store.getDraft(id)!
    expect(d.html).toContain('FOO'); expect(d.manifest.id).toBe(id)
    expect(store.readDraftTarget(id)).toBe('foo')
  })
  it('records NO target for a built-in source; rejects unknown source', () => {
    const id = createEditDraftCore(store, BUILTINS, 'countdown')
    expect(store.getDraft(id)).not.toBeNull()
    expect(store.readDraftTarget(id)).toBeNull()
    expect(() => createEditDraftCore(store, BUILTINS, 'nope')).toThrow()
  })
})

describe('importMotifFromSource', () => {
  it('mints a fresh id, ignores the claimed id, records NO target', () => {
    const source = doc(m('Imported', 'countdown'), 'IMPORTED') // island claims a built-in id
    const id = importMotifFromSource(store, source)
    expect(id).not.toBe('countdown')
    const d = store.getDraft(id)!
    expect(d.manifest.id).toBe(id); expect(d.html).toContain('IMPORTED')
    expect(store.readDraftTarget(id)).toBeNull()
  })
  it('rejects a missing island and an invalid manifest', () => {
    expect(() => importMotifFromSource(store, '<html><body>no island</body></html>')).toThrow()
    expect(() => importMotifFromSource(store, doc({ ...m('Bad'), size: [0, 0] }))).toThrow()
  })
})

describe('deleteMotifCore', () => {
  it('deletes a published user motif', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    deleteMotifCore(store, 'foo')
    expect(store.getMotif('foo')).toBeNull()
  })
  it('rejects deleting a built-in', () => {
    expect(() => deleteMotifCore(store, BUILTIN_IDS[0])).toThrow(/cannot delete the built-in/)
  })
})

import { buildRebindUpdates, installMotifCompute, type MotifLayerRef } from './authoring'

describe('buildRebindUpdates', () => {
  it('retargets draft + target layers and lenient-migrates props', () => {
    const target: Manifest = {
      ...m('Foo', 'foo'), version: 2,
      props_schema: { title: { kind: 'String', default: 'Hi' } } as any,
    }
    const layers: MotifLayerRef[] = [
      { layerId: 'la', motifId: 'wip', version: 1, props: { old: 1 } },
      { layerId: 'lb', motifId: 'foo', version: 1, props: { old: 2 } },
      { layerId: 'lc', motifId: 'other', version: 1, props: {} }, // untouched
    ]
    const updates = buildRebindUpdates(layers, 'wip', target)
    expect(updates.length).toBe(2)
    for (const u of updates) {
      expect(u.motif_id).toBe('foo'); expect(u.motif_version).toBe(2)
      expect(u.props.old).toBeUndefined()      // dropped (lenient)
      expect(u.props.title).toBe('Hi')         // filled default
    }
  })
})

describe('installMotifCompute', () => {
  it('New mode: keeps the draft id, version 1, no updates', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo')))
    const r = installMotifCompute(store, [], { draft_id: 'foo', mode: { kind: 'new' } })
    expect(r.publishedId).toBe('foo'); expect(r.updates).toEqual([])
    expect(store.getMotif('foo')!.manifest.version).toBe(1)
  })
  it('New mode: rejects if a published Motif already took the id', () => {
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    store.writeDraft('foo', doc(m('Foo', 'foo'))) // a second draft re-using the id
    expect(() => installMotifCompute(store, [], { draft_id: 'foo', mode: { kind: 'new' } })).toThrow(/already installed/)
  })
  it('Update mode: bumps version, retargets layers from the working draft', () => {
    // publish target "foo" v1
    store.writeDraft('foo', doc(m('Foo', 'foo'))); store.installDraft('foo', 'foo')
    // a working draft "wip" targeting foo
    store.writeDraft('wip', doc(m('Foo', 'wip')))
    const layers: MotifLayerRef[] = [{ layerId: 'la', motifId: 'wip', version: 1, props: {} }]
    const r = installMotifCompute(store, layers, { draft_id: 'wip', mode: { kind: 'update', target_id: 'foo' } })
    expect(r.publishedId).toBe('foo')
    expect(store.getMotif('foo')!.manifest.version).toBe(2)
    expect(r.updates.length).toBe(1)
    expect(r.updates[0]).toMatchObject({ layer_id: 'la', motif_id: 'foo', motif_version: 2 })
  })
  it('Update mode: rejects a built-in target', () => {
    store.writeDraft('wip', doc(m('Foo', 'wip')))
    expect(() => installMotifCompute(store, [], { draft_id: 'wip', mode: { kind: 'update', target_id: 'countdown' } }))
      .toThrow(/cannot overwrite the built-in/)
  })
  it('rejects an unknown draft', () => {
    expect(() => installMotifCompute(store, [], { draft_id: 'ghost', mode: { kind: 'new' } })).toThrow(/unknown draft/)
  })
})
