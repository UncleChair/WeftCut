# Motifs → TypeScript migration — Phase 2 (catalog read + authoring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Motif catalog-read + authoring-lifecycle + `install_motif` logic from Rust into TypeScript, so the 8 read/authoring/lifecycle channels (and the 5 MCP motif tools) execute entirely in the TS main process, with the Rust authoring/`list_motifs` code becoming dead (deleted in Phase 4).

**Architecture:** Add pure cores to `src/main/motif/authoring.ts` (direct ports of `native/src/motifs/authoring_commands.rs` + `native/src/commands/motifs.rs`, sitting on the already-ported `store.ts` / `contentHash.ts` / `shared/motifs/catalog.ts`). Add a host-level dispatcher `src/main/motif/motifTools.ts` (`runMotifTool`) that both dispatch surfaces call: the renderer IPC path via a new `{kind:'motif'}` route in `routeChannel` → `ts-actor-host.handleInvoke`, and the MCP path via a new `'motif'` route in `routeMcpTool` → `server.ts` (wrapping the raw value into the Rust-faithful `ToolResult` shape). `install_motif` collapses from the Rust-compute hybrid to pure TS: read the live actor snapshot, publish via the store, build the rebind entries, and dispatch `rebind_motif`.

**Tech Stack:** TypeScript (electron-vite main bundle), Node `fs`/`crypto`, vitest, Playwright `_electron` e2e.

## Global Constraints

- **On-disk store layout at `<userData>/motifs/` is unchanged** — no migration step; existing user motifs/drafts keep working.
- **`content_hash` is sha256 (lowercase hex) over `coreManifestForHash(manifest) ‖ \0 ‖ html ‖ \0`** via the existing `motifContentHash` (`src/main/motif/contentHash.ts`). The `html` fed in is the **composed/stored full html (island included)** — never the stripped body — to match Rust `content_hash()` which hashed `self.html`. (Phase-1 carry-forward.)
- **The `motifs:changed` event name is stable** — do not rename. It is emitted to the renderer on every store-mutating op (write/amend/create_edit/import/install/delete).
- **Rust stays in place and compiles this phase** — no Rust files are edited or deleted. The Rust napi methods (`computeMotifRebind`, motif authoring commands, `list_motifs`) simply stop being called for these channels. Deletion is Phase 4.
- **Phase boundary:** `acknowledge_motif_staleness` (hybrid) and `motif_staleness_report` (mirror-backed read) are **NOT** in Phase 2 — they depend on the `staleness.ts` port (`currentVersions`/`buildAckEntries`/`buildStalenessReport`) which lands in Phase 3 with the Node watcher. They keep their current routing (`hybrid` / `rust`) untouched.
- **No new dependencies.** Pure functions stay Node-free where they already are (`shared/motifs/catalog.ts`); `crypto`/`fs` stay main-only.
- **Comment style:** follow `docs/comment-style.md` (evergreen, why-not-what, landmine exceptions). Cross-language twins (TS port ↔ the Rust source it mirrors) get a one-line pointer comment.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `apps/desktop/src/main/motif/authoring.ts` | Pure cores: `getMotifSource`, `writeMotifDraftCore`, `amendDraftHtml`, `createEditDraftCore`, `importMotifFromSource`, `deleteMotifCore`, `buildRebindUpdates`, `installMotifCompute`; catalog payload `motifToPayload`/`listMotifsInner`; `builtinMotifs(dir)` loader + `BuiltinMotif` type + `InstallArgs` type. No actor, no emit, no IPC. | Create |
| `apps/desktop/src/main/motif/authoring.test.ts` | Unit tests for every core (ports of the Rust `#[cfg(test)]` suites) + payload/list tests. | Create |
| `apps/desktop/src/main/motif/motifTools.ts` | Host-level dispatcher `runMotifTool(name, args, deps)` + `MotifToolDeps`. Wires cores to store/actor/emit; install reads layers + dispatches `rebind_motif`. Returns a RAW value. | Create |
| `apps/desktop/src/main/motif/motifTools.test.ts` | Dispatcher tests with a temp store + fake deps (renderer-nested + MCP-flat arg shapes). | Create |
| `apps/desktop/src/main/mcp/motifResult.ts` | `shapeMotifMcpResult(name, raw)` → Rust-faithful `ToolResultJson` for the 5 MCP motif tools. | Create |
| `apps/desktop/src/main/mcp/motifResult.test.ts` | Shaper unit test (html-strip, json/text/empty shapes). | Create |
| `apps/desktop/src/main/mcp/mutationTools.ts` | Add `MOTIF_TOOLS` set; `routeMcpTool` returns `'motif'` for them; remove `install_motif` from `HYBRID_TOOLS`. | Modify |
| `apps/desktop/src/main/mcp/server.ts` | Dispatch `route === 'motif'` → `tsHost.motifTool(name, args)` → `shapeMotifMcpResult`. | Modify |
| `apps/desktop/src/main/mcp/mcpRouter.test.ts` | Update route expectations (motif tools → `'motif'`); keep bijection green. | Modify |
| `apps/desktop/src/main/state/router.ts` | Add `MOTIF_CHANNELS` set + `{kind:'motif';tool}` route; remove the 7 from `PURE_NATIVE` + `install_motif` from `HYBRID_CHANNELS`. | Modify |
| `apps/desktop/src/main/state/router.test.ts` | Update the partition gate + route expectations for the `'motif'` route. | Modify |
| `apps/desktop/src/main/state/ts-actor-host.ts` | Build `motifToolDeps`; handle `case 'motif'` in `handleInvoke`; expose `motifTool` host method; add `motifStore`/`motifBuiltins` to `TsActorHostDeps`. | Modify |
| `apps/desktop/src/main/state/ts-actor-host.test.ts` | Tests for the `'motif'` route + `motifTool` method (in-memory store + fs adapter). | Modify |
| `apps/desktop/src/main/index.ts` | Pass `motifStore` + `motifBuiltins` into `createTsActorHost`. | Modify |

---

## Interfaces (shared across tasks)

These names/types are produced in Tasks 1–3 and consumed in Tasks 4–6. The implementer of a later task sees only their own task — this block is the contract.

