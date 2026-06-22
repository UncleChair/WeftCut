# State-Actor TS Migration — Phase 3b Plan (persistence + `replace_state`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is the SECOND slice of **Phase 3** of the master plan `2026-06-22-state-actor-ts-migration.md` (§Phase 3). Read the **Phase-3a plan** (`…-phase-3a.md`) first — it established the pure-builder-plus-injected-impurity pattern this slice reuses (3a injected `fileExists`; 3b injects `join` and returns files-to-delete), and the oracle-regen workflow + env/toolchain. Phases 0–3a are DONE on local `main` (corpus = **157 sequences / 157 state oracles + 157 summary oracles**; `differential.phase2.test.ts` and `summary.differential.test.ts` each run all 157 with `skipped === []`).

> **SCOPE (decided 2026-06-22, Phase-3 decomposition):** Build the **pure TS persistence surface** — the on-disk `(de)serialize`, the schema-version gate (`io/migrate.rs`), and the load-time media transforms (`path_abs ← dir.join(path_rel)` reconcile + session quick-proxy clear) — plus the **`replace_state`** actor command (the straggler folded into 3b: the wholesale project swap that `project_open`/`project_new_workspace` use). This slice does **NO live wiring**: `persistence.ts` is pure (no `node:fs`), and `replaceState` is exposed on the actor handle but nothing calls it from the renderer/main yet. The actual cutover — Rust `project_open`/`save_as`/`new_workspace` calling the TS actor, autosave re-point, the workspace/cache/LogBus/recents/jobs orchestration — is **Phase 3c**. **OUT OF SCOPE:** the fs read/write/delete shell, autosave + `Backups/` rotation, the `PROJECT_FOLDER_MISSING`/`NOT_PROJECT_FOLDER` folder sentinels, stale-proxy (`proxy_format_version`) invalidation (jobs-gated → 3c), MCP handler port (3d+).

**Goal:** Add `src/main/state/persistence.ts` (pure on-disk serialize/parse/schema-gate/reconcile/quick-proxy-clear, mirroring `io/mod.rs` + `io/migrate.rs`) and the `replace_state` command on the TS actor (mirroring `do_replace_state` + `History::reset`), each gated: persistence by a full-corpus round-trip of the existing Rust-serialized oracle, `replace_state` by riding the existing differential state + summary gates over new corpus sequences.

