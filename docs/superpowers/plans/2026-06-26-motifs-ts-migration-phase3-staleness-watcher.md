# Motifs TS migration — Phase 3 (staleness + watcher) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Motif staleness cores + the file watcher from Rust to TS, and collapse the on-open staleness report + `acknowledge_motif_staleness` onto the pure-TS `motif` route — closing the two pre-existing motif-lifecycle e2e failures.

**Architecture:** Two new pure/Node modules under `src/main/motif/` (`staleness.ts`, `watcher.ts`). Both staleness IPC channels move off the Rust read-mirror (`motif_staleness_report` was `rust`; `acknowledge_motif_staleness` was `hybrid`) onto `runMotifTool` reading the **live actor snapshot**. A Node `fs.watch` watcher is spawned in `index.ts` and — unlike the Rust watcher it supersedes — calls the host's `refreshMotifCatalog()` so a disk-written Motif becomes placeable via `add_motif` (the e2e gap). Rust stays in place and is deleted in Phase 4.

**Tech Stack:** TypeScript (electron-vite main bundle), vitest, Node `fs`/`crypto`, Playwright `_electron` e2e.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-26-motifs-ts-migration-design.md` — §4 (staleness), §5 (collapse the compute hybrids), §7 phase 3, §9 testing, §10 risks. Every task implicitly inherits the spec.
- **Byte-faithful port.** `staleness.ts` mirrors `native/src/motifs/staleness.rs` exactly: same grouping, same min-placed, same skip-equal-and-unknown, same deterministic-by-id order, same ack semantics. `watcher.ts` mirrors `native/src/motifs/watcher.rs`: 400 ms quiet-window debounce, coalesce a burst into ONE fire.
- **Wire shape is snake_case.** `MotifStaleEntry` keeps `motif_id` / `placed_version` / `current_version` / `layer_count`; `MotifRebindEntry` is `{ layer_id, motif_id, motif_version, props }`. The renderer (`renderer/ipc/index.ts`) and the e2e assert on these exact keys.
- **Rust is NOT edited this phase.** Consistent with Phases 1–2: the Rust `motifs` feature (incl. `watcher.rs` and `napi_backend.rs::init`'s watcher spawn) stays live and is deleted wholesale in Phase 4. The Rust watcher will keep emitting `motifs:changed` alongside the new TS watcher — a transient, idempotent duplicate (the renderer resync is a full refresh); Phase 4 removes it.
- **No `Set-Content` on source files** (cp1252 mangles em-dashes) — use the Edit/Write tools.
- **Commands:** type-check `npm --prefix apps/desktop run -s typecheck` (or the repo's `tsc -b`); unit tests `npm --prefix apps/desktop run -s test -- <file>` (vitest). Confirm the exact scripts in `apps/desktop/package.json` before the first run; use whatever Phases 1–2 used.
- **Parallel sessions:** the user may edit this checkout concurrently — stage by explicit path, re-check `git status` before each commit.

---

## File Structure

**Create:**
- `apps/desktop/src/main/motif/staleness.ts` — `MotifStaleEntry`, `currentVersions`, `buildStalenessReport`, `buildAckEntries` (pure; mirrors `staleness.rs`).
- `apps/desktop/src/main/motif/staleness.test.ts` — Rust unit suite ported near-verbatim.
- `apps/desktop/src/main/motif/watcher.ts` — `DEBOUNCE_QUIET_MS`, `Debouncer`, `spawnMotifWatcher` (Node `fs.watch`; mirrors `watcher.rs`).
- `apps/desktop/src/main/motif/watcher.test.ts` — debounce coalescing (fake timers) + real-file-write fire.

**Modify:**
- `apps/desktop/src/main/motif/authoring.ts:162` — add `version: number` to `MotifLayerRef`.
- `apps/desktop/src/main/motif/motifTools.ts` — add `emitLog` to `MotifToolDeps`; add `motif_staleness_report` + `acknowledge_motif_staleness` cases.
- `apps/desktop/src/main/motif/motifTools.test.ts` — add `version` to the install fixture + `emitLog` to deps; add staleness/ack tests.
- `apps/desktop/src/main/motif/authoring.test.ts:193-195,224` — add `version: 1` to the `MotifLayerRef` fixtures.
- `apps/desktop/src/main/state/router.ts` — move `motif_staleness_report` (off `MIRROR_BACKED_READS`) + `acknowledge_motif_staleness` (off `HYBRID_CHANNELS`) into `MOTIF_CHANNELS`.
- `apps/desktop/src/main/state/router.test.ts` — update the partition manifest + hybrid/motif assertions.
- `apps/desktop/src/main/mcp/mutationTools.ts` — move `acknowledge_motif_staleness` off `HYBRID_TOOLS`; add both staleness tools to `MOTIF_TOOLS`.
- `apps/desktop/src/main/mcp/mcpRouter.test.ts` — update the routing assertions.
- `apps/desktop/src/main/mcp/motifResult.ts` — shape `motif_staleness_report` (json) + `acknowledge_motif_staleness` (text count).
- `apps/desktop/src/main/mcp/motifResult.test.ts` — assert the two new shapes.
- `apps/desktop/src/main/state/hybrids.ts:149-160` — delete the now-unreachable `acknowledge_motif_staleness` case.
- `apps/desktop/src/main/state/__tests__/hybrids.test.ts:207-~250` — delete the `runHybrid: acknowledge_motif_staleness` describe block.
- `apps/desktop/src/main/state/ts-actor-host.ts` — host populates `MotifLayerRef.version` + wires `emitLog` into `motifToolDeps`; drop the `handleInvoke` `case 'hybrid'` ack special-case; expose `refreshMotifCatalog` on `TsActorHost`.
- `apps/desktop/src/main/index.ts` — spawn `spawnMotifWatcher(motifStore.root(), …)` after `tsHost.start()`; close it on app quit.

---

## Task 1: `staleness.ts` pure cores

**Files:**
- Create: `apps/desktop/src/main/motif/staleness.ts`
- Test: `apps/desktop/src/main/motif/staleness.test.ts`

**Interfaces:**
- Consumes: `Manifest` from `../../shared/motifs/catalog`; `BuiltinMotif` from `./authoring`; `MotifRebindEntry` from `../state/model`.
- Produces (relied on by Task 3):
  - `interface MotifStaleEntry { motif_id: string; name: string; placed_version: number; current_version: number; layer_count: number }`
  - `currentVersions(builtins: BuiltinMotif[], published: Manifest[]): Map<string, { name: string; version: number }>`
  - `buildStalenessReport(layers: Array<{ motifId: string; placedVersion: number }>, current: Map<string, { name: string; version: number }>): MotifStaleEntry[]`
  - `buildAckEntries(layers: Array<{ layerId: string; motifId: string; placedVersion: number; props: Record<string, unknown> }>, current: Map<string, { name: string; version: number }>): MotifRebindEntry[]`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/motif/staleness.test.ts`:

```ts
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
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix apps/desktop run -s test -- src/main/motif/staleness.test.ts`
Expected: FAIL — `Cannot find module './staleness'` (or "currentVersions is not a function").

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/motif/staleness.ts`:

```ts
// apps/desktop/src/main/motif/staleness.ts
//
// Cross-project staleness (upload-authoring spec §7-B). A placed Motif layer
// stores the motif_version it was created with as a SEEN-AT marker — it does
// NOT pin rendering (the frame cache key is source-derived). On project open,
// comparing each marker against the catalog's current version surfaces "this
// Motif changed since you placed it (v1 → v3)". Acknowledging bumps markers to
// current in ONE undo entry via rebind_motif.
//
// Pure cores take exactly the data they need so they unit-test without an actor
// or disk. Mirrors native/src/motifs/staleness.rs (ported verbatim, Phase 3).
import type { Manifest } from '../../shared/motifs/catalog'
import type { BuiltinMotif } from './authoring'
import type { MotifRebindEntry } from '../state/model'

/** One row of the on-open staleness report, grouped by motif id. Wire-shaped
 *  (snake_case): the renderer's MotifStaleEntry + the e2e assert on these keys. */
export interface MotifStaleEntry {
  motif_id: string
  name: string
  /** Lowest seen-at version across the affected (stale) layers. */
  placed_version: number
  current_version: number
  layer_count: number
}

/** Current catalog versions: motif_id -> { name, version }. Built-ins first,
 *  then published user Motifs (insertion order makes the store win on a
 *  collision, matching Rust). Drafts are deliberately absent: always version 1,
 *  content-hash-keyed, so a draft layer can never read as stale. */
export function currentVersions(
  builtins: BuiltinMotif[],
  published: Manifest[],
): Map<string, { name: string; version: number }> {
  const map = new Map<string, { name: string; version: number }>()
  for (const b of builtins) map.set(b.manifest.id, { name: b.manifest.name, version: b.manifest.version })
  for (const m of published) map.set(m.id, { name: m.name, version: m.version })
  return map
}

/** Group (motifId, placedVersion) pairs into report rows. ANY inequality
 *  reports (downgrades included — same message shape); ids missing from
 *  `current` are skipped (the "unknown Motif" placeholder owns that case);
 *  layers already at current don't count. Sorted by motif id for a
 *  deterministic order (motif ids are sanitized ASCII, so default string sort
 *  matches the Rust BTreeMap byte order). */