```ts
// authoring.ts (Tasks 1–3)
import type { Manifest } from '../../shared/motifs/catalog'
import type { MotifRebindEntry } from '../state/model'

export interface BuiltinMotif { id: string; manifest: Manifest; html: string }
export interface MotifSourceTs { manifest: Manifest; html: string }
export type InstallArgs = { draft_id: string; mode: { kind: 'new' } | { kind: 'update'; target_id: string } }
/** One motif layer extracted from the actor snapshot (install/rebind input). */
export interface MotifLayerRef { layerId: string; motifId: string; props: Record<string, unknown> }

export function builtinMotifs(builtinDir: string): BuiltinMotif[]
export function getMotifSource(store: UserMotifStore, builtins: BuiltinMotif[], id: string): MotifSourceTs
export function motifToPayload(manifest: Manifest, html: string, status: string): Record<string, unknown>
export function listMotifsInner(store: UserMotifStore, builtins: BuiltinMotif[]): Record<string, unknown>[]
export function writeMotifDraftCore(store: UserMotifStore, manifest: Manifest, html: string, from: string | null): string
export function amendDraftHtml(store: UserMotifStore, draftId: string, source: string): void
export function createEditDraftCore(store: UserMotifStore, builtins: BuiltinMotif[], sourceId: string): string
export function importMotifFromSource(store: UserMotifStore, source: string): string
export function deleteMotifCore(store: UserMotifStore, id: string): void
export function buildRebindUpdates(layers: MotifLayerRef[], workingId: string, target: Manifest): MotifRebindEntry[]
export function installMotifCompute(store: UserMotifStore, motifLayers: MotifLayerRef[], args: InstallArgs): { publishedId: string; updates: MotifRebindEntry[] }

// motifTools.ts (Task 4)
export interface MotifToolDeps {
  store: UserMotifStore
  builtins: BuiltinMotif[]
  motifLayers: () => MotifLayerRef[]
  dispatchRebind: (updates: MotifRebindEntry[]) => void  // throws on a rejected actor write
  emitChanged: () => void                                // send('motifs:changed', {})
  refreshCatalog: () => void                             // re-pull list_motifs → actor.setUserMotifManifests
  readFile: (p: string) => string                        // node:fs readFileSync utf8 (import_motif)
}
export function runMotifTool(name: string, rawArgs: Record<string, unknown>, deps: MotifToolDeps): unknown

// motifResult.ts (Task 5)
export function shapeMotifMcpResult(name: string, raw: unknown): ToolResultJson
```

---

## Task 1: Read path — `builtinMotifs`, `getMotifSource`, `motifToPayload`, `listMotifsInner`

**Files:**
- Create: `apps/desktop/src/main/motif/authoring.ts`
- Test: `apps/desktop/src/main/motif/authoring.test.ts`

**Interfaces:**
- Consumes: `UserMotifStore` (`store.ts`: `getMotif`/`readHtml`/`listManifests`/`listDrafts`/`listDraftIds`/`readDraftTarget`), `motifContentHash` (`contentHash.ts`), `BUILTIN_IDS`/`BUILTIN_MANIFESTS`/`Manifest` (`shared/motifs/catalog.ts`).
- Produces: `BuiltinMotif`, `MotifSourceTs`, `builtinMotifs`, `getMotifSource`, `motifToPayload`, `listMotifsInner`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/motif/authoring.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/motif/authoring.test.ts`
Expected: FAIL — `Cannot find module './authoring'` / exports undefined.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/main/motif/authoring.ts` (read path only — the rest lands in Tasks 2–3):

```ts
// apps/desktop/src/main/motif/authoring.ts
//
// TS port of the Motif authoring lifecycle + catalog payload. Mirrors
// native/src/motifs/authoring_commands.rs and native/src/commands/motifs.rs.
// Pure: no actor, no IPC, no event emit — the host dispatcher (motifTools.ts)
// wraps these with the store/actor/emit. Cross-language twin: keep in sync with
// the Rust source until Phase 4 deletes it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BUILTIN_IDS, BUILTIN_MANIFESTS, type Manifest,
} from '../../shared/motifs/catalog'
import { motifContentHash } from './contentHash'
import type { UserMotifStore } from './store'

export interface BuiltinMotif { id: string; manifest: Manifest; html: string }
export interface MotifSourceTs { manifest: Manifest; html: string }

/** Load each built-in's {id, manifest, html}. Manifest comes from the bundled
 *  BUILTIN_MANIFESTS (authoritative); html is read from `<builtinDir>/<id>/index.html`
 *  (the relocated served assets — Phase 1). `builtinDir` is passed explicitly
 *  (host computes via builtinAssetDir(); tests pass a fixture dir) so this is
 *  hermetic. A built-in whose html can't be read is skipped (defensive). */
export function builtinMotifs(builtinDir: string): BuiltinMotif[] {
  const out: BuiltinMotif[] = []
  for (const id of BUILTIN_IDS) {
    const manifest = BUILTIN_MANIFESTS.get(id)
    if (!manifest) continue
    let html: string
    try { html = readFileSync(path.join(builtinDir, id, 'index.html'), 'utf8') } catch { continue }
    out.push({ id, manifest, html })
  }
  return out
}

/** Read any built-in or user Motif's source. Built-ins win. Mirrors
 *  `get_motif_source_core`. */
export function getMotifSource(store: UserMotifStore, builtins: BuiltinMotif[], id: string): MotifSourceTs {
  const b = builtins.find((x) => x.id === id)
  if (b) return { manifest: b.manifest, html: b.html }
  const m = store.getMotif(id)
  if (m) return { manifest: m.manifest, html: m.html }
  throw new Error(`unknown motif id '${id}'`)
}

/** Serialize manifest + raw html into the picker payload (superset of MCP
 *  list_motifs: every manifest field + html + status + content_hash). One helper
 *  so built-in/installed/draft emit the same shape. Mirrors `motif_to_payload`.
 *  `html` MUST be the composed/stored FULL html (island included) so content_hash
 *  matches Rust's `self.html` hash. */
export function motifToPayload(manifest: Manifest, html: string, status: string): Record<string, unknown> {
  const content_hash = motifContentHash(manifest, html)
  return { ...manifest, html, status, content_hash }
}

/** UI catalog: builtins, then installed, then drafts (id-unique; a draft whose id
 *  is already published/built-in is skipped — published wins, matching read_file).
 *  A draft with a recorded Update target carries `target_id`. Mirrors
 *  `list_motifs_inner`. */
export function listMotifsInner(store: UserMotifStore, builtins: BuiltinMotif[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const b of builtins) out.push(motifToPayload(b.manifest, b.html, 'builtin'))
  for (const manifest of store.listManifests()) {
    // list_manifests already confirmed the island parsed; re-read html for the
    // payload. readHtml may return null on a TOCTOU (file vanished) — blank card
    // rather than failing the whole list.
    const html = store.readHtml(manifest.id) ?? ''
    out.push(motifToPayload(manifest, html, 'installed'))
  }
  const seen = new Set(out.map((e) => e.id as string))
  for (const draft of store.listDrafts()) {
    const draftId = draft.manifest.id
    if (seen.has(draftId)) continue
    const entry = motifToPayload(draft.manifest, draft.html, 'draft')
    const target = store.readDraftTarget(draftId)
    if (target) entry.target_id = target
    out.push(entry)
  }
  return out
}
```

