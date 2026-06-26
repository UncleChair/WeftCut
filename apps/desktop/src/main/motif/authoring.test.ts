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