export function buildStalenessReport(
  layers: Array<{ motifId: string; placedVersion: number }>,
  current: Map<string, { name: string; version: number }>,
): MotifStaleEntry[] {
  const grouped = new Map<string, { placed: number; count: number }>()
  for (const { motifId, placedVersion } of layers) {
    const cur = current.get(motifId)
    if (!cur) continue
    if (placedVersion === cur.version) continue
    const slot = grouped.get(motifId)
    if (slot) { slot.placed = Math.min(slot.placed, placedVersion); slot.count += 1 }
    else grouped.set(motifId, { placed: placedVersion, count: 1 })
  }
  return [...grouped.keys()].sort().map((id) => {
    const cur = current.get(id)!
    const slot = grouped.get(id)!
    return { motif_id: id, name: cur.name, placed_version: slot.placed, current_version: cur.version, layer_count: slot.count }
  })
}

/** Build the acknowledge set: every layer whose seen-at version differs from
 *  current keeps its id + props verbatim and gets motif_version = current. */
export function buildAckEntries(
  layers: Array<{ layerId: string; motifId: string; placedVersion: number; props: Record<string, unknown> }>,
  current: Map<string, { name: string; version: number }>,
): MotifRebindEntry[] {
  const out: MotifRebindEntry[] = []
  for (const { layerId, motifId, placedVersion, props } of layers) {
    const cur = current.get(motifId)
    if (!cur) continue
    if (cur.version === placedVersion) continue
    out.push({ layer_id: layerId, motif_id: motifId, motif_version: cur.version, props })
  }
  return out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix apps/desktop run -s test -- src/main/motif/staleness.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/motif/staleness.ts apps/desktop/src/main/motif/staleness.test.ts
git commit -m "feat(motifs): TS staleness cores (currentVersions/report/ack)"
```

---

## Task 2: `watcher.ts` Node file watcher

**Files:**
- Create: `apps/desktop/src/main/motif/watcher.ts`
- Test: `apps/desktop/src/main/motif/watcher.test.ts`

**Interfaces:**
- Produces (relied on by Task 5):
  - `const DEBOUNCE_QUIET_MS = 400`
  - `class Debouncer { constructor(quietMs: number, onChange: () => void); signal(): void; cancel(): void }`
  - `interface MotifWatcher { close(): void }`
  - `spawnMotifWatcher(root: string, onChange: () => void): MotifWatcher`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/motif/watcher.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Debouncer, spawnMotifWatcher } from './watcher'

describe('Debouncer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces a burst into one fire, then fires again on a later burst', () => {
    const fired = vi.fn()
    const d = new Debouncer(50, fired)
    for (let i = 0; i < 5; i++) d.signal()
    expect(fired).not.toHaveBeenCalled()       // still inside the quiet window
    vi.advanceTimersByTime(60)
    expect(fired).toHaveBeenCalledTimes(1)      // burst coalesced to one
    d.signal()
    vi.advanceTimersByTime(60)
    expect(fired).toHaveBeenCalledTimes(2)      // a later burst fires again
  })

  it('cancel() suppresses a pending fire', () => {
    const fired = vi.fn()
    const d = new Debouncer(50, fired)
    d.signal()
    d.cancel()
    vi.advanceTimersByTime(60)
    expect(fired).not.toHaveBeenCalled()
  })
})

describe('spawnMotifWatcher', () => {
  it('fires onChange on a real file write under the root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'motifwatch-'))
    const fired = vi.fn()
    const w = spawnMotifWatcher(root, fired)
    try {
      await new Promise((r) => setTimeout(r, 200)) // let the OS watch attach
      mkdirSync(path.join(root, 'm1'), { recursive: true })
      writeFileSync(path.join(root, 'm1', 'index.html'), '<html>')
      const deadline = Date.now() + 5000
      while (fired.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(fired.mock.calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      w.close()
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix apps/desktop run -s test -- src/main/motif/watcher.test.ts`
Expected: FAIL — `Cannot find module './watcher'`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/motif/watcher.ts`:

```ts
// apps/desktop/src/main/motif/watcher.ts
//
// Stage-5 file watch: a recursive fs.watch on the user-Motif root. Any disk
// change — external-editor saves included — coalesces through a quiet-window
// debounce into ONE onChange call. The caller (index.ts) refreshes the actor
// catalog + emits motifs:changed; the renderer resync pipeline does the rest.
// Deliberately NO per-file dispatch (the resync is a full idempotent refresh)
// and NO filtering of the app's own writes (install/delete/amend emit
// motifs:changed themselves; the debounced duplicate is harmless).
//
// Mirrors native/src/motifs/watcher.rs (notify → fs.watch; the debounce is
// identical and unit-tested independently of the OS watch).
import { mkdirSync, watch, type FSWatcher } from 'node:fs'

/** Quiet window (ms): after a change, wait until this long passes with no
 *  further event, then fire once. Absorbs editor write bursts + multi-file writes. */
export const DEBOUNCE_QUIET_MS = 400

/** Coalesce raw watch events into one onChange after a quiet window. Split from
 *  spawnMotifWatcher so the debounce is testable with fake timers (no OS watch).
 *  Mirrors watcher.rs debounce_loop. */
export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly quietMs: number, private readonly onChange: () => void) {}
  /** Signal a raw change; resets the quiet window. */
  signal(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.onChange() }, this.quietMs)
  }
  /** Cancel any pending fire (used on close). */
  cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }
}