> **Note on draft id:** Rust `list_motifs_inner` uses `draft.id()` (the manifest id parsed from the draft's island). The TS `store.listDrafts()` returns `MotifSource` whose `manifest.id` is the parsed island id, so `draft.manifest.id` is the correct key — matching Rust.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/motif/authoring.test.ts`
Expected: PASS (all `describe` blocks green).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/motif/authoring.ts apps/desktop/src/main/motif/authoring.test.ts
git commit -m "feat(motifs): TS catalog read path (builtinMotifs/getMotifSource/listMotifsInner)"
```

---

## Task 2: Authoring cores — write / amend / create-edit / import / delete

**Files:**
- Modify: `apps/desktop/src/main/motif/authoring.ts`
- Test: `apps/desktop/src/main/motif/authoring.test.ts` (append)

**Interfaces:**
- Consumes: `UserMotifStore` (`writeDraft`/`writeDraftTarget`/`getDraft`/`getMotif`/`publishedIds`/`listDraftIds`/`deleteUserMotif`/`readDraftTarget`), `parseManifestIsland`/`composeMotifHtml`/`validateManifest`/`assignUniqueId`/`BUILTIN_IDS` (`shared/motifs/catalog.ts`), `BuiltinMotif` (Task 1).
- Produces: `writeMotifDraftCore`, `amendDraftHtml`, `createEditDraftCore`, `importMotifFromSource`, `deleteMotifCore`.

- [ ] **Step 1: Write the failing test** (append to `authoring.test.ts`)

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/motif/authoring.test.ts`
Expected: FAIL — new exports undefined.

- [ ] **Step 3: Write minimal implementation** (append to `authoring.ts`, after the read-path functions; add the imports to the existing import block)

Add to the `shared/motifs/catalog` import: `parseManifestIsland, composeMotifHtml, validateManifest, assignUniqueId`.

```ts
/** Final-ready unique id minted vs published ∪ drafts. The id a draft is born
 *  with is the one it keeps when published (install-New needs no rebind). */
function takenIds(store: UserMotifStore): string[] {
  return [...store.publishedIds(), ...store.listDraftIds()]
}

/** Validate + mint id + compose + write the draft. Identity is app-owned: id is
 *  minted from the name and version forced to 1 (any id/version in `manifest` is
 *  ignored). `from` (when set) is recorded as the draft's Update target. Mirrors
 *  `write_motif_draft_core`. */
export function writeMotifDraftCore(store: UserMotifStore, manifest: Manifest, html: string, from: string | null): string {
  validateManifest(manifest)
  const draftId = assignUniqueId(manifest.name, takenIds(store))
  const finalManifest: Manifest = { ...manifest, id: draftId, version: 1 }
  store.writeDraft(draftId, composeMotifHtml(finalManifest, html))
  if (from) store.writeDraftTarget(draftId, from)
  return draftId
}

/** Parse the island out of an edited full-source doc, force the draft's stable
 *  identity (id + version 1), re-validate, overwrite the SAME draft. Amend never
 *  CREATES. Mirrors `amend_draft_html`. */
export function amendDraftHtml(store: UserMotifStore, draftId: string, source: string): void {
  if (store.getDraft(draftId) === null) throw new Error(`unknown draft '${draftId}'`)
  const parsed = parseManifestIsland(source)
  const manifest: Manifest = { ...parsed, id: draftId, version: 1 }
  validateManifest(manifest)
  // compose strips the edited island + re-injects a canonical one; body round-trips.
  store.writeDraft(draftId, composeMotifHtml(manifest, source))
}

/** Seed a NEW working draft from a built-in or installed source; for an INSTALLED
 *  source, record it as the draft's Update target (built-ins can't update in place,
 *  so a built-in fork records no target). Mirrors `create_edit_draft_core`. */
export function createEditDraftCore(store: UserMotifStore, builtins: BuiltinMotif[], sourceId: string): string {
  const isBuiltin = BUILTIN_IDS.includes(sourceId)
  const source = getMotifSourceOrNull(store, builtins, sourceId)
  if (!source) throw new Error(`unknown source motif '${sourceId}'`)
  const draftId = assignUniqueId(source.manifest.name, takenIds(store))
  const manifest: Manifest = { ...source.manifest, id: draftId, version: 1 }
  store.writeDraft(draftId, composeMotifHtml(manifest, source.html))
  if (!isBuiltin) store.writeDraftTarget(draftId, sourceId)
  return draftId
}

/** Non-throwing source lookup (built-in first, then installed). */
function getMotifSourceOrNull(store: UserMotifStore, builtins: BuiltinMotif[], id: string): MotifSourceTs | null {
  const b = builtins.find((x) => x.id === id)
  if (b) return { manifest: b.manifest, html: b.html }
  return store.getMotif(id)
}

/** Parse + validate the island from an external .html, mint a FRESH unique id
 *  (ignoring any claimed id/version), write as a from-scratch draft (no target →
 *  installs as new). Mirrors `import_motif_from_source`. */
export function importMotifFromSource(store: UserMotifStore, source: string): string {
  const parsed = parseManifestIsland(source)
  const draftId = assignUniqueId(parsed.name, takenIds(store))
  const manifest: Manifest = { ...parsed, id: draftId, version: 1 }
  validateManifest(manifest)
  store.writeDraft(draftId, composeMotifHtml(manifest, source))
  return draftId
}

/** Delete a published user Motif (built-ins rejected). Mirrors `delete_motif_core`. */
export function deleteMotifCore(store: UserMotifStore, id: string): void {
  if (BUILTIN_IDS.includes(id)) throw new Error(`cannot delete the built-in Motif '${id}'`)
  store.deleteUserMotif(id)
}
```

> **Validation parity note:** Rust deserializes the MCP `write_motif_draft` manifest via serde before `validate_manifest`; TS consumes the manifest object as-is and relies on `validateManifest` as the rejection gate. Malformed-manifest error *messages* are reasonable-but-ungated (not in the differential corpus); structural rejection still occurs (empty name / size bounds / non-finite durations / per-prop default checks).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/motif/authoring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/motif/authoring.ts apps/desktop/src/main/motif/authoring.test.ts
git commit -m "feat(motifs): TS authoring cores (write/amend/create-edit/import/delete)"
```

---

## Task 3: Install compute — `buildRebindUpdates` + `installMotifCompute`

**Files:**
- Modify: `apps/desktop/src/main/motif/authoring.ts`
- Test: `apps/desktop/src/main/motif/authoring.test.ts` (append)

**Interfaces:**
- Consumes: `UserMotifStore` (`getDraft`/`getMotif`/`publishedIds`/`writeDraft`/`installDraft`), `validateManifest`/`composeMotifHtml`/`canonicalizePropsLenient`/`BUILTIN_IDS` (`shared/motifs/catalog.ts`), `MotifRebindEntry` (`state/model.ts`).
- Produces: `InstallArgs`, `MotifLayerRef`, `buildRebindUpdates`, `installMotifCompute`.

- [ ] **Step 1: Write the failing test** (append to `authoring.test.ts`)

```ts
import { buildRebindUpdates, installMotifCompute, type MotifLayerRef, type InstallArgs } from './authoring'

describe('buildRebindUpdates', () => {
  it('retargets draft + target layers and lenient-migrates props', () => {
    const target: Manifest = {
      ...m('Foo', 'foo'), version: 2,
      props_schema: { title: { kind: 'String', default: 'Hi' } } as any,
    }
    const layers: MotifLayerRef[] = [
      { layerId: 'la', motifId: 'wip', props: { old: 1 } },
      { layerId: 'lb', motifId: 'foo', props: { old: 2 } },
      { layerId: 'lc', motifId: 'other', props: {} }, // untouched
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
    const layers: MotifLayerRef[] = [{ layerId: 'la', motifId: 'wip', props: {} }]
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/motif/authoring.test.ts`
Expected: FAIL — `buildRebindUpdates`/`installMotifCompute` undefined.

- [ ] **Step 3: Write minimal implementation** (append to `authoring.ts`; add `canonicalizePropsLenient` to the catalog import and `import type { MotifRebindEntry } from '../state/model'`)

```ts
export interface MotifLayerRef { layerId: string; motifId: string; props: Record<string, unknown> }
export type InstallArgs = { draft_id: string; mode: { kind: 'new' } | { kind: 'update'; target_id: string } }

/** Per-layer rebind updates for an Update: every layer whose motif_id is the
 *  working draft id OR the target id ends up on the target id, at the new version,
 *  with props lenient-migrated to the new schema (drop unknown, fill new defaults,
 *  fall back invalid values). Pure. Mirrors `build_rebind_updates`. */
export function buildRebindUpdates(layers: MotifLayerRef[], workingId: string, target: Manifest): MotifRebindEntry[] {
  return layers
    .filter((l) => l.motifId === workingId || l.motifId === target.id)
    .map((l) => ({
      layer_id: l.layerId,
      motif_id: target.id,
      motif_version: target.version,
      props: canonicalizePropsLenient(target, l.props),
    }))
}

/** Publish the draft (store side) + (Update) build rebind updates from the
 *  caller-supplied motif layers; returns `{ publishedId, updates }`. New mode →
 *  empty updates. Does NOT write the actor (the host dispatches rebind_motif).
 *  Mirrors `install_motif_compute`. */
export function installMotifCompute(
  store: UserMotifStore,
  motifLayers: MotifLayerRef[],
  args: InstallArgs,
): { publishedId: string; updates: MotifRebindEntry[] } {
  const draft = store.getDraft(args.draft_id)
  if (!draft) throw new Error(`unknown draft '${args.draft_id}'`)
  // Re-validate at the install gate (the on-disk draft could have been hand-edited).
  validateManifest(draft.manifest)

  let isUpdate = false
  let finalId: string
  let version: number
  if (args.mode.kind === 'new') {
    // Draft id was made final-ready at write time; keep it (placed layers need no
    // rebind). Guard the rare race where a published Motif took the id since.
    const id = draft.manifest.id
    if (store.publishedIds().includes(id))
      throw new Error(`a Motif '${id}' is already installed; rename the draft before installing`)
    finalId = id; version = 1
  } else {
    const targetId = args.mode.target_id
    if (BUILTIN_IDS.includes(targetId)) throw new Error(`cannot overwrite the built-in Motif '${targetId}'`)
    const prev = store.getMotif(targetId)
    if (!prev) throw new Error(`update target '${targetId}' is not an installed Motif`)
    isUpdate = true
    finalId = targetId; version = prev.manifest.version + 1 // bump → frame cache invalidates
  }

  const manifest: Manifest = { ...draft.manifest, id: finalId, version }
  const html = composeMotifHtml(manifest, draft.html)
  // Rewrite the draft's island to the final id + bumped version, THEN move it into
  // the published slot. Order matters: if installDraft fails, only the DRAFT is
  // dirty; a retry re-derives the same final_id and re-runs both steps safely.
  store.writeDraft(args.draft_id, html)
  store.installDraft(args.draft_id, finalId)

  let updates: MotifRebindEntry[] = []
  if (isUpdate) {
    const target = store.getMotif(finalId)
    if (!target) throw new Error(`installed target '${finalId}' not readable`)
    updates = buildRebindUpdates(motifLayers, args.draft_id, target.manifest)
  }
  return { publishedId: finalId, updates }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/motif/authoring.test.ts`
Expected: PASS (all Task 1–3 blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/motif/authoring.ts apps/desktop/src/main/motif/authoring.test.ts
git commit -m "feat(motifs): TS install compute (buildRebindUpdates/installMotifCompute)"
```

---

## Task 4: Host dispatcher — `motifTools.ts` (`runMotifTool`)

**Files:**
- Create: `apps/desktop/src/main/motif/motifTools.ts`
- Test: `apps/desktop/src/main/motif/motifTools.test.ts`

**Interfaces:**
- Consumes: every Task 1–3 core; `UserMotifStore`; `Manifest`/`MotifRebindEntry`.
- Produces: `MotifToolDeps`, `runMotifTool`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/motif/motifTools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/motif/motifTools.test.ts`
Expected: FAIL — `Cannot find module './motifTools'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/main/motif/motifTools.ts`:

```ts
// apps/desktop/src/main/motif/motifTools.ts
//
// Host-level Motif tool dispatcher. Both surfaces call this: the renderer IPC
// path (ts-actor-host.handleInvoke `case 'motif'`) and the MCP path (server.ts
// `route === 'motif'`). Returns a RAW value (array | object | id string | null);
// the MCP caller wraps it via shapeMotifMcpResult, the renderer returns it as-is.
// Replaces the Rust authoring commands + compute_motif_rebind hybrid for these
// channels. Mirrors native/src/commands/motif_authoring.rs (the emit + actor wrap).
import type { Manifest } from '../../shared/motifs/catalog'
import type { MotifRebindEntry } from '../state/model'
import type { UserMotifStore } from './store'
import {
  type BuiltinMotif, type MotifLayerRef, type InstallArgs,
  getMotifSource, listMotifsInner, writeMotifDraftCore, amendDraftHtml,
  createEditDraftCore, importMotifFromSource, deleteMotifCore, installMotifCompute,
} from './authoring'

export interface MotifToolDeps {
  store: UserMotifStore
  builtins: BuiltinMotif[]
  /** Motif layers from the live actor snapshot (install Update rebind input). */
  motifLayers: () => MotifLayerRef[]
  /** Apply rebind_motif through the actor; throws on a rejected write. */
  dispatchRebind: (updates: MotifRebindEntry[]) => void
  /** Emit `motifs:changed` to the renderer (picker re-pull + host buster). */
  emitChanged: () => void
  /** Re-pull list_motifs → actor.setUserMotifManifests (content-window clamp). */
  refreshCatalog: () => void
  /** node:fs readFileSync(utf8) — import_motif reads an external .html. */
  readFile: (p: string) => string
}

/** Coerce the install `mode` arg. Renderer sends the object form
 *  `{ kind, target_id? }`; the MCP schema advertises a bare string "new"/"update"
 *  (the historical hybrid contract). "new" coerces; "update" as a bare string has
 *  no target_id and is rejected by installMotifCompute downstream — preserving the
 *  pre-existing inability to MCP-update without a target. */
function parseMode(mode: unknown): InstallArgs['mode'] {
  if (mode === 'new') return { kind: 'new' }
  if (mode === 'update') return { kind: 'update', target_id: '' } // no target → compute rejects
  return mode as InstallArgs['mode']
}

export function runMotifTool(name: string, rawArgs: Record<string, unknown>, deps: MotifToolDeps): unknown {
  // Renderer write/install nest under `args`; everything else is flat. MCP is flat.
  const a = (rawArgs.args ?? rawArgs) as Record<string, unknown>
  switch (name) {
    case 'list_motifs':
      return listMotifsInner(deps.store, deps.builtins)
    case 'get_motif_source':
      return getMotifSource(deps.store, deps.builtins, a.id as string)
    case 'write_motif_draft': {
      const id = writeMotifDraftCore(deps.store, a.manifest as Manifest, a.html as string, (a.from as string | undefined) ?? null)
      deps.emitChanged(); deps.refreshCatalog()
      return id
    }
    case 'amend_motif_draft': {
      // Renderer arg shape: { draftId, source } (camelCase, flat).
      amendDraftHtml(deps.store, a.draftId as string, a.source as string)
      deps.emitChanged(); deps.refreshCatalog()
      return null
    }
    case 'create_edit_draft': {
      const id = createEditDraftCore(deps.store, deps.builtins, a.sourceId as string)
      deps.emitChanged(); deps.refreshCatalog()
      return id
    }
    case 'import_motif': {
      const id = importMotifFromSource(deps.store, deps.readFile(a.path as string))
      deps.emitChanged(); deps.refreshCatalog()
      return id
    }
    case 'delete_motif': {
      deleteMotifCore(deps.store, a.id as string)
      deps.emitChanged(); deps.refreshCatalog()
      return null
    }
    case 'install_motif': {
      const args: InstallArgs = { draft_id: a.draft_id as string, mode: parseMode(a.mode) }
      const { publishedId, updates } = installMotifCompute(deps.store, deps.motifLayers(), args)
      if (updates.length) deps.dispatchRebind(updates)
      deps.emitChanged(); deps.refreshCatalog()
      return publishedId
    }
    default:
      throw new Error(`runMotifTool: unhandled tool ${name}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/motif/motifTools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/motif/motifTools.ts apps/desktop/src/main/motif/motifTools.test.ts
git commit -m "feat(motifs): host-level runMotifTool dispatcher"
```

---

## Task 5: MCP wiring — `'motif'` route + result shaping

**Files:**
- Create: `apps/desktop/src/main/mcp/motifResult.ts`, `apps/desktop/src/main/mcp/motifResult.test.ts`
- Modify: `apps/desktop/src/main/mcp/mutationTools.ts`, `apps/desktop/src/main/mcp/server.ts`, `apps/desktop/src/main/mcp/mcpRouter.test.ts`

**Interfaces:**
- Consumes: `toolJson`/`toolText`/`toolEmpty`/`ToolResultJson` (`state/mcp-commands.ts`); `tsHost.motifTool` (added in Task 6 — server.ts calls it but the method is added to the host interface in Task 6; until then server.ts type-checks against the interface declared here).
- Produces: `MOTIF_TOOLS`, `McpRoute` widened to include `'motif'`, `shapeMotifMcpResult`.

> **Ordering note:** This task adds the MCP-side `'motif'` route and references `tsHost.motifTool`. Task 6 adds `motifTool` to the `TsActorHost` interface + implementation. To keep each task independently compilable, **add the `motifTool` field to the `TsActorHost` interface in this task** (declaration only) and implement it in Task 6. The declaration: `motifTool: (name: string, args: Record<string, unknown>) => unknown`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/mcp/motifResult.test.ts`:

```ts
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
    expect(JSON.parse(r.content[0].text)).toEqual({ manifest: { id: 'a' }, html: '<x>' })
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
```

Then update `apps/desktop/src/main/mcp/mcpRouter.test.ts` — replace the `list_motifs`/`get_motif_source`/`install_motif` expectations:

```ts
// in the "routes import_media + apply_subtitles + ... to the hybrid" test:
// DELETE the install_motif line; install_motif now routes to 'motif'.
// KEEP acknowledge_motif_staleness as 'hybrid' (Phase 3).

// REPLACE the "routes reads ... to rust" test body's motif entries:
it('routes the 5 MCP motif tools to the motif route (Phase 2)', () => {
  for (const t of ['list_motifs', 'get_motif_source', 'write_motif_draft', 'delete_motif', 'install_motif'])
    expect(routeMcpTool(t), t).toBe('motif')
})
it('preview_motif_draft stays rust (special-cased capture in server.ts)', () => {
  expect(routeMcpTool('preview_motif_draft')).toBe('rust')
})
```

And in the bijection sub-test's `routeMcpTool` switch (the `it('no advertised-but-unhandled...')` block), add a `motif` no-op clause analogous to the existing ones (a `'motif'` route requires the name be advertised — which it is, from `rust4a`):

```ts
for (const t of merged) {
  const r = routeMcpTool(t.name)
  if (r === 'ts') expect(MCP_TOOLS.has(t.name)).toBe(true)
  if (r === 'hybrid') expect(HYBRID_TOOLS.has(t.name)).toBe(true)
  if (r === 'motif') expect(MOTIF_TOOLS.has(t.name)).toBe(true)
}
```

(Import `MOTIF_TOOLS` from `./mutationTools` at the top of the test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/mcp/motifResult.test.ts src/main/mcp/mcpRouter.test.ts`
Expected: FAIL — `motifResult` missing; `routeMcpTool` returns `'rust'`/`'hybrid'` not `'motif'`; `MOTIF_TOOLS` undefined.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/main/mcp/motifResult.ts`:

```ts
// apps/desktop/src/main/mcp/motifResult.ts
// Shape a runMotifTool raw value into the Rust-faithful MCP ToolResult for the
// 5 advertised motif tools. Mirrors the Rust handlers in native/src/mcp/tools.rs:
//   list_motifs    → json(payload with `html` removed)
//   get_motif_source → json({manifest, html})
//   write_motif_draft → text(id)
//   install_motif  → text(published_id)
//   delete_motif   → empty
import { toolJson, toolText, toolEmpty, type ToolResultJson } from '../state/mcp-commands.js'

export function shapeMotifMcpResult(name: string, raw: unknown): ToolResultJson {
  switch (name) {
    case 'list_motifs': {
      const stripped = (raw as Array<Record<string, unknown>>).map((e) => {
        const { html: _html, ...rest } = e
        return rest
      })
      return toolJson(stripped)
    }
    case 'get_motif_source':
      return toolJson(raw)
    case 'write_motif_draft':
    case 'install_motif':
      return toolText(raw as string)
    case 'delete_motif':
      return toolEmpty()
    default:
      throw new Error(`shapeMotifMcpResult: unhandled tool ${name}`)
  }
}
```

Modify `apps/desktop/src/main/mcp/mutationTools.ts`:

```ts
import { MCP_TOOLS } from '../state/mcp-commands.js'

export type McpRoute = 'ts' | 'rust' | 'hybrid' | 'motif'

/** MCP tools served by the native-compute → TS-write hybrid orchestrator. */
export const HYBRID_TOOLS: ReadonlySet<string> = new Set([
  'import_media', 'apply_subtitles',
  'acknowledge_motif_staleness',   // install_motif moved to the 'motif' route (Phase 2)
  'synthesize_speech',
])

/** Motif catalog-read + authoring + install tools, served in TS by runMotifTool
 *  (Phase 2). Their defs stay Rust-advertised this phase (mergeMcpCatalog keeps
 *  non-'ts' routes); Phase 4 moves the defs to TS and deletes the Rust arms. */
export const MOTIF_TOOLS: ReadonlySet<string> = new Set([
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'delete_motif', 'install_motif',
])

/** Where an MCP tool runs. motif → tsHost.motifTool (then shapeMotifMcpResult);
 *  hybrid → runHybrid; ts → tsHost.actor.mcpCall; rust → backend.
 *  motif-first so install_motif can never both hybrid and motif-route. */
export function routeMcpTool(name: string): McpRoute {
  if (MOTIF_TOOLS.has(name)) return 'motif'
  if (HYBRID_TOOLS.has(name)) return 'hybrid'
  if (MCP_TOOLS.has(name)) return 'ts'
  return 'rust'
}
```

Modify `apps/desktop/src/main/mcp/server.ts` — add the `'motif'` branch inside the `if (tsHost) { ... }` block, after the `hybrid` branch, before the `rust` fall-through comment, and import the shaper:

```ts
import { shapeMotifMcpResult } from './motifResult.js'
```

```ts
    if (route === 'hybrid') {
      const result = await runHybrid(name, args, tsHost.hybridDeps)
      return { content: [{ type: 'text', text: String(result) }] } as unknown as ServerResult
    }
    if (route === 'motif') {
      // Catalog-read + authoring + install, served in TS (Phase 2). The raw value
      // is shaped to the Rust-faithful ToolResult (list_motifs strips html, etc.).
      const raw = tsHost.motifTool(name, args)
      return shapeMotifMcpResult(name, raw) as unknown as ServerResult
    }
    // route === 'rust' → fall through (reads are mirror-backed).
```

Add the `motifTool` declaration to the `TsActorHost` interface in `apps/desktop/src/main/state/ts-actor-host.ts` (declaration only — implementation lands in Task 6):

```ts
  /** Host-level Motif tool dispatch (catalog read + authoring + install). Both
   *  the renderer `handleInvoke('motif')` and the MCP `route==='motif'` path use it. */
  motifTool: (name: string, args: Record<string, unknown>) => unknown
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/mcp/motifResult.test.ts src/main/mcp/mcpRouter.test.ts src/main/state/__tests__/mcp.catalog-bijection.test.ts`
Expected: PASS — including the bijection gate (motif tools stay in `nativeNames`, merged set unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/mcp/motifResult.ts apps/desktop/src/main/mcp/motifResult.test.ts apps/desktop/src/main/mcp/mutationTools.ts apps/desktop/src/main/mcp/server.ts apps/desktop/src/main/mcp/mcpRouter.test.ts apps/desktop/src/main/state/ts-actor-host.ts
git commit -m "feat(motifs): MCP 'motif' route + Rust-faithful result shaping"
```

---

## Task 6: Renderer wiring — `{kind:'motif'}` route + host `motifTool` + index.ts

**Files:**
- Modify: `apps/desktop/src/main/state/router.ts`, `apps/desktop/src/main/state/router.test.ts`, `apps/desktop/src/main/state/ts-actor-host.ts`, `apps/desktop/src/main/state/ts-actor-host.test.ts`, `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: `runMotifTool`/`MotifToolDeps` (Task 4); `builtinMotifs` (Task 1); `UserMotifStore`; `MotifParams`/`MotifRebindEntry` (`state/model.ts`).
- Produces: the renderer `'motif'` route; `tsHost.motifTool`; `TsActorHostDeps.motifStore`/`motifBuiltins`.

- [ ] **Step 1: Write the failing test**

Update `apps/desktop/src/main/state/router.test.ts`:

```ts
import {
  routeChannel,
  HYBRID_CHANNELS, MIRROR_BACKED_READS, PURE_NATIVE, PERSISTENCE, MOTIF_CHANNELS,
} from './router'
```

In `ALL_CHANNELS`, move the 7 motif authoring/read channels out of the "pure native" comment group into a new "motif route" group (the names stay in the array — only the comment changes; `install_motif` stays listed too):

```ts
  // motif route (TS authoring + read + install — Phase 2)
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'amend_motif_draft',
  'create_edit_draft', 'import_motif', 'delete_motif', 'install_motif',
  // pure native (no project actor)
  'ping', 'mux_export', 'export_video_sink_start', 'export_video_sink_finish',
  'export_video_sink_cancel', 'import_cancel', 'import_queue_list', 'report_audio_meter',
  'settings_get_api_key_status', 'settings_test_provider',
  // hybrids (native-compute → TS-write)
  'import_media', 'acknowledge_motif_staleness',
```

Update the partition gate's hybrid assertion (the `for (const ch of ['import_media', 'install_motif', 'acknowledge_motif_staleness'])` loop) to drop `install_motif`, and add a motif-route assertion:

```ts
    for (const ch of ['import_media', 'acknowledge_motif_staleness'])
      expect(routeChannel(ch).kind, ch).toBe('hybrid')
    for (const ch of MOTIF_CHANNELS)
      expect(routeChannel(ch).kind, ch).toBe('motif')
```

In the disjointness test add `['MOTIF_CHANNELS', MOTIF_CHANNELS]` to the `buckets` array.

In `describe('routeChannel')`: remove `'list_motifs'` from the "forwards ... to rust" list (line ~114); in "routes the three hybrid channels to hybrid" change to two channels (`import_media`, `acknowledge_motif_staleness`); add:

```ts
  it('routes motif authoring/read/install channels to the motif route (Phase 2)', () => {
    for (const ch of ['list_motifs', 'get_motif_source', 'write_motif_draft', 'amend_motif_draft', 'create_edit_draft', 'import_motif', 'delete_motif', 'install_motif'])
      expect(routeChannel(ch).kind, ch).toBe('motif')
  })
```

Update `apps/desktop/src/main/state/ts-actor-host.test.ts` — add a motif-route test (in-memory store; the existing test harness's fs adapter). Append:

```ts
import { UserMotifStore } from '../../motif/store'
// ... inside the host test suite, a new test:
it('handleInvoke routes a motif channel through runMotifTool (write_motif_draft)', async () => {
  // (Use the suite's existing host factory; pass a real temp-dir UserMotifStore +
  //  empty builtins. See makeHost helper — extend it to forward motifStore/motifBuiltins.)
  const { host, motifStore } = makeHostWithMotifs()
  host.start()
  const manifest = { id: 'x', name: 'Foo', version: 1, size: [10, 10], default_duration_s: 1, fonts: [], props_schema: {} }
  const id = await host.handleInvoke('write_motif_draft', { args: { manifest, html: '<head></head><body>b</body>' } }) as string
  expect(typeof id).toBe('string')
  expect(motifStore.getDraft(id)).not.toBeNull()
})
```

> The exact `makeHostWithMotifs` helper depends on the existing test's host-construction pattern. Extend the existing factory to pass `motifStore: new UserMotifStore(mkdtempSync(...))` and `motifBuiltins: []`, and return the store for assertions. Mirror the existing `makeHost` in this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/state/router.test.ts src/main/state/ts-actor-host.test.ts`
Expected: FAIL — `MOTIF_CHANNELS` not exported; `routeChannel` returns `rust`/`hybrid` for motif channels; host has no `motifTool`/`motifStore` dep.

- [ ] **Step 3: Write minimal implementation**

Modify `apps/desktop/src/main/state/router.ts`:

```ts
export type Route =
  | { kind: 'command' }
  | { kind: 'summary' }
  | { kind: 'projectSettings' }
  | { kind: 'open' } | { kind: 'saveAs' } | { kind: 'newWorkspace' } | { kind: 'save' }
  | { kind: 'agentSessionEnd' }
  | { kind: 'hybrid'; tool: string }
  | { kind: 'motif'; tool: string }   // TS Motif authoring/read/install (Phase 2)
  | { kind: 'reject'; reason: string }
  | { kind: 'rust' }

/** Hybrid Rust-compute → TS-write channels (Phase 3d-e). install_motif moved to
 *  the motif route (Phase 2); acknowledge_motif_staleness stays here (Phase 3). */
export const HYBRID_CHANNELS: ReadonlySet<string> = new Set(['import_media', 'acknowledge_motif_staleness'])

/** Motif catalog-read + authoring + install channels, served in TS by
 *  runMotifTool (Phase 2). */
export const MOTIF_CHANNELS: ReadonlySet<string> = new Set([
  'list_motifs', 'get_motif_source', 'write_motif_draft', 'amend_motif_draft',
  'create_edit_draft', 'import_motif', 'delete_motif', 'install_motif',
])
```

Remove the 7 motif names from `PURE_NATIVE` (leave `list_motifs` etc. OUT of it):

```ts
export const PURE_NATIVE: ReadonlySet<string> = new Set([
  'ping', 'mux_export', 'export_video_sink_start', 'export_video_sink_finish', 'export_video_sink_cancel',
  'import_cancel', 'import_queue_list', 'report_audio_meter', 'settings_get_api_key_status', 'settings_test_provider',
])
```

In `routeChannel`, add the motif branch before the PURE_NATIVE/PERSISTENCE/MIRROR fall-through:

```ts
export function routeChannel(channel: string): Route {
  if (PRODUCTION_OPS.has(channel)) return { kind: 'command' }
  if (HYBRID_CHANNELS.has(channel)) return { kind: 'hybrid', tool: channel }
  if (MOTIF_CHANNELS.has(channel)) return { kind: 'motif', tool: channel }
  switch (channel) {
    case 'project_summary': return { kind: 'summary' }
    case 'get_project_settings': return { kind: 'projectSettings' }
    case 'project_open': return { kind: 'open' }
    case 'project_save_as': return { kind: 'saveAs' }
    case 'project_new_workspace': return { kind: 'newWorkspace' }
    case 'project_save': return { kind: 'save' }
    case 'agent_session_end': return { kind: 'agentSessionEnd' }
  }
  if (PURE_NATIVE.has(channel) || PERSISTENCE.has(channel) || MIRROR_BACKED_READS.has(channel))
    return { kind: 'rust' }
  return { kind: 'reject', reason: 'unclassified channel — classify in router.ts' }
}
```

Modify `apps/desktop/src/main/state/ts-actor-host.ts`:

1. Imports:

```ts
import type { UserMotifStore } from '../motif/store'
import { runMotifTool, type MotifToolDeps } from '../motif/motifTools'
import type { BuiltinMotif, MotifLayerRef } from '../motif/authoring'
import type { MotifParams, MotifRebindEntry } from './model'
```

2. Add to `TsActorHostDeps`:

```ts
  /** On-disk user Motif store (Phase 2 — the TS authoring/read/install surface). */
  motifStore: UserMotifStore
  /** Built-in Motifs ({id, manifest, html}), loaded once at boot from the
   *  relocated served assets. Empty in tests that don't exercise built-ins. */
  motifBuiltins: BuiltinMotif[]
```

3. Inside `createTsActorHost`, after `hybridDeps`, build `motifToolDeps` (it references `refreshMotifCatalog`, which is defined below — JS function hoisting via `function` declaration makes this safe; keep `refreshMotifCatalog` a `function` declaration as it already is):

```ts
  const motifToolDeps: MotifToolDeps = {
    store: deps.motifStore,
    builtins: deps.motifBuiltins,
    motifLayers: () =>
      actor.snapshot().tracks
        .flatMap((t) => t.layers)
        .filter((l) => l.params.kind === 'Motif')
        .map((l) => {
          const p = l.params as MotifParams
          return { layerId: l.id, motifId: p.motif_id, props: p.props } satisfies MotifLayerRef
        }),
    dispatchRebind: (updates: MotifRebindEntry[]) => {
      const r = actor.dispatch('rebind_motif', { updates })
      if (!r.ok) throw new Error(JSON.stringify(r.error))
    },
    emitChanged: () => deps.send('motifs:changed', {}),
    refreshCatalog: () => refreshMotifCatalog(),
    readFile: deps.readFile,
  }
  function runMotif(name: string, args: Record<string, unknown>): unknown {
    return runMotifTool(name, args, motifToolDeps)
  }
```

4. Add the `motif` case to `handleInvoke`'s switch:

```ts
      case 'motif':
        return runMotif(route.tool, args)
```

5. In the returned host object, add the `motifTool` method:

```ts
    motifTool: runMotif,
```

Modify `apps/desktop/src/main/index.ts` — pass the new deps into `createTsActorHost` (the `motifStore` + `motifBuiltinDir` are already constructed at lines 215-217; build `motifBuiltins` once):

```ts
  // Load built-in Motif sources once (manifest + relocated index.html) for the
  // TS catalog/authoring surface (Phase 2). builtinMotifs reads from motifBuiltinDir.
  const { builtinMotifs } = await import('./motif/authoring.js')
  const motifBuiltins = builtinMotifs(motifBuiltinDir)
```

Then in the `createTsActorHost({ ... })` call, add:

```ts
    motifStore,
    motifBuiltins,
```

> The renderer `backend:invoke` dispatch (index.ts ~347) already forwards `route.kind !== 'rust'` to `tsHost.handleInvoke`, so the new `'motif'` route reaches `handleInvoke` with no change there.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/state/router.test.ts src/main/state/ts-actor-host.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/state/router.ts apps/desktop/src/main/state/router.test.ts apps/desktop/src/main/state/ts-actor-host.ts apps/desktop/src/main/state/ts-actor-host.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(motifs): renderer 'motif' route + host motifTool wiring"
```

---

## Task 7: Integration verification — typecheck, full vitest, e2e baseline, real-app smoke

**Files:** none (verification only). If a gap surfaces, fix it in the relevant task's file and re-commit.

- [ ] **Step 1: Typecheck the whole main bundle**

Run: `cd apps/desktop && npx tsc -b`
Expected: clean (0 errors). Common catches: `MotifParams` field names (`motif_id`/`motif_version`/`props`), the `satisfies MotifLayerRef`, the `TsActorHost.motifTool` interface ↔ implementation match.

- [ ] **Step 2: Run the full main-process vitest suite**

Run: `cd apps/desktop && npx vitest run src/main`
Expected: PASS. Specifically green: `motif/authoring.test.ts`, `motif/motifTools.test.ts`, `mcp/motifResult.test.ts`, `mcp/mcpRouter.test.ts`, `state/router.test.ts`, `state/ts-actor-host.test.ts`, `state/__tests__/mcp.catalog-bijection.test.ts`, `state/__tests__/mcp.tool-table.test.ts`, `state/__tests__/mcp.differential.test.ts` (motif tools are not in the corpus → unaffected).

- [ ] **Step 3: Confirm the motif tools are NOT in the MCP differential corpus (parity guard)**

Run: `ls apps/desktop/fixtures/state-corpus/sequences-mcp | head` then
`grep -rl "list_motifs\|write_motif_draft\|install_motif\|get_motif_source\|delete_motif" apps/desktop/fixtures/state-corpus/sequences-mcp || echo "NONE — motif tools out of corpus (expected)"`
Expected: `NONE` (the store tools need disk; they're out of the in-memory differential corpus, so moving list_motifs to a sha256 content_hash can't break the gate).

- [ ] **Step 4: Build the e2e bundle + run the motif lifecycle e2e**

Build (e2e needs the instrumented bundle): `cd apps/desktop && set VITE_WEFTCUT_E2E=1 && npm run build` (PowerShell: `$env:VITE_WEFTCUT_E2E='1'; npm run build`).
Run: `cd apps/desktop && npx playwright test e2e/electron/motif-lifecycle.spec.ts`
Expected:
- **Section A (write→install→list→delete): PASS** — this is the Phase 2 deliverable, now served entirely by TS.
- **Sections B (staleness reopen) + C (file-watch hot-reload): may still FAIL** — these are pre-existing failures (baseline `3149c765`), rooted in actor-catalog-sync-from-direct-disk-write (the watcher→refreshMotifCatalog wiring), which is Phase 3 work. Confirm the failures are identical to baseline (same assertion, not a new regression). If A fails, that IS a regression — debug before proceeding.

> If you need to confirm the baseline: `git stash && npx playwright test e2e/electron/motif-lifecycle.spec.ts` on the pre-Phase-2 tree, compare B/C failure messages, then `git stash pop`. (Local-only; these e2e are skipped in CI.)

- [ ] **Step 5: Real-app smoke (manual, via the running dev app)**

Launch: `cd apps/desktop && npm run dev` (a visible window appears — see memory `reference_agent_gui_launch`).
In the MotifPicker: create a draft (Edit a built-in → save), confirm it appears as a draft card; install it, confirm it flips to "installed"; delete it, confirm it disappears. Watch the main-process console — no `router bug: ... reached the TS host but is a Rust channel` and no `runMotifTool: unhandled tool`. This exercises the renderer `'motif'` route + `motifs:changed` re-pull end to end.

- [ ] **Step 6: Update the project memory**

Update `project_motifs_ts_migration.md`: mark Phase 2 done (catalog read + authoring + install in TS; the `'motif'` route on both surfaces; install collapsed to pure-TS); record the phase-boundary decision (ack + staleness report + watcher are Phase 3); note the commit hash. Keep the Phase-1 carry-forward note resolved (content_hash now fed composed html in the payload path).

- [ ] **Step 7: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "test(motifs): Phase 2 integration verification + fixups"
```

---

## Self-Review (run before execution)

**Spec coverage (§ of `2026-06-26-motifs-ts-migration-design.md`):**
- §1.3 `parse_manifest_island`/`validate_manifest`/`validate_default_for` → already in `shared/catalog.ts` (Phase 1); consumed here. ✓
- §1.3 authoring cores + `build_rebind_updates` → Tasks 2–3. ✓
- §1.3 `motif_to_payload`/`list_motifs` → Task 1. ✓
- §1.3 `content_hash` → reused from Phase 1; wired into payload with FULL html (carry-forward honored, Task 1). ✓
- §5 collapse `install_motif` hybrid → pure TS (reads live actor snapshot, dispatches `rebind_motif`) → Tasks 3, 4, 6. `acknowledge_motif_staleness` deferred to Phase 3 (documented). ✓
- §6 MCP rewiring: tools routed to TS (the `'motif'` route); `mergeMcpCatalog` keeps working (motif tools stay Rust-advertised this phase; def-move + Rust-arm deletion is Phase 4); bijection/router tests updated → Task 5. ✓
- §7 Phase 2 ("catalog read + authoring; route the 8 read/lifecycle tools; collapse install") → all tasks. ✓
- §8 error parity: thrown `Error`s → `server.ts` envelope mapper / renderer IPC rejection (existing); validation rejection via `validateManifest`; built-in delete/overwrite guards ported verbatim. ✓
- §9 testing: Rust unit suites ported near-verbatim (Tasks 1–3); dispatcher + shaper unit tests (Tasks 4–5); e2e Section A (Task 7). ✓
- §10 risks: watcher = Phase 3 (out of scope); built-in bundling reused from Phase 1; MCP catalog drift caught by the updated bijection/router tests; read-mirror removal for install — install now reads the live actor snapshot directly (no mirror), `computeMotifRebind` napi left uncalled (deleted Phase 4). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full content. The only deferred-to-execution detail is the `makeHostWithMotifs` test helper (Task 6 Step 1), which must mirror the existing `makeHost` factory in `ts-actor-host.test.ts` — flagged explicitly with the extension recipe.

**Type consistency:** `MotifLayerRef`/`InstallArgs`/`BuiltinMotif` defined in `authoring.ts` (Tasks 1–3), imported by `motifTools.ts` (Task 4) and the host (Task 6). `MotifRebindEntry` field names (`layer_id`/`motif_id`/`motif_version`/`props`) match `state/model.ts:56`. `MotifParams` fields (`motif_id`/`motif_version`/`props`) match `state/model.ts:52`. `routeMcpTool` returns the widened `McpRoute` (`'motif'` added) consumed by `server.ts`. `tsHost.motifTool` declared in Task 5, implemented in Task 6 (same signature).

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, two-stage review between tasks (REQUIRED SUB-SKILL: superpowers:subagent-driven-development). Implementer subagents must be forbidden from delegating to codex / running formatters (memory `feedback_subagent_fences`).
2. **Inline Execution** — execute tasks in this session with checkpoints (REQUIRED SUB-SKILL: superpowers:executing-plans).