**Architecture:** Same proven methodology as every prior slice. `persistence.ts` is a set of pure functions over the JSON-native `Project`; filesystem/platform impurities are **injected** (a `join` for path reconcile) or **returned** (the list of quick-proxy files for the caller to delete) — exactly as 3a injected `fileExists`. `replace_state` is a new actor path: validate-first, then `History.reset` to a fresh single-entry stack (the prior project's snapshots/checkpoints reference a different `project_id`), then an unrecorded broadcast — a 1:1 port of `do_replace_state`. The "Rust writes `project.json` / TS reads it" constraint (master-plan Global Constraint, currently **ungated** — no real `.vproj` fixtures exist) is gated by round-tripping the existing `oracle/` final-step state through the TS loader.

**Tech Stack:** TypeScript, Vitest, the existing TS actor (`createActor`, `History`), `serialize.ts`/`canonical.ts`/`model.ts`, the Rust `replay_driver` bin + `gen-state-oracle.mjs` (Task 4 only). No new dependencies. No Immer/mutation-engine changes beyond the `replace_state`/`History.reset` path. The wasm eval leaf is untouched.

## Global Constraints

- **The oracle-regeneration toolchain (verified working through 3a; needed only in Task 4).** Set these env vars before any `cargo`/regen, then run from `apps/desktop/`:
  ```bash
  export FFMPEG_DIR="C:/Users/jonny/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Shared_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build-shared"
  export LIBCLANG_PATH="C:/Program Files/LLVM/bin"
  export PATH="$FFMPEG_DIR/bin:$PATH"
  node scripts/gen-state-oracle.mjs   # builds replay_driver, regenerates oracle/ AND oracle-summary/ for ALL sequences
  ```
  The build feature set is baked into `gen-state-oracle.mjs` (`--features replay,jobs,export,mcp,cloud,motifs`; bare `replay` fails on a pre-existing `napi_backend.rs` error).
- **★ ADDITIVITY (the load-bearing safety constraint for Task 4).** Task 4 adds a `replace_state` arm to `replay_driver` (fires ONLY on `replace_state` ops, which no existing sequence uses) and **N new** sequences. After regen, the **157 pre-existing `oracle/*.json` and 157 pre-existing `oracle-summary/*.json` must be byte-identical**; only the N new sequences add new files. Verify with `git status --short fixtures/state-corpus/oracle/ fixtures/state-corpus/oracle-summary/` — every existing file must be unmodified (no `M`), and you should see exactly N new `??` files in each dir. If ANY existing oracle shows `M`, STOP — the new arm leaked into the default path; investigate before continuing.
- **★ `replace_state` ID CONTRACT (the keystone landmine).** A successful `replace_state` consumes **5 deterministic ids** in this exact order, and the differential gates verify a trailing op's id reveals that count:
  1. `Project::new_blank(name)` / `blankProject(idGen, name)` mints **3** ids — A-roll, B-roll, `project_id` (the Phase-0 order; `replay_driver.rs:25` and `model.ts:120` agree).
  2. `History::reset` / `History.reset` mints **1** id — the `"Initial"` entry's `op_id` (`history.rs:320 op_id: new_id()`).
  3. `broadcast_unrecorded` / `broadcastUnrecorded` mints **1** id — the `ChangeEvent` op id (`actor.ts:92`, proven aligned by every existing unrecorded op).
  A `validate`-failure mints **0** ids (validate runs before `reset`), exactly like the `add_layer` validate-fail pattern. Each `replace_state` corpus sequence MUST end with a trailing id-minting op (e.g. `add_track`) so the gate proves the counter is at `base + 5`.
- **★ MEDIA-PATH RECONCILE is platform-dependent → NOT differential-gated.** `load_from_dir` reconciles `path_abs = dir.join(path_rel)` for every media item whose `path_rel` is populated (`io/mod.rs:73-86`). `std::path::join` is OS-native (backslashes on Windows); a differential gate would be platform-fragile, and the corpus media all have `path_rel: null` anyway (so the branch never fires in the corpus — exactly like 3a's `available`/proxy fields were `false`/`null`). `reconcileMediaPaths` therefore takes an **injected `join`** and is **unit-tested only** (mirroring `io/mod.rs`'s `load_reconciles_path_abs_from_path_rel` / `load_leaves_path_abs_alone_when_path_rel_is_none`). Phase 3c wires `node:path`'s platform `join`.
- **★ QUICK-PROXY CLEAR returns files-to-delete; the fs delete is the caller's (3c).** `clear_session_quick_proxies` (`io/mod.rs:112`) sets `quick_proxy_path = None` on every item AND best-effort deletes the file. The pure TS port sets the field to `null` and **returns the list of paths** the caller should delete — staying pure (no `node:fs`), exactly as 3a injected `fileExists` rather than touching the disk.
- **★ STALE-PROXY (`proxy_format_version`) INVALIDATION is DEFERRED to 3c.** `invalidate_stale_proxies` (`io/mod.rs:151`) is `#[cfg(feature = "jobs")]` and depends on `jobs::proxy::PROXY_FORMAT_VERSION` — a derivative-job concern. The master-plan Phase 3c owns the jobs-callback re-point; the stale-proxy sweep rides with it. `loadProjectFromJson` does NOT do it (documented in `persistence.ts`).
- **Schema gate = port `io/migrate.rs` messages.** Equal → ok; below → `"project schema v{got} is below the supported minimum v{SCHEMA_VERSION}. Pre-release builds don't migrate older `.vproj` folders forward — re-create the project in a fresh workspace."`; above → `"project schema v{got} is newer than this build (v{SCHEMA_VERSION}). Update the app."`. `SCHEMA_VERSION = 9` (`model.ts:4`).
- **On-disk write shape = `serde_json::to_string_pretty` (`io/mod.rs:25`).** 2-space indent, **no trailing newline** (`fs::write` writes the string verbatim). Byte-identical key ORDER vs Rust (struct field order) is NOT a goal and is NOT achievable from a JS object literal — the contract is **round-trip fidelity** (parse∘serialize is identity over the canonical shape), gated in Task 5, not byte-identity.
- **TimeUs is `number`.** Every commit message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. `git add` by **explicit path only** (parallel sessions — feedback_parallel_sessions_git). Work on local `main`; do **NOT** push. TDD, frequent commits, DRY, YAGNI.

### Reference sources (cite; re-read only if a step diverges)

- **Persistence (Rust):** `io::save_to_dir` (`native/src/io/mod.rs:24-37`, `to_string_pretty` + write); `io::load_from_dir` (`mod.rs:49-107`: read → `from_str` → `migrate::run` → reconcile `path_abs` from `path_rel` (73-86) → `invalidate_stale_proxies` jobs-only (97) → `clear_session_quick_proxies` (98,112)); `migrate::run` (`io/migrate.rs:20-44`, the schema gate + messages); constants `PROJECT_FILE="project.json"`/`MEDIA_DIR="Media"`/`BACKUPS_DIR="Backups"` (`mod.rs:19-21`). The Rust round-trip + reconcile tests (`mod.rs:182-460`) are the unit-test templates.
- **`replace_state` (Rust):** `do_replace_state` (`actor.rs:3581-3598`: `validate(&next)?` → `Arc::new(next)` → `history.reset(snapshot, actor)` → `broadcast_unrecorded("Replaced project state", snapshot)`; `modified_at` NOT touched); `History::reset` (`history.rs:318-334`: clear snapshots, push one `"Initial"` entry `op_id: new_id()`, cursor 0, `checkpoints.clear()`, `lock = None`); public `replace_state` (`actor.rs:1146-1161`); the consumer `commands/persistence.rs:project_open` (`:86-89` calls `handle.replace_state(Actor::User, project)`); invariants `replace_state_resets_history_to_fresh_stack` / `replace_state_does_not_touch_modified_at` (`actor/tests.rs:2050-2109`).
- **TS pieces already in place:** `serializeProject`/`parseProject` (`serialize.ts`); `canonicalize`/`canonicalString` (`canonical.ts:7,20`); `History` class with private `snapshots`/`cursor`/`checkpoints`/`lockReasonStr` + the constructor that seeds the `"Initial"` entry (`history.ts:29-39`); `createActor`/`commit`/`runValidate`/`broadcastUnrecorded` + the string `dispatch` switch (`actor.ts:55-322`); `blankProject(idGen, name)` (`model.ts:120-130`, mints A-roll/B-roll/project_id then default 1920×1080@30 composition); `SCHEMA_VERSION`/`Project`/`Composition`/`MediaItem`/`Rational` (`model.ts:4,76,86,98`); `CommandFailure`/`ValidationFailure`/`runValidate` semantics (`errors.ts:61-72`, `actor.ts:66-71`); `SUPPORTED_OPS`/`buildArgs`/`runSequence` (`replay.ts:10,103,57`); the existing gates `__tests__/differential.phase2.test.ts` + `__tests__/summary.differential.test.ts` (both glob `sequences/`, assert per-file supported, compare `JSON.stringify` of canonicalized state/summary, and assert `ok`/error variants).
- **The harness:** `replay_driver.rs` `apply()` match (`:90-282`) + `media_item` template (`:335`); `gen-state-oracle.mjs` (run-twice determinism gate, writes `oracle/` + `oracle-summary/`).

---

## File Structure

All code paths under `apps/desktop/`. Vitest + git commands run from `apps/desktop/` (`git add` uses the `apps/desktop/…` prefix from repo root). The plan doc lives at repo-root `docs/superpowers/plans/`.

| Path | Responsibility | New/Mod |
|---|---|---|
| `src/main/state/persistence.ts` | `serializeProjectToJson`/`schemaGate`/`parseProjectJson` (Task 1); `reconcileMediaPaths`/`clearSessionQuickProxies`/`loadProjectFromJson` (Task 2). Pure; no `node:fs`. | **New** |
| `src/main/state/persistence.test.ts` | Unit tests: serialize/schema-gate (Task 1); reconcile/quick-proxy/load (Task 2). | **New** |
| `src/main/state/history.ts` | Add `reset(initial, actor, opId, timestamp?)`. | Mod (Task 3) |
| `src/main/state/actor.ts` | Add `replaceState(next)` closure + `replace_state` dispatch arm + expose `replaceState` on `ActorHandle`; `import { blankProject }`. | Mod (Task 3) |
| `src/main/state/actor.test.ts` | `replace_state` unit tests (history reset, validate-fail, modified_at, id contract). | Mod (Task 3) |
| `src/main/state/replay.ts` | Add `'replace_state'` to `SUPPORTED_OPS` + a `buildArgs` arm. | Mod (Task 3) |
| `native/src/bin/replay_driver.rs` | Add the `replace_state` `apply()` arm. | Mod (Task 4) |
| `fixtures/state-corpus/sequences/replace-state-*.json` | N new corpus sequences exercising `replace_state`. | **New** (Task 4) |
| `fixtures/state-corpus/oracle/*.json` + `oracle-summary/*.json` | N new oracle traces (existing 157 each byte-identical). | **New (generated)** (Task 4) |
| `src/main/state/__tests__/persistence.differential.test.ts` | THE round-trip gate: Rust-serialized oracle state → TS loader → re-serialize === oracle (full corpus). | **New** (Task 5) |
| `fixtures/state-corpus/README.md` | Note the `replace_state` sequences + the persistence round-trip gate. | Mod (Task 5) |

> Tasks 1–3 are pure-TS (unit-gated). Task 4 is the only Rust/oracle task; it grows the existing state + summary gates from 157 to 157+N. Task 5 is the persistence round-trip gate (needs Task 2's loader).

---

## Task 1: `persistence.ts` — on-disk serialize + schema gate

**Files:**
- Create: `src/main/state/persistence.ts`
- Test: `src/main/state/persistence.test.ts`

**Interfaces:**
- Produces:
  - `serializeProjectToJson(p: Project): string` — `to_string_pretty`-equivalent (2-space indent, no trailing newline).
  - `schemaGate(project: unknown): void` — throws with the `io/migrate.rs` below/above guidance; returns for the current version.
  - `parseProjectJson(text: string): Project` — `JSON.parse` → `schemaGate` → typed `Project`.
- Consumes: `serializeProject`/`parseProject` from `./serialize`; `SCHEMA_VERSION`/`Project` from `./model`.

- [ ] **Step 1: Write the failing tests** (`src/main/state/persistence.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject, SCHEMA_VERSION } from './model'
import { canonicalString } from './canonical'
import { serializeProject } from './serialize'
import { serializeProjectToJson, schemaGate, parseProjectJson } from './persistence'

describe('serializeProjectToJson (mirror io/mod.rs:25 to_string_pretty)', () => {
  it('pretty-prints with 2-space indent and no trailing newline', () => {
    const p = blankProject(seededGen(), 'doc')
    const json = serializeProjectToJson(p)
    expect(json.startsWith('{\n  "schema_version": 9')).toBe(true)
    expect(json.endsWith('\n')).toBe(false)
    expect(json.includes('\n    ')).toBe(true) // nested 4-space level exists
  })
  it('round-trips through parseProjectJson canonically', () => {
    const p = blankProject(seededGen(), 'doc')
    const back = parseProjectJson(serializeProjectToJson(p))
    expect(canonicalString(serializeProject(back))).toBe(canonicalString(serializeProject(p)))
  })
})

describe('schemaGate (mirror io/migrate.rs:20 run)', () => {
  it('accepts the current schema version', () => {
    expect(() => schemaGate({ schema_version: SCHEMA_VERSION })).not.toThrow()
  })
  it('rejects an older version with fresh-workspace guidance', () => {
    expect(() => schemaGate({ schema_version: SCHEMA_VERSION - 1 }))
      .toThrow(/below the supported minimum.*fresh workspace/s)
  })
  it('rejects a newer version with update-the-app guidance', () => {
    expect(() => schemaGate({ schema_version: SCHEMA_VERSION + 5 }))
      .toThrow(/newer than this build.*Update the app/s)
  })
  it('rejects a non-numeric / absent version', () => {
    expect(() => schemaGate({})).toThrow(/schema/i)
  })
})

describe('parseProjectJson', () => {
  it('throws on malformed JSON', () => {
    expect(() => parseProjectJson('{not json')).toThrow()
  })
  it('throws on a wrong schema version (gate before cast)', () => {
    const p = blankProject(seededGen(), 'doc')
    const bad = JSON.stringify({ ...serializeProject(p), schema_version: 8 } as object)
    expect(() => parseProjectJson(bad)).toThrow(/below the supported minimum/)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/persistence.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/main/state/persistence.ts`:

```ts
// apps/desktop/src/main/state/persistence.ts
//
// The PURE on-disk persistence surface — mirrors native/src/io/mod.rs (save/load)
// + native/src/io/migrate.rs (the schema-version gate). No node:fs here: the file
// read/write/delete shell + the workspace/cache/LogBus/recents/jobs orchestration
// stay in Rust until Phase 3c wires this module's pure functions into the
// project_open/save_as/new_workspace cutover. Filesystem/platform impurities are
// injected (`join` for path reconcile) or returned (quick-proxy files to delete).
import { SCHEMA_VERSION, type Project } from './model'
import { serializeProject, parseProject } from './serialize'

/** io/mod.rs:25 — serde_json::to_string_pretty (2-space indent, NO trailing
 *  newline; fs::write writes the string verbatim). Round-trip fidelity, not
 *  byte-identical key order vs Rust, is the contract (see Task 5). */
export function serializeProjectToJson(p: Project): string {
  return JSON.stringify(serializeProject(p), null, 2)
}

/** io/migrate.rs:20 run — the schema-version gate. Equal → ok; below → re-create
 *  in a fresh workspace; above → update the app. Pre-release: no migration path. */
export function schemaGate(project: unknown): void {
  const v = (project as { schema_version?: unknown })?.schema_version
  if (v === SCHEMA_VERSION) return
  if (typeof v === 'number' && v < SCHEMA_VERSION) {
    throw new Error(
      `project schema v${v} is below the supported minimum v${SCHEMA_VERSION}. ` +
      `Pre-release builds don't migrate older \`.vproj\` folders forward — ` +
      `re-create the project in a fresh workspace.`,
    )
  }
  if (typeof v === 'number') {
    throw new Error(`project schema v${v} is newer than this build (v${SCHEMA_VERSION}). Update the app.`)
  }
  throw new Error(`project schema version is missing or non-numeric (expected ${SCHEMA_VERSION})`)
}