export interface MotifWatcher { close(): void }

/** Attach a recursive watcher at `root` (created if missing — a first boot has
 *  no user Motifs yet, but the watcher must still attach) and fire `onChange`
 *  once per debounced burst. Errors are forwarded as change signals too: a
 *  watch error means "something may have changed that we missed" — a spurious
 *  resync is harmless, a missed one isn't.
 *
 *  Recursive watch is supported on the ship targets (Windows/macOS); on Linux
 *  dev it throws, so fall back to a shallow watch on the root (top-level
 *  <id>/ dirs still fire). The e2e gate is local-only on a ship target. */
export function spawnMotifWatcher(root: string, onChange: () => void): MotifWatcher {
  mkdirSync(root, { recursive: true })
  const deb = new Debouncer(DEBOUNCE_QUIET_MS, onChange)
  let watcher: FSWatcher
  try {
    watcher = watch(root, { recursive: true })
  } catch {
    watcher = watch(root)
  }
  watcher.on('change', () => deb.signal())
  watcher.on('error', () => deb.signal())
  return { close() { deb.cancel(); watcher.close() } }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix apps/desktop run -s test -- src/main/motif/watcher.test.ts`
Expected: PASS. (If the real-write test is timing-flaky on the runner, re-run once; the debounce test is the deterministic core.)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/motif/watcher.ts apps/desktop/src/main/motif/watcher.test.ts
git commit -m "feat(motifs): TS file watcher (debounce + fs.watch)"
```

---

## Task 3: Wire the staleness tools into `runMotifTool`

**Files:**
- Modify: `apps/desktop/src/main/motif/authoring.ts:162`
- Modify: `apps/desktop/src/main/motif/motifTools.ts`
- Modify: `apps/desktop/src/main/motif/motifTools.test.ts`
- Modify: `apps/desktop/src/main/motif/authoring.test.ts` (fixtures)

**Interfaces:**
- Consumes: `currentVersions` / `buildStalenessReport` / `buildAckEntries` / `MotifStaleEntry` from `./staleness` (Task 1); `UserMotifStore.listManifests(): Manifest[]`.
- Produces (relied on by Task 4/5):
  - `MotifLayerRef` gains `version: number`.
  - `MotifToolDeps` gains `emitLog: (entry: { level: 'warn'; category: { kind: 'Project' }; source: { kind: 'System' }; message: string }) => void`.
  - `runMotifTool` handles `'motif_staleness_report'` (returns `MotifStaleEntry[]`) and `'acknowledge_motif_staleness'` (returns `number`).

- [ ] **Step 1: Add `version` to `MotifLayerRef` + write the failing tests**

In `apps/desktop/src/main/motif/authoring.ts` change line 162:

```ts
export interface MotifLayerRef { layerId: string; motifId: string; version: number; props: Record<string, unknown> }
```

In `apps/desktop/src/main/motif/motifTools.test.ts`, add `emitLog` + a `logs` capture to the `beforeEach` deps (and the `version` field to the install fixture at line 94), then add the staleness tests. Apply these edits:

- Add `let logs: string[]` beside the other `let` declarations.
- In `beforeEach`, set `logs = []` and add `emitLog: (e) => { logs.push(e.message) },` to `deps`.
- Change the line-94 fixture to `layers = [{ layerId: 'la', motifId: 'wip', version: 1, props: {} }]`.
- Append these tests inside the `describe('runMotifTool', …)` block:

```ts
  it('motif_staleness_report returns [] when nothing is stale', () => {
    const v2 = { ...m('Foo', 'foo'), version: 2 }
    store.writeDraft('foo', doc(v2)); store.installDraft('foo', 'foo')
    layers = [{ layerId: 'la', motifId: 'foo', version: 2, props: {} }]
    expect(runMotifTool('motif_staleness_report', {}, deps)).toEqual([])
    expect(logs).toEqual([])
  })

  it('motif_staleness_report rows a v1 layer against a v2 published motif + logs a warn', () => {
    const v2 = { ...m('Foo', 'foo'), version: 2 }
    store.writeDraft('foo', doc(v2)); store.installDraft('foo', 'foo')
    layers = [{ layerId: 'la', motifId: 'foo', version: 1, props: { a: 1 } }]
    const report = runMotifTool('motif_staleness_report', {}, deps)
    expect(report).toEqual([{ motif_id: 'foo', name: 'Foo', placed_version: 1, current_version: 2, layer_count: 1 }])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('foo v1→v2')
  })

  it('acknowledge_motif_staleness dispatches a rebind for stale layers, returns the count, refreshes', () => {
    const v2 = { ...m('Foo', 'foo'), version: 2 }
    store.writeDraft('foo', doc(v2)); store.installDraft('foo', 'foo')
    layers = [{ layerId: 'la', motifId: 'foo', version: 1, props: { a: 1 } }]
    const count = runMotifTool('acknowledge_motif_staleness', {}, deps) as number
    expect(count).toBe(1)
    expect(rebinds.length).toBe(1)
    expect((rebinds[0] as any[])[0]).toMatchObject({ layer_id: 'la', motif_id: 'foo', motif_version: 2, props: { a: 1 } })
    expect(refreshed).toBe(1)
  })

  it('acknowledge_motif_staleness returns 0 + dispatches nothing when nothing is stale', () => {
    const v2 = { ...m('Foo', 'foo'), version: 2 }
    store.writeDraft('foo', doc(v2)); store.installDraft('foo', 'foo')
    layers = [{ layerId: 'la', motifId: 'foo', version: 2, props: {} }]
    expect(runMotifTool('acknowledge_motif_staleness', {}, deps)).toBe(0)
    expect(rebinds).toEqual([])
    expect(refreshed).toBe(1)   // refresh is unconditional (cheap, idempotent)
  })
```

Also import the type at the top of the test file if asserting it: `import { runMotifTool, type MotifToolDeps } from './motifTools'` already exists — no change needed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix apps/desktop run -s test -- src/main/motif/motifTools.test.ts`
Expected: FAIL — `emitLog` missing from `MotifToolDeps` (type error) and/or `runMotifTool: unhandled tool motif_staleness_report`.

- [ ] **Step 3: Implement — extend `MotifToolDeps` + add the two cases**

In `apps/desktop/src/main/motif/motifTools.ts`:

Add the import (beside the existing `./authoring` import):

```ts
import { type MotifStaleEntry, currentVersions, buildStalenessReport, buildAckEntries } from './staleness'
```

Add to `MotifToolDeps` (after `readFile`):

```ts
  /** Emit a record-panel LogBus warn row (the on-open staleness summary).
   *  Best-effort; the host wraps the underlying emit in try/catch. */
  emitLog: (entry: { level: 'warn'; category: { kind: 'Project' }; source: { kind: 'System' }; message: string }) => void
```

Add these two cases to the `switch (name)` in `runMotifTool` (before `default:`):

```ts
    case 'motif_staleness_report': {
      const current = currentVersions(deps.builtins, deps.store.listManifests())
      const layers = deps.motifLayers().map((l) => ({ motifId: l.motifId, placedVersion: l.version }))
      const report: MotifStaleEntry[] = buildStalenessReport(layers, current)
      if (report.length) {
        const summary = report
          .map((e) => `${e.motif_id} v${e.placed_version}→v${e.current_version} (${e.layer_count} layer(s))`)
          .join(', ')
        deps.emitLog({ level: 'warn', category: { kind: 'Project' }, source: { kind: 'System' }, message: `Motifs changed since placement: ${summary}` })
      }
      return report
    }
    case 'acknowledge_motif_staleness': {
      const current = currentVersions(deps.builtins, deps.store.listManifests())
      const layers = deps.motifLayers().map((l) => ({ layerId: l.layerId, motifId: l.motifId, placedVersion: l.version, props: l.props }))
      const updates = buildAckEntries(layers, current)
      if (updates.length) deps.dispatchRebind(updates)
      // Refresh so applyUpdateLayerParams' content-window clamp sees the current
      // manifests (parity with the old hybrid's post-ack refresh). Cheap + idempotent.
      deps.refreshCatalog()
      return updates.length
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix apps/desktop run -s test -- src/main/motif/motifTools.test.ts src/main/motif/authoring.test.ts`
Expected: PASS (existing + 4 new motifTools tests; authoring fixtures still pass).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/motif/authoring.ts apps/desktop/src/main/motif/motifTools.ts apps/desktop/src/main/motif/motifTools.test.ts apps/desktop/src/main/motif/authoring.test.ts
git commit -m "feat(motifs): staleness report + ack on the TS motif route"
```

---

## Task 4: Move both staleness channels onto the `motif` route

**Files:**
- Modify: `apps/desktop/src/main/state/router.ts`
- Modify: `apps/desktop/src/main/state/router.test.ts`
- Modify: `apps/desktop/src/main/mcp/mutationTools.ts`
- Modify: `apps/desktop/src/main/mcp/mcpRouter.test.ts`
- Modify: `apps/desktop/src/main/mcp/motifResult.ts`
- Modify: `apps/desktop/src/main/mcp/motifResult.test.ts`
- Modify: `apps/desktop/src/main/state/hybrids.ts`
- Modify: `apps/desktop/src/main/state/__tests__/hybrids.test.ts`
- Modify: `apps/desktop/src/main/state/ts-actor-host.ts` (drop the `handleInvoke` ack special-case)

**Interfaces:**
- Consumes: `runMotifTool` cases from Task 3.
- Produces: `routeChannel('motif_staleness_report')` and `routeChannel('acknowledge_motif_staleness')` both `{ kind: 'motif' }`; `routeMcpTool` of both → `'motif'`; `shapeMotifMcpResult` handles both.

- [ ] **Step 1: Update the renderer router + its gate test (write the expectations first)**

In `apps/desktop/src/main/state/router.test.ts`:
- In `ALL_CHANNELS`, move `motif_staleness_report` and `acknowledge_motif_staleness` into the motif-route group (with the other 8) and remove them from the hybrid / mirror-backed-reads groups. The motif comment line becomes the 10 motif channels.
- Change the inline hybrid assertion (currently `for (const ch of ['import_media', 'acknowledge_motif_staleness'])`) to `for (const ch of ['import_media'])`.
- Change the "routes the two hybrid channels to hybrid" test to expect only `import_media`.

In `apps/desktop/src/main/state/router.ts`:
- Add `'motif_staleness_report'` and `'acknowledge_motif_staleness'` to `MOTIF_CHANNELS`.
- Remove `'acknowledge_motif_staleness'` from `HYBRID_CHANNELS` (leaving `['import_media']`).
- Remove `'motif_staleness_report'` from `MIRROR_BACKED_READS`.
- Update the doc comments on `HYBRID_CHANNELS` / `MOTIF_CHANNELS` accordingly.

- [ ] **Step 2: Update the MCP router + its gate test**

In `apps/desktop/src/main/mcp/mcpRouter.test.ts`:
- The "routes import_media + apply_subtitles + acknowledge_motif_staleness + synthesize_speech to … hybrid" test: drop `acknowledge_motif_staleness` (now `'motif'`); keep the other three.
- The "routes the 5 MCP motif tools to the motif route" test: this is fine as-is (still asserts the original 5), but add a test asserting `motif_staleness_report` and `acknowledge_motif_staleness` both route `'motif'`.
- The "routes reads + native-read tools to rust (including motif_staleness_report)" test: remove `motif_staleness_report` from that list (it is no longer `rust`).

In `apps/desktop/src/main/mcp/mutationTools.ts`:
- Remove `'acknowledge_motif_staleness'` from `HYBRID_TOOLS`.
- Add `'acknowledge_motif_staleness'` and `'motif_staleness_report'` to `MOTIF_TOOLS`.
- Update the doc comments.

- [ ] **Step 3: Shape the two MCP results + assert them**

In `apps/desktop/src/main/mcp/motifResult.test.ts`, add:

```ts
  it('motif_staleness_report → json array', () => {
    const r = shapeMotifMcpResult('motif_staleness_report', [{ motif_id: 'a', name: 'A', placed_version: 1, current_version: 2, layer_count: 1 }])
    expect(r.content[0].type).toBe('text')              // toolJson serializes to a text block
    expect(JSON.parse((r.content[0] as { text: string }).text)).toHaveLength(1)
  })
  it('acknowledge_motif_staleness → text count', () => {
    const r = shapeMotifMcpResult('acknowledge_motif_staleness', 3)
    expect(r.content[0]).toMatchObject({ type: 'text', text: '3' })
  })
```

(Confirm `toolJson`'s exact content shape against an existing `motifResult.test.ts` assertion and match it; the snippet above assumes `toolJson` emits a single text block of JSON, as `list_motifs` does.)

In `apps/desktop/src/main/mcp/motifResult.ts`, add cases:

```ts
    case 'motif_staleness_report':
      return toolJson(raw)
    case 'acknowledge_motif_staleness':
      return toolText(String(raw as number))
```

- [ ] **Step 4: Delete the now-unreachable ack hybrid + its test**

In `apps/desktop/src/main/state/hybrids.ts`, delete the entire `case 'acknowledge_motif_staleness': { … }` block (lines ~149-160). `acknowledge_motif_staleness` no longer routes through `runHybrid`. (Leave `computeAckMotifRebind` on the compute facade / `HybridDeps` — it is an unused interface method now, deleted with the Rust napi in Phase 4.)

In `apps/desktop/src/main/state/__tests__/hybrids.test.ts`, delete the whole `describe('runHybrid: acknowledge_motif_staleness (motif hybrid)', …)` block (lines ~207-end-of-that-describe). Leave the `computeAckMotifRebind: vi.fn(...)` mock in the shared deps factory (harmless; other code paths construct the same deps object).

In `apps/desktop/src/main/state/ts-actor-host.ts`, in `handleInvoke`'s `case 'hybrid'`, delete the `if (channel === 'acknowledge_motif_staleness') { refreshMotifCatalog() }` special-case (the refresh now happens inside `runMotifTool`). The `case 'hybrid'` returns `hybridResult` directly.

- [ ] **Step 5: Run the full main-process unit suite**

Run: `npm --prefix apps/desktop run -s test -- src/main`
Expected: PASS. Watch specifically: `router.test.ts`, `mcpRouter.test.ts`, `motifResult.test.ts`, `mcpCatalog.test.ts`, `hybrids.test.ts`, `mcp.catalog-bijection.test.ts`. If `mcp.catalog-bijection.test.ts` or `mcpCatalog.test.ts` reference the moved tools, update them to the new routing (the bijection branch `if (r === 'motif') expect(MOTIF_TOOLS.has(...))` should already pass once `MOTIF_TOOLS` includes them).

- [ ] **Step 6: Type-check + commit**

Run: `npm --prefix apps/desktop run -s typecheck`
Expected: clean.

```bash
git add apps/desktop/src/main/state/router.ts apps/desktop/src/main/state/router.test.ts apps/desktop/src/main/mcp/mutationTools.ts apps/desktop/src/main/mcp/mcpRouter.test.ts apps/desktop/src/main/mcp/motifResult.ts apps/desktop/src/main/mcp/motifResult.test.ts apps/desktop/src/main/state/hybrids.ts apps/desktop/src/main/state/__tests__/hybrids.test.ts apps/desktop/src/main/state/ts-actor-host.ts
git commit -m "refactor(motifs): route staleness report + ack to the pure-TS motif path"
```

---

## Task 5: Spawn the TS watcher + expose `refreshMotifCatalog`

**Files:**
- Modify: `apps/desktop/src/main/state/ts-actor-host.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Verify: `apps/desktop/e2e/electron/motif-lifecycle.spec.ts` (Sections B & C now pass)

**Interfaces:**
- Consumes: `spawnMotifWatcher` (Task 2); `UserMotifStore.root(): string`.
- Produces: `TsActorHost.refreshMotifCatalog(): void`.

- [ ] **Step 1: Expose `refreshMotifCatalog` on the host + wire `emitLog` into the motif deps**

In `apps/desktop/src/main/state/ts-actor-host.ts`:

Add to the `TsActorHost` interface (after `motifTool`):

```ts
  /** Re-pull list_motifs → actor.setUserMotifManifests. Exposed so the file
   *  watcher can refresh the actor catalog when a Motif appears on disk with no
   *  store-mutating tool call (otherwise add_motif rejects it). */
  refreshMotifCatalog: () => void
```

In the returned object (beside `motifTool: runMotif`), add:

```ts
    refreshMotifCatalog,
```

In `runMotif`'s `motifToolDeps`, add the `emitLog` member (wrapping the optional host dep so it never throws):

```ts
      emitLog: (entry) => { try { deps.emitLog?.(entry) } catch (err) { console.warn('[ts-actor-host] emitLog failed (motif)', err) } },
```

**Also** populate `version` in the `motifLayers` map literal (line ~176) so the staleness cases read a real seen-at version, not `undefined`. Change:

```ts
          .map((l) => { const p = l.params as MotifParams; return { layerId: l.id, motifId: p.motif_id, props: p.props } satisfies MotifLayerRef }),
```

to:

```ts
          .map((l) => { const p = l.params as MotifParams; return { layerId: l.id, motifId: p.motif_id, version: p.motif_version, props: p.props } satisfies MotifLayerRef }),
```

- [ ] **Step 2: Spawn the watcher in `index.ts`**

In `apps/desktop/src/main/index.ts`:

Add the import (beside the other `./motif/*` imports near the top):

```ts
import { spawnMotifWatcher, type MotifWatcher } from './motif/watcher.js'
```

Add a module-scoped handle beside `let tsHost` / `let mainWindow`:

```ts
let motifWatcher: MotifWatcher | null = null
```

After `tsHost.start()` (the `console.log('[main] TS state actor authoritative …')` line), spawn the watcher:

```ts
  // Stage-5 file watch (TS): on any disk change under <userData>/motifs/,
  // refresh the actor catalog (so a disk-written Motif is placeable via
  // add_motif) AND emit motifs:changed (renderer resync → ?v= host buster).
  // Supersedes the Rust watcher (still live until Phase 4 deletes the feature;
  // its duplicate emit is idempotent).
  motifWatcher = spawnMotifWatcher(motifStore.root(), () => {
    tsHost?.refreshMotifCatalog()
    mainWindow?.webContents.send('evt:motifs:changed', {})
  })
```

Close it on quit — add to the existing `app.on('will-quit', …)` (or `before-quit`) handler; if none exists, add:

```ts
  app.on('will-quit', () => { motifWatcher?.close(); motifWatcher = null })
```

(Search `index.ts` for an existing `will-quit`/`before-quit`/`window-all-closed` teardown and fold the `motifWatcher?.close()` into it rather than adding a duplicate handler.)

- [ ] **Step 3: Type-check**

Run: `npm --prefix apps/desktop run -s typecheck`
Expected: clean.

- [ ] **Step 4: Build the e2e bundle + run the motif-lifecycle gate**

The e2e runs the dev `out/` build and needs `VITE_WEFTCUT_E2E=1` (per the media-conformance harness note). Build, then run:

Run (adapt to the repo's e2e scripts in `apps/desktop/package.json`):
```bash
npm --prefix apps/desktop run -s build:e2e   # or the project's e2e build script with VITE_WEFTCUT_E2E=1
npx --prefix apps/desktop playwright test e2e/electron/motif-lifecycle.spec.ts
```
Expected: all THREE sections PASS — A (authoring), **B (staleness reopen, previously failing)**, **C (file-watch hot-reload, previously failing)**. Section B exercises the report row + ack count via the TS path; Section C exercises the watcher → `refreshMotifCatalog` → `add_motif` accepts the disk-written Motif, then the disk rewrite hot-reloads.

If B/C still fail at `addMotifLayer` with `unknown motif_id`: confirm the watcher fired `refreshMotifCatalog` before `add_motif` — the e2e's `waitForMotifInCatalog` polls `list_motifs` (disk-backed, always sees it) but `add_motif` needs the **actor** catalog; the watcher's debounce (400 ms) plus the test's existing poll loops should cover it. Do NOT shorten the debounce to paper over a wiring bug — verify `tsHost.refreshMotifCatalog` is actually invoked (add a temporary `console.log` in the watcher callback, observe it in the Playwright stdout, then remove).

- [ ] **Step 5: Full unit suite + commit**

Run: `npm --prefix apps/desktop run -s test`
Expected: green (no skips beyond the pre-existing CI-only skips).

```bash
git add apps/desktop/src/main/state/ts-actor-host.ts apps/desktop/src/main/index.ts
git commit -m "feat(motifs): spawn the TS file watcher; refresh the actor catalog on disk change"
```

---

## Self-Review

**Spec coverage:**
- §4 staleness (currentVersions / report / ack) → Task 1. ✓
- §5 collapse the compute hybrids to pure-TS (`acknowledge_motif_staleness` was the last one; `install_motif` collapsed in Phase 2) → Task 3 + Task 4. ✓
- §7 phase 3 (staleness.ts + watcher.ts; wire on-open report + ack to the TS path) → Tasks 1–5. ✓
- §9 testing (port the Rust unit suites near-verbatim; debounce unit test mirroring Rust; e2e place→reopen→ack + hot-reload) → Task 1/2 tests + Task 5 e2e. ✓
- §10 risk: Linux recursive watch → try/catch fallback in `spawnMotifWatcher` (Task 2); ship targets use recursive. ✓

**Deferred to Phase 4 (out of scope here, per the spec's phase boundary):** deleting the Rust `motifs` feature, the 4 napi methods (`computeAckMotifRebind` etc.), `watcher.rs` + its `init()` spawn, and moving the motif MCP tool **defs** into TS `MCP_TOOL_DEFS`. The Rust watcher keeps running this phase (idempotent duplicate emit).

**Type consistency:** `MotifStaleEntry` (snake_case) matches the renderer `MotifStaleEntry` (`renderer/ipc/index.ts`) and the e2e assertions. `MotifRebindEntry` `{ layer_id, motif_id, motif_version, props }` matches `state/model.ts`. `MotifLayerRef.version` is read in `runMotifTool` and populated by the host's `motifLayers()` closure (`p.motif_version`) in Task 5 — **note:** Task 5 Step must also add `version: p.motif_version` to the `ts-actor-host.ts` `motifLayers` map literal (line ~176) so the field is populated in production; the staleness cases read it. Add that to Task 5 Step 1.

---

## Task 6 (added during execution): MotifCatalog store-fallback for add_motif

**Why:** The Task 5 e2e run proved the watcher fires + detects disk writes, but Sections B/C still failed — `add_motif` validates against the in-memory `MotifCatalog` cache, refreshed asynchronously (debounced) by the watcher, while `list_motifs` (the e2e's barrier) reads the disk store directly. The two diverge, so a write-then-immediately-place loses the watcher race. User approved the store-fallback fix (vs. relaxing the gate).

**Files:**
- `apps/desktop/src/shared/motifs/catalog.ts` — `MotifCatalog` gains an optional `constructor(resolveMissing?: (id) => Manifest | null)`; `get(id)` chains `builtins ?? cache ?? resolveMissing?.(id) ?? undefined`.
- `apps/desktop/src/main/state/ts-actor-host.ts` — construct the actor's `MotifCatalog` with the resolver wired to `deps.motifStore.getMotif(id)?.manifest ?? null` (undefined when no store → cache-only, unchanged for tests/renderer).
- `apps/desktop/src/main/state/__tests__/add-motif.test.ts` — resolver tests: cache-miss resolves via resolver; absent-everywhere rejects; builtins/cache win (resolver not consulted).

**Verified:** add-motif 17/17; full vitest 2196 green; `tsc -b` clean; all 3 motif-lifecycle e2e PASS. Commit `09b6ecc4`.