/** io/mod.rs:57 — deserialize project.json text → Project, gated on schema version.
 *  JSON.parse throws on malformed text; schemaGate runs BEFORE the structural cast
 *  so the rich version-specific guidance wins over parseProject's generic check. */
export function parseProjectJson(text: string): Project {
  const json: unknown = JSON.parse(text)
  schemaGate(json)
  return parseProject(json)
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/main/state/persistence.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/persistence.ts apps/desktop/src/main/state/persistence.test.ts
git commit -m "feat(state-migration): persistence.ts serialize + schema gate (Phase 3b)"
```

---

## Task 2: `persistence.ts` — load transforms (reconcile + quick-proxy clear + `loadProjectFromJson`)

**Files:**
- Modify: `src/main/state/persistence.ts`
- Test: `src/main/state/persistence.test.ts`

**Interfaces:**
- Consumes: the Task-1 functions; `Project`/`MediaItem` from `./model`.
- Produces:
  - `reconcileMediaPaths(p: Project, dir: string, join: (...parts: string[]) => string): Project` — recompute `path_abs = join(dir, path_rel)` for items with a populated `path_rel`.
  - `clearSessionQuickProxies(p: Project): { project: Project; quickProxiesToDelete: string[] }` — null every `quick_proxy_path`; report the paths to delete.
  - `loadProjectFromJson(text: string, opts: { dir: string; join: (...parts: string[]) => string }): { project: Project; quickProxiesToDelete: string[] }` — parse → schema-gate → reconcile → quick-proxy clear (NO stale-proxy invalidation — deferred to 3c).

- [ ] **Step 1: Add failing tests** to `src/main/state/persistence.test.ts`:

```ts
import { reconcileMediaPaths, clearSessionQuickProxies, loadProjectFromJson } from './persistence'
import type { MediaItem, Project } from './model'

const posixJoin = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')

function mediaItem(over: Partial<MediaItem>): MediaItem {
  return {
    id: '00000000-0000-0000-0000-0000000000aa', label: null,
    path_abs: '/saved/at/Media/clip.mp4', path_rel: 'Media/clip.mp4', kind: 'Video',
    metadata: { duration_us: 1_000_000 }, file_hash_blake3: 'deadbeef', file_size: 0, file_mtime: 0,
    imported_at: '2026-01-01T00:00:00Z', proxy_path: null, quick_proxy_path: null,
    proxy_bypassed: false, export_uses_original: false, proxy_format_version: 0,
    conform_path: null, waveform_path: null, thumbnails_dir: null, ...over,
  }
}
function withMedia(items: MediaItem[]): Project {
  return {
    schema_version: 9, project_id: 'p', metadata: { name: 'm', created_at: '<TS>', modified_at: '<TS>', description: null },
    composition: { width: 1920, height: 1080, fps: { num: 30, den: 1 }, duration_us: 0, duration_pinned: false,
      sample_rate: 48000, channels: 2, color_space: 'Bt709', background: { r: 0, g: 0, b: 0, a: 255 } },
    media_pool: Object.fromEntries(items.map((i) => [i.id, i])), tracks: [], markers: [],
    transitions: [], groups: [], audio_roles: {}, settings: { auto_delete_empty_tracks: true },
  }
}

describe('reconcileMediaPaths (mirror io/mod.rs:73 path_abs ← dir.join(path_rel))', () => {
  it('rewrites path_abs from path_rel against the new workspace dir', () => {
    const p = withMedia([mediaItem({ path_rel: 'Media/clip.mp4', path_abs: '/old/Media/clip.mp4' })])
    const out = reconcileMediaPaths(p, '/new/ws.vproj', posixJoin)
    expect(out.media_pool['00000000-0000-0000-0000-0000000000aa'].path_abs).toBe('/new/ws.vproj/Media/clip.mp4')
  })
  it('leaves path_abs alone when path_rel is null (pending import / synthesized media)', () => {
    const p = withMedia([mediaItem({ path_rel: null, path_abs: '/external/source/video.mp4' })])
    const out = reconcileMediaPaths(p, '/new/ws.vproj', posixJoin)
    expect(out.media_pool['00000000-0000-0000-0000-0000000000aa'].path_abs).toBe('/external/source/video.mp4')
  })
})

describe('clearSessionQuickProxies (mirror io/mod.rs:112)', () => {
  it('nulls quick_proxy_path and reports the file to delete', () => {
    const p = withMedia([mediaItem({ quick_proxy_path: '/ws/clip.quick.mp4' })])
    const { project, quickProxiesToDelete } = clearSessionQuickProxies(p)
    expect(project.media_pool['00000000-0000-0000-0000-0000000000aa'].quick_proxy_path).toBeNull()
    expect(quickProxiesToDelete).toEqual(['/ws/clip.quick.mp4'])
  })
  it('reports nothing when no quick proxies are set', () => {
    expect(clearSessionQuickProxies(withMedia([mediaItem({ quick_proxy_path: null })])).quickProxiesToDelete).toEqual([])
  })
})

describe('loadProjectFromJson', () => {
  it('parses, reconciles, and clears quick proxies in one pass', () => {
    const p = withMedia([mediaItem({ path_rel: 'Media/clip.mp4', path_abs: '/old/Media/clip.mp4', quick_proxy_path: '/old/clip.quick.mp4' })])
    const text = JSON.stringify(p)
    const { project, quickProxiesToDelete } = loadProjectFromJson(text, { dir: '/moved.vproj', join: posixJoin })
    const m = project.media_pool['00000000-0000-0000-0000-0000000000aa']
    expect(m.path_abs).toBe('/moved.vproj/Media/clip.mp4')
    expect(m.quick_proxy_path).toBeNull()
    expect(quickProxiesToDelete).toEqual(['/old/clip.quick.mp4'])
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/persistence.test.ts` → FAIL (`reconcileMediaPaths` not exported).

- [ ] **Step 3: Implement** — append to `src/main/state/persistence.ts`. First widen the model import:
```ts
import { SCHEMA_VERSION, type MediaItem, type Project } from './model'
```
Then append:
```ts
/** io/mod.rs:73-86 — on load, an item whose `path_rel` is populated has its
 *  in-memory `path_abs` recomputed as join(dir, path_rel), reconciling the saved
 *  absolute path with the current (possibly-moved) workspace location. Items with
 *  `path_rel === null` (import-worker copy pending, or synthesized Cache/ media)
 *  keep their serialized `path_abs` verbatim. `join` is injected (platform-native
 *  in 3c via node:path; a posix joiner in tests) — see the plan's path landmine. */
export function reconcileMediaPaths(p: Project, dir: string, join: (...parts: string[]) => string): Project {
  const media_pool: Record<string, MediaItem> = {}
  for (const [id, item] of Object.entries(p.media_pool)) {
    media_pool[id] = item.path_rel ? { ...item, path_abs: join(dir, item.path_rel) } : item
  }
  return { ...p, media_pool }
}

/** io/mod.rs:112 — quick proxies are session-scoped preview accelerators; never
 *  trust serialized paths across launches. Null every `quick_proxy_path` and
 *  return the files for the caller (Phase 3c) to delete best-effort — staying
 *  pure (no node:fs), the way 3a injected `fileExists`. */
export function clearSessionQuickProxies(p: Project): { project: Project; quickProxiesToDelete: string[] } {
  const quickProxiesToDelete: string[] = []
  const media_pool: Record<string, MediaItem> = {}
  for (const [id, item] of Object.entries(p.media_pool)) {
    if (item.quick_proxy_path) { quickProxiesToDelete.push(item.quick_proxy_path); media_pool[id] = { ...item, quick_proxy_path: null } }
    else media_pool[id] = item
  }
  return { project: { ...p, media_pool }, quickProxiesToDelete }
}

/** io/mod.rs:49 load_from_dir — the pure half: parse + schema-gate + media path
 *  reconcile + quick-proxy clear. NOTE: stale-proxy (proxy_format_version)
 *  invalidation is `#[cfg(feature = "jobs")]` in Rust and rides the Phase-3c
 *  jobs-callback re-point; it is deliberately NOT done here. */
export function loadProjectFromJson(text: string, opts: { dir: string; join: (...parts: string[]) => string }): { project: Project; quickProxiesToDelete: string[] } {
  const parsed = parseProjectJson(text)
  const reconciled = reconcileMediaPaths(parsed, opts.dir, opts.join)
  return clearSessionQuickProxies(reconciled)
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/main/state/persistence.test.ts` → PASS (Task-1 tests still green).

- [ ] **Step 5: Typecheck + commit.**
```bash
# npm run typecheck (clean)
git add apps/desktop/src/main/state/persistence.ts apps/desktop/src/main/state/persistence.test.ts
git commit -m "feat(state-migration): persistence load transforms (reconcile + quick-proxy clear) (Phase 3b)"
```

---

## Task 3: `replace_state` on the TS actor (`History.reset` + `replaceState` + dispatch + vocab)

**Files:**
- Modify: `src/main/state/history.ts`, `src/main/state/actor.ts`, `src/main/state/replay.ts`
- Test: `src/main/state/actor.test.ts`

**Interfaces:**
- Produces:
  - `History.reset(initial: Project, actor: Actor, opId: Uuid, timestamp?: string): void`.
  - `ActorHandle.replaceState(next: Project): void` (new handle method; what Phase-3c `project_open` calls directly with a parsed-from-disk project).
  - A `replace_state` string-dispatch arm (the differential-corpus vehicle: builds a blank-from-args project then calls `replaceState`).
  - `'replace_state'` in `SUPPORTED_OPS` + a `buildArgs` arm `{ name, width, height, fps_num, fps_den }`.
- Consumes: `blankProject` from `./model`; existing `runValidate`/`broadcastUnrecorded`/`History`.

- [ ] **Step 1: Write the failing tests** (`src/main/state/actor.test.ts` — append a describe block):

```ts
import { describe, it, expect } from 'vitest'
import { seededGen } from './ids'
import { blankProject } from './model'
import { createActor } from './actor'
import type { Project } from './model'

describe('replace_state (mirror do_replace_state actor.rs:3581 + History::reset)', () => {
  it('resets history to a fresh single-entry stack and clears redo/checkpoints/lock', () => {
    const gen = seededGen()
    const actor = createActor({ initial: blankProject(gen, 'orig'), idGen: gen, clock: () => '<TS>' })
    actor.dispatch('add_track', { label: 'x' })            // cursor 1, len 2
    actor.lockHistory('busy')
    actor.replaceState(blankProject(gen, 'replaced'))
    const s = actor.historyStatus()
    expect([s.cursor, s.len, s.can_undo, s.can_redo]).toEqual([0, 1, false, false])
    expect(s.lock_reason).toBeUndefined()                  // reset clears the lock
    expect(actor.snapshot().metadata.name).toBe('replaced')
  })
  it('a validate-failure leaves history untouched (validate runs first, mints no id)', () => {
    const gen = seededGen()
    const actor = createActor({ initial: blankProject(gen, 'orig'), idGen: gen, clock: () => '<TS>' })
    actor.dispatch('add_track', { label: 'x' })
    const before = actor.snapshot()
    // A group with <2 members violates the group-size invariant (§2.4) → the
    // simplest deterministic ValidationFailed without constructing layer params.
    const bad: Project = blankProject(seededGen(), 'bad')
    bad.groups = [{ id: '00000000-0000-0000-0000-0000000000b1', members: ['00000000-0000-0000-0000-0000000000a1'] }]
    expect(() => actor.replaceState(bad)).toThrow()
    expect(actor.snapshot()).toEqual(before)               // history + state unchanged
  })
  it('does not touch modified_at (loading a project is not a dirty edit)', () => {
    const gen = seededGen()
    const actor = createActor({ initial: blankProject(gen, 'orig'), idGen: gen, clock: () => '<TS>' })
    const next = blankProject(gen, 'on-disk')
    next.metadata.modified_at = '2026-01-02T03:04:05Z'
    actor.replaceState(next)
    expect(actor.snapshot().metadata.modified_at).toBe('2026-01-02T03:04:05Z')
  })
})
```
> The validate-fail id-counter property is fully nailed by the Task-4 differential gate (a trailing op's id reveals the `base + 5` count on success / no advance on failure). The unit test asserts the observable: a failed `replaceState` throws and leaves the snapshot byte-equal.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/main/state/actor.test.ts` → FAIL (`replaceState` not a function).

- [ ] **Step 3a: Add `reset` to `History`** (`src/main/state/history.ts`, after the constructor at line 39):
```ts
  /** native/src/state/history.rs:318 reset — discard the stack + checkpoints +
   *  lock, seed a fresh single 'Initial' entry. Used by replace_state on a
   *  project swap: the prior project's snapshots/checkpoints reference a
   *  different project_id and are incoherent against the new state. */
  reset(initial: Project, actor: Actor, opId: Uuid, timestamp = '<TS>'): void {
    this.snapshots = [{ op_id: opId, actor, timestamp, summary: 'Initial', affected: [], snapshot: initial }]
    this.cursor = 0
    this.checkpoints.clear()
    this.lockReasonStr = null
  }
```
> `Actor` and `Uuid` are already imported in `history.ts` (line 2/4).

- [ ] **Step 3b: Add `replaceState` + the dispatch arm to `actor.ts`.** Add the value import (line 3 currently imports model TYPES only — add a separate value import):
```ts
import { blankProject } from './model'
```
Add the `replaceState` closure next to the other dedicated paths (after `updateProjectSettings`, ~line 233):
```ts
  // ── replace_state (do_replace_state:3581) — wholesale project swap. validate
  //    FIRST (a failure mints NO id and leaves history intact); on success reset
  //    history to a single 'Initial' entry (drops the old project's snapshots +
  //    checkpoints + lock — they reference a different project_id) then broadcast
  //    unrecorded. modified_at is NOT touched. Mints exactly 2 ids on success
  //    (reset op_id + broadcast event id); a caller that built `next` via
  //    blankProject already spent its 3 ids → 5 total (see the plan's id contract). ──
  function replaceState(next: Project): void {
    runValidate(next)                              // throws CommandFailure(ValidationFailed); no id spent
    history.reset(next, actor, idGen(), clock())   // +1 id (the 'Initial' op_id)
    broadcastUnrecorded('Replaced project state', current())  // +1 id (the event op_id)
  }
```
Add the dispatch arm inside the `switch (channel)` (before `default:`, ~line 315):
```ts
        case 'replace_state': {
          // Differential-corpus vehicle: build a blank from the args (mirrors
          // Project::new_blank + project_new_workspace's canvas override) so both
          // engines mint the same 3 blank ids before the swap. Production callers
          // (Phase 3c project_open) call replaceState(loadedProject) directly.
          const next = blankProject(idGen, (a.name as string) ?? 'untitled')
          if (typeof a.width === 'number') next.composition.width = a.width
          if (typeof a.height === 'number') next.composition.height = a.height
          if (typeof a.fps_num === 'number' && typeof a.fps_den === 'number') next.composition.fps = { num: a.fps_num, den: a.fps_den }
          replaceState(next)
          return { ok: true, value: null }
        }
```
Expose `replaceState` on the handle — add to the `ActorHandle` interface (after `dispatch`, ~line 46):
```ts
  replaceState(next: Project): void
```
and to the returned object (after `dispatch,` ~line 326):
```ts
    replaceState,
```

- [ ] **Step 3c: Add the vocabulary + args arm to `replay.ts`.** Add `'replace_state'` to `SUPPORTED_OPS` (line 24 area):
```ts
  'add_caption_track', 'restyle_caption_track',
  'replace_state',
```
Add the `buildArgs` arm (before `case 'undo':`, ~line 143):
```ts
    case 'replace_state': return { name: cmd.name ?? 'untitled', width: cmd.width, height: cmd.height, fps_num: cmd.fps_num, fps_den: cmd.fps_den }
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/main/state/actor.test.ts` → PASS. Then the full state suite to confirm no regression: `npx vitest run src/main/state` → all green. Then `npm run typecheck` → clean.

- [ ] **Step 5: Commit.**
```bash
git add apps/desktop/src/main/state/history.ts apps/desktop/src/main/state/actor.ts apps/desktop/src/main/state/actor.test.ts apps/desktop/src/main/state/replay.ts
git commit -m "feat(state-migration): replace_state on the TS actor + History.reset (Phase 3b)"
```

---

## Task 4: Rust driver `replace_state` arm + corpus sequences + additive regen

**Files:**
- Modify: `native/src/bin/replay_driver.rs`
- Create: `fixtures/state-corpus/sequences/replace-state-*.json` (4 sequences)
- Generate: 4 new `oracle/*.json` + 4 new `oracle-summary/*.json` (existing 157 each byte-identical)

- [ ] **Step 1: Add the `replace_state` arm to `replay_driver.rs` `apply()`** (before the `other =>` arm at line 280):
```rust
        "replace_state" => {
            // Build a blank from the args (mirrors Project::new_blank +
            // project_new_workspace's canvas override). new_blank mints ids
            // #(A,B,project); the subsequent replace_state mints reset's op_id +
            // broadcast_unrecorded's event id → 5 ids total (see the plan).
            let mut project = state::Project::new_blank(cmd["name"].as_str().unwrap_or("untitled"));
            if let Some(w) = cmd["width"].as_u64() { project.composition.width = w as u32; }
            if let Some(hh) = cmd["height"].as_u64() { project.composition.height = hh as u32; }
            if let (Some(n), Some(d)) = (cmd["fps_num"].as_u64(), cmd["fps_den"].as_u64()) {
                // fps inputs MUST be pre-reduced (den=1 in the corpus) so this
                // matches the TS `{num,den}` literal regardless of any reduction.
                project.composition.fps = weftcut_lib::state::time::Rational { num: n as u32, den: d as u32 };
            }
            h.replace_state(u, project).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
```

- [ ] **Step 2: Author the 4 corpus sequences.** Each ends with a trailing id-minting op to expose the id contract. Use only den=1 fps.

Create `fixtures/state-corpus/sequences/replace-state-resets-history.json`:
```json
{
  "name": "replace-state-resets-history",
  "commands": [
    { "op": "add_track", "label": "extra" },
    { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 1000000 },
    { "op": "replace_state", "name": "fresh" },
    { "op": "add_track", "label": "after" }
  ]
}
```

Create `fixtures/state-corpus/sequences/replace-state-canvas.json`:
```json
{
  "name": "replace-state-canvas",
  "commands": [
    { "op": "replace_state", "name": "hd", "width": 1280, "height": 720, "fps_num": 60, "fps_den": 1 },
    { "op": "add_layer", "track": "@A", "kind": "color", "t_start_us": 0, "t_end_us": 500000 }
  ]
}
```

Create `fixtures/state-corpus/sequences/replace-state-clears-redo.json`:
```json
{
  "name": "replace-state-clears-redo",
  "commands": [
    { "op": "add_track", "label": "extra" },
    { "op": "undo" },
    { "op": "replace_state", "name": "x" },
    { "op": "redo" },
    { "op": "add_track", "label": "after" }
  ]
}
```

Create `fixtures/state-corpus/sequences/replace-state-then-undo.json`:
```json
{
  "name": "replace-state-then-undo",
  "commands": [
    { "op": "add_track", "label": "extra" },
    { "op": "replace_state", "name": "y" },
    { "op": "undo" },
    { "op": "add_track", "label": "after" }
  ]
}
```
> `replace-state-clears-redo` proves `redo` after a reset → `NothingToRedo` (the redo tail was dropped); `replace-state-then-undo` proves `undo` after a reset → `NothingToUndo` (the single-entry stack can't reach the old project). Both the `state` and `summary` oracles cover these, and the trailing `add_track` proves the id counter.

- [ ] **Step 3: Sanity-check the new arm emits both modes** (env vars per Global Constraints, from `apps/desktop/`):
```bash
cargo run --quiet --manifest-path native/Cargo.toml --bin replay_driver --features replay,jobs,export,mcp,cloud,motifs -- fixtures/state-corpus/sequences/replace-state-canvas.json | head -c 500
REPLAY_EMIT=summary cargo run --quiet --manifest-path native/Cargo.toml --bin replay_driver --features replay,jobs,export,mcp,cloud,motifs -- fixtures/state-corpus/sequences/replace-state-resets-history.json | head -c 500
```
Expected: the canvas run shows `"width":1280,"height":720` and `"fps":{...60...}` in the post-replace `state`; the resets-history summary run shows `"history":{...}` going to `cursor 0,len 1` after `replace_state` then `cursor 1,len 2` after the trailing `add_track`.

- [ ] **Step 4: Regenerate the corpus** (env vars per Global Constraints, from `apps/desktop/`):
```bash
node scripts/gen-state-oracle.mjs
```

- [ ] **Step 5: Verify ADDITIVITY** — the 4 new sequences add 4 files to each oracle dir; the existing 157 must be byte-identical:
```bash
git status --short fixtures/state-corpus/oracle/          # EXACTLY 4 new ?? (no M on the existing 157)
git status --short fixtures/state-corpus/oracle-summary/  # EXACTLY 4 new ?? (no M on the existing 157)
```
If ANY existing oracle shows `M`, STOP — the new arm leaked into the default path (it must fire only on `replace_state` ops); investigate before continuing.

- [ ] **Step 6: Run the existing differential gates — they auto-extend to 161** (Vitest from `apps/desktop/`):
```bash
npx vitest run src/main/state/__tests__/differential.phase2.test.ts   # 161/161, skipped === []
npx vitest run src/main/state/__tests__/summary.differential.test.ts  # 161/161, skipped === []
```
> Both gates glob `sequences/`, so the 4 new files are picked up automatically; `replace_state` is in `SUPPORTED_OPS` (Task 3) so none are skipped. If a `replace_state` step diverges, the failure names `<file> @ step <i>`: the usual culprit is the id contract (a trailing op's id off by one → re-check the 5-id count) or a canvas field; re-read `do_replace_state`/`History::reset`, do NOT touch the oracle.

- [ ] **Step 7: Commit** (existing oracles are unchanged, so only the 4 new files + the driver are staged):
```bash
git add apps/desktop/native/src/bin/replay_driver.rs \
  apps/desktop/fixtures/state-corpus/sequences/replace-state-resets-history.json \
  apps/desktop/fixtures/state-corpus/sequences/replace-state-canvas.json \
  apps/desktop/fixtures/state-corpus/sequences/replace-state-clears-redo.json \
  apps/desktop/fixtures/state-corpus/sequences/replace-state-then-undo.json \
  apps/desktop/fixtures/state-corpus/oracle/replace-state-resets-history.json \
  apps/desktop/fixtures/state-corpus/oracle/replace-state-canvas.json \
  apps/desktop/fixtures/state-corpus/oracle/replace-state-clears-redo.json \
  apps/desktop/fixtures/state-corpus/oracle/replace-state-then-undo.json \
  apps/desktop/fixtures/state-corpus/oracle-summary/replace-state-resets-history.json \
  apps/desktop/fixtures/state-corpus/oracle-summary/replace-state-canvas.json \
  apps/desktop/fixtures/state-corpus/oracle-summary/replace-state-clears-redo.json \
  apps/desktop/fixtures/state-corpus/oracle-summary/replace-state-then-undo.json
git commit -m "test(state-migration): replace_state driver arm + corpus seqs, gates 161/161 (Phase 3b)"
```

---

## Task 5: persistence round-trip differential gate + corpus README

**Files:**
- Create: `src/main/state/__tests__/persistence.differential.test.ts`
- Modify: `fixtures/state-corpus/README.md`

**Interfaces:**
- Consumes: `loadProjectFromJson` (Task 2); `serializeProject` + `canonicalString`; the existing `oracle/*.json` (each step's `state` is Rust's serde output, key-sorted + `<TS>`-normalized).

> **Why this gate:** the master-plan Global Constraint "a `project.json` written by Rust must load in the TS actor" is currently ungated (no real `.vproj` fixtures exist). Each `oracle/<seq>.json` final step's `state` IS a faithful Rust-serialized project (same Serialize impl as `to_string_pretty`; only key order + timestamps normalized, both parse-irrelevant). Feeding it through the real TS loader and re-serializing proves round-trip fidelity across the FULL corpus (rich projects: layers/groups/effects/transitions/markers/media/captions), closing the field-NAME-drift gap (Phase-1 carry-forward (a)) for the persistence surface. Reconcile/quick-proxy are no-ops here (corpus media have `path_rel`/`quick_proxy_path` null) — they are unit-gated in Task 2.

- [ ] **Step 1: Write the failing gate** (`src/main/state/__tests__/persistence.differential.test.ts`):
```ts
// apps/desktop/src/main/state/__tests__/persistence.differential.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalString } from '../canonical'
import { serializeProject } from '../serialize'
import { loadProjectFromJson } from '../persistence'

const ROOT = join(__dirname, '../../../../fixtures/state-corpus')
const ORACLE = join(ROOT, 'oracle')
const posixJoin = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')

describe('Phase 3b persistence: Rust-serialized project.json round-trips through the TS loader (FULL corpus)', () => {
  const files = readdirSync(ORACLE).filter((f) => f.endsWith('.json'))
  for (const f of files) {
    it(`round-trips the final state for ${f}`, () => {
      const oracle = JSON.parse(readFileSync(join(ORACLE, f), 'utf8'))
      const final = oracle.steps[oracle.steps.length - 1].state // Rust's on-disk shape (key-sorted, <TS>-normalized)
      const text = JSON.stringify(final)
      const { project } = loadProjectFromJson(text, { dir: '/ws.vproj', join: posixJoin })
      // The TS loader is an identity over the on-disk shape (reconcile + quick-proxy
      // are no-ops on the corpus): re-serialize must canonical-equal the input.
      expect(canonicalString(serializeProject(project))).toBe(canonicalString(final))
    })
  }
})
```

- [ ] **Step 2: Run to verify it passes** — `npx vitest run src/main/state/__tests__/persistence.differential.test.ts` → PASS (161/161). (It depends only on the already-implemented loader + the regenerated oracle; if a case fails, the input has a field the TS model drops on re-serialize — fix `model.ts`/`serialize.ts`, never the oracle.)

- [ ] **Step 3: Run the full state suite + typecheck** to confirm the whole slice is green together:
```bash
npx vitest run src/main/state   # all green (persistence unit + differential, replace_state, + the existing 157+4 gates)
npm run typecheck               # clean
```

- [ ] **Step 4: Update the corpus README.** Add under the existing oracle/oracle-summary description:
```markdown
### replace_state sequences

`replace-state-*.json` exercise the wholesale project swap (`do_replace_state` →
`History::reset`). They ride the existing `differential.phase2` (state) and
`summary.differential` (history reset: cursor 0 / len 1 / can_undo false) gates;
the trailing `add_track` proves the 5-id contract (3 blank ids + reset op_id +
broadcast id). `replace-state-clears-redo`/`-then-undo` prove the redo/undo stacks
are dropped (NothingToRedo / NothingToUndo).

### persistence round-trip gate

`__tests__/persistence.differential.test.ts` feeds each oracle's final-step `state`
(Rust's serde output) through the TS loader (`persistence.ts loadProjectFromJson`)
and asserts it re-serializes canonical-identically — gating the "Rust writes
project.json, TS reads it" invariant over the full corpus. Media reconcile +
quick-proxy clear are no-ops here (corpus media have null path_rel/quick_proxy_path)
and are unit-gated in `persistence.test.ts`.
```

- [ ] **Step 5: Commit.**
```bash
git add apps/desktop/src/main/state/__tests__/persistence.differential.test.ts apps/desktop/fixtures/state-corpus/README.md
git commit -m "test(state-migration): persistence round-trip gate, full corpus (Phase 3b)"
```

---

## Self-Review

- **Spec coverage:** Phase-3 §3b scope = persistence + `replace_state`. `save_to_dir`→`serializeProjectToJson` (T1); `migrate::run` gate→`schemaGate` (T1); `load_from_dir` parse→`parseProjectJson` (T1), path reconcile→`reconcileMediaPaths` (T2), quick-proxy clear→`clearSessionQuickProxies` (T2), the composed load→`loadProjectFromJson` (T2); `do_replace_state`+`History::reset`→`replaceState`+`History.reset` (T3), differential-gated (T4); the Rust-writes/TS-reads constraint→round-trip gate (T5). Deferred-with-reason: stale-proxy invalidation (jobs-gated→3c), fs read/write/delete + workspace/cache/LogBus/recents/jobs orchestration + folder sentinels + autosave (3c). ✓
- **No placeholders:** every code step shows full code; regen commands + expected `git status` are exact; the one corpus id-count assertion (5 ids) is derived in the id-contract constraint and proven by the trailing `add_track` in each sequence. ✓
- **Type consistency:** `serializeProjectToJson`/`schemaGate`/`parseProjectJson`/`reconcileMediaPaths`/`clearSessionQuickProxies`/`loadProjectFromJson`/`replaceState`/`History.reset` are named identically across tasks; `reconcileMediaPaths`/`loadProjectFromJson` take the injected `join` consistently; `clearSessionQuickProxies`/`loadProjectFromJson` both return `{ project, quickProxiesToDelete }`. ✓
- **Additivity:** Task 4 touches `replay_driver` only with a new `replace_state` arm (fires only on `replace_state` ops) + 4 new sequences; the 157 existing state + 157 existing summary oracles must be byte-identical (explicit `git status` gate). ✓
- **Out of scope guarded:** `persistence.ts` imports no `node:fs`; `replaceState` is exposed but unwired; no autosave/cutover/MCP. ✓
