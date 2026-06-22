# State-actor TS migration — Phase 3c-i Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the three remaining media-pool mutations — `set_media_derivatives`, `set_media_workspace_paths`, `remove_media` — into the TypeScript state actor, proven byte-identical to the Rust oracle by the differential corpus.

**Architecture:** Pure pool-patching helpers in `mutations/media.ts`; three dedicated actor closures in `actor.ts` (mirroring the existing `updateTrackFlags`/`addMediaItem` unrecorded pattern, plus a recorded force-cascade path); replay vocabulary + driver arms; ~13 new corpus sequences with additively-regenerated state + summary oracles. No live wiring — that is Phase 3c-ii.

**Tech Stack:** TypeScript (Electron main), Immer, Vitest; Rust (`replay_driver` bin) for the oracle; Node ESM oracle generator.

## Global Constraints

- **All commands run from `apps/desktop/`** (npm scripts, `vitest.config.ts`, `gen-state-oracle.mjs`'s relative paths, and `native/Cargo.toml` all resolve from there).
- **Differential identity is the gate:** the TS actor must produce per-step canonical state, `ok`, and error-variant **byte-identical** to the Rust oracle for every corpus sequence (`differential.phase2.test.ts`), plus an identical summary view (`summary.differential.test.ts`) and a faithful persistence round-trip (`persistence.differential.test.ts`).
- **No edits to `model.ts`, `errors.ts`, or `validate.ts`** — `MediaItem` already carries every field; `errors.ts` already has `MediaNotFound` and `MediaInUse { media; referenced_by }`.
- **Forward-slash paths only** in corpus media/proxy/workspace paths (Rust `PathBuf` serializes with the platform separator otherwise — the existing `mediaItemTemplate` uses `media/clip.bin` for this reason). Cross-platform-stable.
- **Determinism:** `replay_driver` runs in `det` mode (`Uuid::from_u128(counter)`); the TS actor uses `seededGen()`. Both mint ids from the same counter, so id-burn counts must match exactly.
- **Oracle regen must be ADDITIVE:** existing 161 state oracles + 161 summary oracles stay byte-identical; only new files appear (verify via `git diff --diff-filter=M`).
- **Oracle regen env (verified working):** `FFMPEG_DIR=<…Gyan.FFmpeg.Shared…>/ffmpeg-8.1.1-full_build-shared`, `LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH += $FFMPEG_DIR/bin`; the generator builds `replay_driver` with `--features replay,jobs,export,mcp,cloud,motifs`.
- **Commit messages** use the `…(state-migration): …` conventional prefix and end with the `Co-Authored-By` trailer.
- **Stage by explicit path only** (a parallel session edits this checkout; never `git add -A`). The untracked `code-review-*.{html,md}` at repo root must never be staged.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/main/state/mutations/media.ts` | Pure pool-patch helpers + reference scan | **Modify** (add 3 helpers + 2 types) |
| `src/main/state/mutations/media.test.ts` | Unit tests for the pure helpers | **Modify** (add describe blocks) |
| `src/main/state/actor.ts` | Dedicated closures + dispatch arms | **Modify** |
| `src/main/state/actor.test.ts` | Dispatch-level behavior tests | **Modify** (add describe block) |
| `src/main/state/replay.ts` | `SUPPORTED_OPS` + `buildArgs` vocab | **Modify** |
| `native/src/bin/replay_driver.rs` | Oracle driver `apply()` arms + helpers | **Modify** |
| `fixtures/state-corpus/sequences/*.json` | ~13 new sequences | **Create** |
| `fixtures/state-corpus/oracle/*.json`, `oracle-summary/*.json` | Regenerated oracles | **Create** (additive, via generator) |
| `fixtures/state-corpus/README.md` | Coverage table | **Modify** |

---

### Task 1: TS pure media-pool helpers

**Files:**
- Modify: `src/main/state/mutations/media.ts`
- Test: `src/main/state/mutations/media.test.ts`

**Interfaces:**
- Consumes: `MediaItem`, `Project`, `Uuid` from `../model`; `CommandFailure` from `../errors`.
- Produces (later tasks rely on these exact names/types):
  - `interface MediaDerivativesPatch { proxy_path?: string | null; quick_proxy_path?: string | null; proxy_format_version?: number; proxy_bypassed?: boolean; export_uses_original?: boolean; waveform_path?: string | null; conform_path?: string | null; thumbnails_dir?: string | null }`
  - `interface WorkspacePaths { path_abs: string; path_rel: string; file_hash_blake3: string; file_size: number; file_mtime: number }`
  - `applySetMediaDerivatives(pool: Record<string, MediaItem>, id: Uuid, patch: MediaDerivativesPatch): Record<string, MediaItem>`
  - `applySetMediaWorkspacePaths(pool: Record<string, MediaItem>, id: Uuid, paths: WorkspacePaths): Record<string, MediaItem>`
  - `referencingLayers(p: Project, id: Uuid): Uuid[]`

**Key fidelity notes (mirror `actor.rs:3534-3578`, `3500-3531`, `3439-3451`):**
- `set_media_derivatives` is **tri-state** for `proxy_path`/`quick_proxy_path` (Rust `Option<Option<PathBuf>>`): key **absent** = leave, `null` = clear, string = set → use `'proxy_path' in patch`, never `!== undefined`.
- The other patch fields are plain `Option<T>` (Rust `if let Some(p)`): set only when present-and-non-null; never cleared by this op.
- Neither setter validates (Rust does NOT call `validate` — it only patches the pool then broadcasts).
- `referencingLayers` scans `VideoClip`/`Audio`/`ImageOverlay` params whose `media === id`, in track-then-layer order.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/state/mutations/media.test.ts`:

```typescript
import { applySetMediaDerivatives, applySetMediaWorkspacePaths, referencingLayers } from './media'
import type { MediaItem } from '../model'

function pool1(): Record<string, MediaItem> {
  return { [MID]: mediaItemTemplate(MID, 'Video', 4_000_000) }
}

describe('applySetMediaDerivatives', () => {
  it('MediaNotFound when id absent (throws CommandFailure)', () => {
    expectCmd(() => applySetMediaDerivatives({}, MID, { proxy_path: 'media/p.mp4' }), 'MediaNotFound')
  })
  it('sets every field; tri-state proxy keys set when string', () => {
    const out = applySetMediaDerivatives(pool1(), MID, {
      proxy_path: 'media/p.mp4', quick_proxy_path: 'media/q.mp4', proxy_format_version: 3,
      proxy_bypassed: true, export_uses_original: true,
      waveform_path: 'media/w.bin', conform_path: 'media/c.wav', thumbnails_dir: 'media/t' })[MID]
    expect([out.proxy_path, out.quick_proxy_path, out.proxy_format_version, out.proxy_bypassed,
      out.export_uses_original, out.waveform_path, out.conform_path, out.thumbnails_dir])
      .toEqual(['media/p.mp4', 'media/q.mp4', 3, true, true, 'media/w.bin', 'media/c.wav', 'media/t'])
  })
  it('null clears the tri-state proxy fields', () => {
    const set = applySetMediaDerivatives(pool1(), MID, { proxy_path: 'media/p.mp4', quick_proxy_path: 'media/q.mp4' })
    const out = applySetMediaDerivatives(set, MID, { proxy_path: null, quick_proxy_path: null })[MID]
    expect([out.proxy_path, out.quick_proxy_path]).toEqual([null, null])
  })
  it('absent proxy key leaves the existing value (does not clear)', () => {
    const set = applySetMediaDerivatives(pool1(), MID, { proxy_path: 'media/p.mp4' })
    const out = applySetMediaDerivatives(set, MID, { proxy_format_version: 5 })[MID]
    expect([out.proxy_path, out.proxy_format_version]).toEqual(['media/p.mp4', 5])
  })
})

describe('applySetMediaWorkspacePaths', () => {
  it('MediaNotFound when id absent', () => {
    expectCmd(() => applySetMediaWorkspacePaths({}, MID, { path_abs: 'a', path_rel: 'r', file_hash_blake3: 'h', file_size: 1, file_mtime: 2 }), 'MediaNotFound')
  })
  it('sets all five workspace fields', () => {
    const out = applySetMediaWorkspacePaths(pool1(), MID, { path_abs: 'ws/clip.bin', path_rel: 'media/clip.bin', file_hash_blake3: 'abc', file_size: 1024, file_mtime: 1700000000 })[MID]
    expect([out.path_abs, out.path_rel, out.file_hash_blake3, out.file_size, out.file_mtime])
      .toEqual(['ws/clip.bin', 'media/clip.bin', 'abc', 1024, 1700000000])
  })
})

describe('referencingLayers', () => {
  it('finds VideoClip/Audio/ImageOverlay layers that reference the media id; ignores others', () => {
    const gen = seededGen()
    const p = blankProject(gen, 'r')
    const tA = p.tracks[0].id
    const v = applyAddLayer(p, gen, tA, videoClipParams(MID, 0, 4_000_000), 0, 4_000_000)
    applyAddLayer(p, gen, tA, videoClipParams('00000000-0000-0000-0000-0000000000bb', 0, 1), 5_000_000, 6_000_000)
    expect(referencingLayers(p, MID)).toEqual([v])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/state/mutations/media.test.ts`
Expected: FAIL — `applySetMediaDerivatives is not a function` (and the other two).

- [ ] **Step 3: Implement the helpers**

Append to `src/main/state/mutations/media.ts` (note the existing import line already imports `LayerParams, MediaItem, Project, Track, Uuid`; add nothing new there):

```typescript
/** actor.rs:269-286 MediaDerivativesPatch. proxy_path/quick_proxy_path are
 *  Option<Option<PathBuf>> — tri-state: key absent = leave, null = clear, string
 *  = set. The rest are plain Option<T> (set-or-leave; never cleared here). */
export interface MediaDerivativesPatch {
  proxy_path?: string | null
  quick_proxy_path?: string | null
  proxy_format_version?: number
  proxy_bypassed?: boolean
  export_uses_original?: boolean
  waveform_path?: string | null
  conform_path?: string | null
  thumbnails_dir?: string | null
}
export interface WorkspacePaths {
  path_abs: string; path_rel: string; file_hash_blake3: string; file_size: number; file_mtime: number
}

/** do_set_media_derivatives (actor.rs:3534) — patch one pool item's derivative
 *  fields, returning a new pool. MediaNotFound if absent. No validation (mirrors
 *  Rust). The caller replaces the pool everywhere + broadcasts unrecorded. */
export function applySetMediaDerivatives(pool: Record<string, MediaItem>, id: Uuid, patch: MediaDerivativesPatch): Record<string, MediaItem> {
  const item = pool[id]
  if (!item) throw new CommandFailure({ error: 'MediaNotFound', media: id })
  const next: MediaItem = { ...item }
  // tri-state (Option<Option<PathBuf>>): presence distinguishes leave from clear.
  if ('proxy_path' in patch) next.proxy_path = patch.proxy_path ?? null
  if ('quick_proxy_path' in patch) next.quick_proxy_path = patch.quick_proxy_path ?? null
  if (patch.proxy_format_version !== undefined) next.proxy_format_version = patch.proxy_format_version
  if (patch.proxy_bypassed !== undefined) next.proxy_bypassed = patch.proxy_bypassed
  if (patch.export_uses_original !== undefined) next.export_uses_original = patch.export_uses_original
  // plain Option<PathBuf> (Rust `if let Some(p)`): set only when present-and-non-null.
  if (patch.waveform_path != null) next.waveform_path = patch.waveform_path
  if (patch.conform_path != null) next.conform_path = patch.conform_path
  if (patch.thumbnails_dir != null) next.thumbnails_dir = patch.thumbnails_dir
  return { ...pool, [id]: next }
}

/** do_set_media_workspace_paths (actor.rs:3500) — set the workspace-relative
 *  path + file fingerprint after the import copy. path_rel is always set. */
export function applySetMediaWorkspacePaths(pool: Record<string, MediaItem>, id: Uuid, paths: WorkspacePaths): Record<string, MediaItem> {
  const item = pool[id]
  if (!item) throw new CommandFailure({ error: 'MediaNotFound', media: id })
  return { ...pool, [id]: { ...item, path_abs: paths.path_abs, path_rel: paths.path_rel,
    file_hash_blake3: paths.file_hash_blake3, file_size: paths.file_size, file_mtime: paths.file_mtime } }
}

/** do_remove_media (actor.rs:3439-3451) — layer ids referencing this media,
 *  scanned in track-then-layer order. VideoClip/Audio/ImageOverlay only. */
export function referencingLayers(p: Project, id: Uuid): Uuid[] {
  const out: Uuid[] = []
  for (const t of p.tracks) for (const l of t.layers) {
    const k = l.params.kind
    if ((k === 'VideoClip' || k === 'Audio' || k === 'ImageOverlay') && l.params.media === id) out.push(l.id)
  }
  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/main/state/mutations/media.test.ts`
Expected: PASS (all describe blocks, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/main/state/mutations/media.ts src/main/state/mutations/media.test.ts
git commit -m "$(cat <<'EOF'
feat(state-migration): pure media-pool helpers (derivatives/workspace/refscan)

Tri-state derivative patch (Option<Option<PathBuf>>), workspace-paths
setter, and the referencing-layer scan for remove_media — Phase 3c-i.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: TS actor closures, dispatch arms, replay vocabulary

**Files:**
- Modify: `src/main/state/actor.ts`
- Modify: `src/main/state/replay.ts`
- Test: `src/main/state/actor.test.ts`

**Interfaces:**
- Consumes: `applySetMediaDerivatives`, `applySetMediaWorkspacePaths`, `referencingLayers`, `MediaDerivativesPatch`, `WorkspacePaths` from `./mutations/media` (Task 1); existing `commit`, `broadcastUnrecorded`, `runValidate`, `history.replaceMediaPoolEverywhere`, `current`.
- Produces: dispatch handling for `'set_media_derivatives'`, `'set_media_workspace_paths'`, `'remove_media'`; the same three strings in `SUPPORTED_OPS` + `buildArgs` cases.

**Key fidelity notes:**
- Setters are UNRECORDED, **no validate**: `applySet…` → `history.replaceMediaPoolEverywhere(nextPool)` → `broadcastUnrecorded`.
- `remove_media` is HYBRID (`do_remove_media` actor.rs:3428-3498):
  - `MediaNotFound` first (no id).
  - `referencingLayers`; if non-empty && `!force` → `MediaInUse { referenced_by }` (no id).
  - **unused** (referencing empty): `runValidate({ ...cur, media_pool: nextPool })` BEFORE broadcast (actor.rs:3470) → `replaceMediaPoolEverywhere` → `broadcastUnrecorded` (1 id, durable across undo).
  - **force-cascade**: a RAW inline layer removal inside `commit` — find each referencing layer by id and splice it (break after first per id), then `delete d.media_pool[id]`. **Do NOT call `applyDeleteLayer`** (no empty-track prune, no group cleanup — actor.rs:3479-3488). `affected` = the referencing layers.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/state/actor.test.ts` (it already imports `createActor`, `seededGen`, `blankProject` — match the file's existing setup helpers; if a `mkActor()` helper exists, reuse it, otherwise inline as below):

```typescript
import { videoClipParams } from './mutations/media'

describe('media-pool mutations dispatch (Phase 3c-i)', () => {
  const MID = '00000000-0000-0000-0000-0000000000aa'
  function actorWithMedia() {
    const gen = seededGen()
    const a = createActor({ initial: blankProject(gen, 'm'), idGen: gen, clock: () => '<TS>' })
    a.dispatch('add_media', { id: MID, kind: 'Video', duration_us: 4_000_000 })
    return a
  }

  it('set_media_derivatives: MediaNotFound on bad id', () => {
    const r = actorWithMedia().dispatch('set_media_derivatives', { media: '00000000-0000-0000-0000-0000000000ff', patch: { proxy_path: 'media/p.mp4' } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.error).toBe('MediaNotFound')
  })
  it('set_media_derivatives: success patches the pool item', () => {
    const a = actorWithMedia()
    expect(a.dispatch('set_media_derivatives', { media: MID, patch: { proxy_path: 'media/p.mp4', proxy_bypassed: true } }).ok).toBe(true)
    expect(a.snapshot().media_pool[MID].proxy_path).toBe('media/p.mp4')
    expect(a.snapshot().media_pool[MID].proxy_bypassed).toBe(true)
  })
  it('set_media_workspace_paths: success sets path_rel + hash', () => {
    const a = actorWithMedia()
    expect(a.dispatch('set_media_workspace_paths', { media: MID, paths: { path_abs: 'ws/c.bin', path_rel: 'media/c.bin', file_hash_blake3: 'abc', file_size: 9, file_mtime: 7 } }).ok).toBe(true)
    expect(a.snapshot().media_pool[MID].path_rel).toBe('media/c.bin')
  })
  it('remove_media: MediaInUse when referenced and !force; lists the layer', () => {
    const a = actorWithMedia()
    const lid = a.dispatch('add_layer', { track: a.snapshot().tracks[0].id, kind: 'video', media: MID, src_in_us: 0, src_out_us: 4_000_000, t_start_us: 0, t_end_us: 4_000_000 }).value as string
    const r = a.dispatch('remove_media', { media: MID, force: false })
    expect(!r.ok && r.error.error).toBe('MediaInUse')
    expect(!r.ok && r.error.error === 'MediaInUse' && r.error.referenced_by).toEqual([lid])
  })
  it('remove_media unused: removes from pool, durable across undo', () => {
    const a = actorWithMedia()
    expect(a.dispatch('remove_media', { media: MID, force: false }).ok).toBe(true)
    expect(a.snapshot().media_pool[MID]).toBeUndefined()
    a.dispatch('add_track', {})           // a recorded op to have something to undo
    a.dispatch('undo', {})
    expect(a.snapshot().media_pool[MID], 'unrecorded remove is durable across undo').toBeUndefined()
  })
  it('remove_media force: cascade-deletes referencing layers, recorded (undoable)', () => {
    const a = actorWithMedia()
    const tA = a.snapshot().tracks[0].id
    a.dispatch('add_layer', { track: tA, kind: 'video', media: MID, src_in_us: 0, src_out_us: 4_000_000, t_start_us: 0, t_end_us: 4_000_000 })
    expect(a.dispatch('remove_media', { media: MID, force: true }).ok).toBe(true)
    expect(a.snapshot().tracks[0].layers.length).toBe(0)
    expect(a.snapshot().media_pool[MID]).toBeUndefined()
    a.dispatch('undo', {})
    expect(a.snapshot().tracks[0].layers.length, 'force cascade is undoable').toBe(1)
    expect(a.snapshot().media_pool[MID], 'undo restores media').toBeDefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/main/state/actor.test.ts`
Expected: FAIL — `unsupported op set_media_derivatives` (dispatch returns `InvalidArgument`).

- [ ] **Step 3: Wire the actor**

In `src/main/state/actor.ts`, extend the media import (line ~24):

```typescript
import { videoClipParams, audioParams, imageOverlayParams, applySeparateAudio, mediaItemTemplate,
  applySetMediaDerivatives, applySetMediaWorkspacePaths, referencingLayers,
  type MediaDerivativesPatch, type WorkspacePaths } from './mutations/media'
```

Add the three closures next to `addMediaItem` (after line ~208):

```typescript
  // ── set_media_derivatives (do_set_media_derivatives:3534) — UNRECORDED, NO
  //    validate. MediaNotFound first (no id); else patch the pool item, replace
  //    EVERYWHERE (durable across undo) + broadcast (1 id). ──
  function setMediaDerivatives(id: Uuid, patch: MediaDerivativesPatch): void {
    const nextPool = applySetMediaDerivatives(current().media_pool, id, patch) // throws MediaNotFound
    history.replaceMediaPoolEverywhere(nextPool)
    broadcastUnrecorded('Updated media derivatives', current())
  }
  // ── set_media_workspace_paths (do_set_media_workspace_paths:3500) — UNRECORDED. ──
  function setMediaWorkspacePaths(id: Uuid, paths: WorkspacePaths): void {
    const nextPool = applySetMediaWorkspacePaths(current().media_pool, id, paths) // throws MediaNotFound
    history.replaceMediaPoolEverywhere(nextPool)
    broadcastUnrecorded('Updated media workspace paths', current())
  }
  // ── remove_media (do_remove_media:3428) — HYBRID. MediaNotFound → MediaInUse
  //    (when referenced && !force) → unused path (validate probe BEFORE broadcast,
  //    durable, 1 broadcast id) | force-cascade (RAW inline layer removal +
  //    commit, 1 op_id, undoable). The force path must NOT reuse applyDeleteLayer
  //    (no empty-track prune / no group cleanup — actor.rs:3479-3488). ──
  function removeMedia(id: Uuid, force: boolean): void {
    const cur = current()
    if (!(id in cur.media_pool)) throw new CommandFailure({ error: 'MediaNotFound', media: id })
    const referencing = referencingLayers(cur, id)
    if (referencing.length > 0 && !force) throw new CommandFailure({ error: 'MediaInUse', media: id, referenced_by: referencing })
    if (referencing.length === 0) {
      const nextPool = { ...cur.media_pool }
      delete nextPool[id]
      runValidate({ ...cur, media_pool: nextPool }) // validate-before-broadcast (actor.rs:3470)
      history.replaceMediaPoolEverywhere(nextPool)
      broadcastUnrecorded(`Removed media ${id}`, current())
      return
    }
    const affected: EntityRef[] = referencing.map((l) => ({ kind: 'Layer', id: l }))
    commit(`Removed media ${id} and ${referencing.length} referencing layer(s)`, affected, { kind: 'Coarse' }, (d) => {
      for (const layerId of referencing) {
        for (const t of d.tracks) {
          const idx = t.layers.findIndex((l) => l.id === layerId)
          if (idx >= 0) { t.layers.splice(idx, 1); break }
        }
      }
      delete d.media_pool[id]
    })
  }
```

Add the three dispatch arms (after the `separate_audio` arm, line ~325):

```typescript
        case 'set_media_derivatives': setMediaDerivatives(a.media as Uuid, a.patch as MediaDerivativesPatch); return { ok: true, value: null }
        case 'set_media_workspace_paths': setMediaWorkspacePaths(a.media as Uuid, a.paths as WorkspacePaths); return { ok: true, value: null }
        case 'remove_media': removeMedia(a.media as Uuid, (a.force as boolean) ?? false); return { ok: true, value: null }
```

- [ ] **Step 4: Add the replay vocabulary**

In `src/main/state/replay.ts`, add to `SUPPORTED_OPS` (after `'replace_state',` line ~25):

```typescript
  'set_media_derivatives', 'set_media_workspace_paths', 'remove_media',
```

Add to `buildArgs` (after the `replace_state` case, line ~144):

```typescript
    case 'set_media_derivatives': return { media: resolve(refs, cmd.media), patch: cmd.patch }
    case 'set_media_workspace_paths': return { media: resolve(refs, cmd.media), paths: cmd.paths }
    case 'remove_media': return { media: resolve(refs, cmd.media), force: cmd.force ?? false }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/main/state/actor.test.ts src/main/state/replay.test.ts src/main/state/shadow.test.ts`
Expected: PASS. (`replay.test.ts`/`shadow.test.ts` pin `SUPPORTED_OPS`/`tsActorHandles`; if they assert an exact op-set snapshot, update those expectations to include the three new ops — the prior phases did the same.)

- [ ] **Step 6: Verify existing differential gates still green (no corpus change yet)**

Run: `npx vitest run src/main/state/__tests__/differential.phase2.test.ts`
Expected: PASS, `skipped` still `[]` (the new `SUPPORTED_OPS` entries have no sequences yet, so nothing changes).

- [ ] **Step 7: Commit**

```bash
git add src/main/state/actor.ts src/main/state/replay.ts src/main/state/actor.test.ts src/main/state/replay.test.ts src/main/state/shadow.test.ts
git commit -m "$(cat <<'EOF'
feat(state-migration): TS actor media-pool mutations + dispatch + vocab

set_media_derivatives/set_media_workspace_paths (unrecorded) and
remove_media (hybrid: unrecorded unused / recorded force-cascade with
raw inline layer removal) on the TS actor. Phase 3c-i.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Rust replay-driver arms

**Files:**
- Modify: `native/src/bin/replay_driver.rs`

**Interfaces:**
- Consumes: `ProjectHandle::set_media_derivatives(actor, id, MediaDerivativesPatch)`, `set_media_workspace_paths(actor, id, path_abs, path_rel, file_hash_blake3, file_size, file_mtime)`, `remove_media(actor, id, force)` (all on `actor.rs`); `weftcut_lib::state::actor::MediaDerivativesPatch` (pub struct, pub fields, `Default`).
- Produces: oracle traces for the three ops.

**Key fidelity notes:** the driver builds `MediaDerivativesPatch` field-by-field from the cmd JSON with **presence checks** — serde cannot represent the `Option<Option<PathBuf>>` tri-state (it would fold `null` into the outer `None`). The presence semantics must match the TS `'key' in patch`.

- [ ] **Step 1: Add the JSON helpers**

In `native/src/bin/replay_driver.rs`, add near the other helpers (after `rgba_obj`, ~line 320). `use serde_json::Value;` and `std::path::PathBuf` may already be imported; if not, add them:

```rust
/// `Option<Option<PathBuf>>` from a patch object: key absent → None (leave);
/// JSON null → Some(None) (clear); string → Some(Some(path)). Mirrors the TS
/// `'key' in patch` tri-state for set_media_derivatives' proxy fields.
fn opt_opt_path(p: &Value, key: &str) -> Option<Option<std::path::PathBuf>> {
    match p.get(key) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => Some(Some(std::path::PathBuf::from(v.as_str().unwrap()))),
    }
}
/// Plain `Option<PathBuf>`: present-and-string → Some; absent or null → None.
fn opt_path(p: &Value, key: &str) -> Option<std::path::PathBuf> {
    p.get(key).and_then(|v| v.as_str()).map(std::path::PathBuf::from)
}
```

- [ ] **Step 2: Add the three apply() arms**

In `apply()`, after the `"separate_audio"` arm (~line 236), add:

```rust
        "set_media_derivatives" => {
            let p = &cmd["patch"];
            let patch = weftcut_lib::state::actor::MediaDerivativesPatch {
                proxy_path: opt_opt_path(p, "proxy_path"),
                proxy_format_version: p.get("proxy_format_version").and_then(|v| v.as_u64()).map(|n| n as u32),
                quick_proxy_path: opt_opt_path(p, "quick_proxy_path"),
                proxy_bypassed: p.get("proxy_bypassed").and_then(|v| v.as_bool()),
                export_uses_original: p.get("export_uses_original").and_then(|v| v.as_bool()),
                waveform_path: opt_path(p, "waveform_path"),
                conform_path: opt_path(p, "conform_path"),
                thumbnails_dir: opt_path(p, "thumbnails_dir"),
            };
            h.set_media_derivatives(u, resolve_id(refs, cmd["media"].as_str().unwrap()), patch).await
                .map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "set_media_workspace_paths" => {
            let p = &cmd["paths"];
            h.set_media_workspace_paths(
                u,
                resolve_id(refs, cmd["media"].as_str().unwrap()),
                std::path::PathBuf::from(p["path_abs"].as_str().unwrap()),
                std::path::PathBuf::from(p["path_rel"].as_str().unwrap()),
                p["file_hash_blake3"].as_str().unwrap().to_string(),
                p["file_size"].as_u64().unwrap(),
                p["file_mtime"].as_u64().unwrap(),
            ).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "remove_media" => h.remove_media(u, resolve_id(refs, cmd["media"].as_str().unwrap()), cmd["force"].as_bool().unwrap_or(false)).await
            .map(|_| None).map_err(|e| format!("{e:?}")),
```

- [ ] **Step 3: Build the driver to verify it compiles**

Run (env per Global Constraints):
```bash
FFMPEG_DIR="$FFMPEG_DIR" LIBCLANG_PATH="$LIBCLANG_PATH" \
cargo build --quiet --manifest-path native/Cargo.toml --bin replay_driver \
  --features replay,jobs,export,mcp,cloud,motifs
```
Expected: builds clean (exit 0). If `MediaDerivativesPatch` is not re-exported at `weftcut_lib::state::actor`, fully-qualify via the path the existing `LayerParamsPatch`/`CaptionStylePatch` arms use (`weftcut_lib::state::actor::…`) — they confirm that module path is public.

- [ ] **Step 4: Commit**

```bash
git add native/src/bin/replay_driver.rs
git commit -m "$(cat <<'EOF'
test(state-migration): replay_driver arms for media-pool mutations

set_media_derivatives (tri-state patch via presence checks),
set_media_workspace_paths, remove_media. Phase 3c-i oracle driver.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Corpus sequences + oracle regen + differential green

**Files:**
- Create: 13 files under `fixtures/state-corpus/sequences/`
- Create (via generator): matching files under `oracle/` and `oracle-summary/`

**Interfaces:**
- Consumes: the TS dispatch + vocab (Tasks 1-2), the driver (Task 3), `scripts/gen-state-oracle.mjs`.
- Produces: the differential corpus coverage for the three mutations.

**Notes:** every success sequence ends with a trailing `add_track` (its minted id reveals the id-burn count). Media ids are literals; proxy/workspace paths use forward slashes. `…aa` = present media, `…ff` = absent media.

- [ ] **Step 1: Author the sequence files**

Create each of the following under `fixtures/state-corpus/sequences/`:

`set-media-derivatives-set.json`
```json
{ "name": "set-media-derivatives-set", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000 },
  { "op": "set_media_derivatives", "media": "00000000-0000-0000-0000-0000000000aa", "patch": { "proxy_path": "media/proxy.mp4", "proxy_format_version": 3, "quick_proxy_path": "media/quick.mp4", "proxy_bypassed": false, "export_uses_original": false, "waveform_path": "media/wave.bin", "conform_path": "media/conf.wav", "thumbnails_dir": "media/thumbs" } },
  { "op": "add_track", "ref": "T" }
] }
```

`set-media-derivatives-clear.json`
```json
{ "name": "set-media-derivatives-clear", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000 },
  { "op": "set_media_derivatives", "media": "00000000-0000-0000-0000-0000000000aa", "patch": { "proxy_path": "media/proxy.mp4", "quick_proxy_path": "media/quick.mp4" } },
  { "op": "set_media_derivatives", "media": "00000000-0000-0000-0000-0000000000aa", "patch": { "proxy_path": null, "quick_proxy_path": null } },
  { "op": "add_track", "ref": "T" }
] }
```

`set-media-derivatives-leave.json`
```json
{ "name": "set-media-derivatives-leave", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000 },
  { "op": "set_media_derivatives", "media": "00000000-0000-0000-0000-0000000000aa", "patch": { "proxy_path": "media/proxy.mp4" } },
  { "op": "set_media_derivatives", "media": "00000000-0000-0000-0000-0000000000aa", "patch": { "proxy_format_version": 5 } },
  { "op": "add_track", "ref": "T" }
] }
```

`set-media-derivatives-missing-media.json`
```json
{ "name": "set-media-derivatives-missing-media", "commands": [
  { "op": "set_media_derivatives", "media": "00000000-0000-0000-0000-0000000000ff", "patch": { "proxy_path": "media/p.mp4" } },
  { "op": "add_track", "ref": "T" }
] }
```

`set-media-workspace-paths.json`
```json
{ "name": "set-media-workspace-paths", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000 },
  { "op": "set_media_workspace_paths", "media": "00000000-0000-0000-0000-0000000000aa", "paths": { "path_abs": "ws/media/clip.bin", "path_rel": "media/clip.bin", "file_hash_blake3": "abc123", "file_size": 1024, "file_mtime": 1700000000 } },
  { "op": "add_track", "ref": "T" }
] }
```

`set-media-workspace-paths-missing-media.json`
```json
{ "name": "set-media-workspace-paths-missing-media", "commands": [
  { "op": "set_media_workspace_paths", "media": "00000000-0000-0000-0000-0000000000ff", "paths": { "path_abs": "ws/x.bin", "path_rel": "x.bin", "file_hash_blake3": "h", "file_size": 1, "file_mtime": 1 } },
  { "op": "add_track", "ref": "T" }
] }
```

`remove-media-unused.json`
```json
{ "name": "remove-media-unused", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000 },
  { "op": "remove_media", "media": "00000000-0000-0000-0000-0000000000aa" },
  { "op": "add_track", "ref": "T" }
] }
```

`remove-media-unused-undo.json`
```json
{ "name": "remove-media-unused-undo", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000 },
  { "op": "remove_media", "media": "00000000-0000-0000-0000-0000000000aa" },
  { "op": "add_track", "ref": "T" },
  { "op": "undo" }
] }
```

`remove-media-in-use-no-force.json`
```json
{ "name": "remove-media-in-use-no-force", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000, "ref": "M" },
  { "op": "add_layer", "track": "@A", "kind": "video", "media": "@M", "src_in_us": 0, "src_out_us": 4000000, "t_start_us": 0, "t_end_us": 4000000, "ref": "L" },
  { "op": "remove_media", "media": "@M", "force": false },
  { "op": "add_track", "ref": "T" }
] }
```

`remove-media-force-cascade.json`
```json
{ "name": "remove-media-force-cascade", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000, "ref": "M" },
  { "op": "add_layer", "track": "@A", "kind": "video", "media": "@M", "src_in_us": 0, "src_out_us": 4000000, "t_start_us": 0, "t_end_us": 4000000, "ref": "L" },
  { "op": "remove_media", "media": "@M", "force": true },
  { "op": "add_track", "ref": "T" }
] }
```

`remove-media-force-undo.json`
```json
{ "name": "remove-media-force-undo", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000, "ref": "M" },
  { "op": "add_layer", "track": "@A", "kind": "video", "media": "@M", "src_in_us": 0, "src_out_us": 4000000, "t_start_us": 0, "t_end_us": 4000000, "ref": "L" },
  { "op": "remove_media", "media": "@M", "force": true },
  { "op": "undo" }
] }
```

`remove-media-force-leaves-empty-track.json`
```json
{ "name": "remove-media-force-leaves-empty-track", "commands": [
  { "op": "add_media", "id": "00000000-0000-0000-0000-0000000000aa", "kind": "Video", "duration_us": 4000000, "ref": "M" },
  { "op": "add_track", "label": "T2", "ref": "T2" },
  { "op": "add_layer", "track": "@T2", "kind": "video", "media": "@M", "src_in_us": 0, "src_out_us": 4000000, "t_start_us": 0, "t_end_us": 4000000, "ref": "L" },
  { "op": "remove_media", "media": "@M", "force": true },
  { "op": "add_track", "ref": "T3" }
] }
```

`remove-media-missing.json`
```json
{ "name": "remove-media-missing", "commands": [
  { "op": "remove_media", "media": "00000000-0000-0000-0000-0000000000ff" },
  { "op": "add_track", "ref": "T" }
] }
```

- [ ] **Step 2: Regenerate the oracles**

Run from `apps/desktop/` (env per Global Constraints):
```bash
FFMPEG_DIR="$FFMPEG_DIR" LIBCLANG_PATH="$LIBCLANG_PATH" PATH="$FFMPEG_DIR/bin:$PATH" \
node scripts/gen-state-oracle.mjs
```
Expected: `ok  <file>` for every sequence (incl. the 13 new ones); exit 0 (no `NONDETERMINISTIC` lines).

- [ ] **Step 3: Verify regen was ADDITIVE (no existing oracle mutated)**

Run:
```bash
git status --porcelain fixtures/state-corpus/oracle fixtures/state-corpus/oracle-summary | grep '^ M' || echo "ADDITIVE-OK (no modified oracles)"
```
Expected: `ADDITIVE-OK` — only new (`??`) oracle files, zero modified (`M`). If any existing oracle shows as modified, STOP: a non-additive change means the new arms perturbed shared state — investigate before continuing.

- [ ] **Step 4: Run the state + summary differential gates (the keystone)**

Run: `npx vitest run src/main/state/__tests__/differential.phase2.test.ts src/main/state/summary.differential.test.ts`
Expected: PASS — `skipped===[]`; every new sequence matches its oracle per-step (state + ok + error) and summary view.

If a new sequence diverges, fix the TS to match the Rust oracle (the oracle is truth). Likely culprits, in order: the tri-state `'key' in patch` handling; the force-cascade using `applyDeleteLayer` by mistake (must be raw inline removal); a missing/extra `runValidate`; or a summary-view media field the TS `summary.ts` renders differently (then mirror Rust in `summary.ts` and add a note).

- [ ] **Step 5: Commit**

```bash
git add fixtures/state-corpus/sequences fixtures/state-corpus/oracle fixtures/state-corpus/oracle-summary
git commit -m "$(cat <<'EOF'
test(state-migration): media-pool corpus + oracles, differential green

13 sequences for set_media_derivatives (tri-state set/clear/leave +
missing), set_media_workspace_paths, remove_media (unused/in-use/force-
cascade/empty-track/undo/missing). Additive regen. Phase 3c-i.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Persistence gate, README, full suite

**Files:**
- Modify: `fixtures/state-corpus/README.md`

**Interfaces:**
- Consumes: the full expanded corpus + all three differential gates.
- Produces: the finished, documented 3c-i slice.

- [ ] **Step 1: Run the persistence round-trip gate**

Run: `npx vitest run src/main/state/__tests__/persistence.differential.test.ts`
Expected: PASS — each new sequence's final Rust-serialized state round-trips through `loadProjectFromJson`→`serializeProject` canonical-identically. (All media fields are already in the model, so this should be clean; if not, the divergence is a `serialize.ts`/`model.ts` field-name issue — surface it, do not patch the gate.)

- [ ] **Step 2: Update the corpus README**

In `fixtures/state-corpus/README.md`:
- In the **DEFERRED** table, change the line
  `| rebind_motif, remove_media, set_media_derivatives, add_transient_track, set_media_workspace_paths | deferred |`
  to
  `| rebind_motif, add_transient_track | deferred (motif-catalog / zero-caller) |`
- Add a new section documenting the media-pool sequences:

```markdown
### media-pool mutations (Phase 3c-i)

`set-media-derivatives-*` exercise the tri-state derivative patch
(`Option<Option<PathBuf>>`: set/clear/leave) + plain-Option fields + MediaNotFound.
`set-media-workspace-paths*` set the workspace path/fingerprint (+ MediaNotFound).
`remove-media-*` cover the HYBRID command: `-unused` (unrecorded, +1 broadcast id,
durable across undo via `-unused-undo`), `-in-use-no-force` (MediaInUse, no id),
`-force-cascade` (recorded raw inline layer delete, +1 op_id), `-force-undo`
(undo restores layers + media), `-force-leaves-empty-track` (no auto-prune — the
force path bypasses `do_delete_layer`), and `-missing` (MediaNotFound, no id). Every
success seq ends with a trailing `add_track` proving the id-burn count.
```

- [ ] **Step 3: Run the full state suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: full Vitest suite green (the differential gates now cover 174 sequences) and `tsc -b` clean.

- [ ] **Step 4: Commit**

```bash
git add fixtures/state-corpus/README.md
git commit -m "$(cat <<'EOF'
docs(state-migration): corpus README — media-pool coverage (Phase 3c-i)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:** Each spec item maps to a task — `set_media_derivatives`/`set_media_workspace_paths`/`remove_media` (Tasks 1-4); tri-state convention (Task 1 helper + Task 3 driver + Task 4 set/clear/leave seqs); force-cascade-no-prune landmine (Task 2 closure + `-force-leaves-empty-track` seq); HYBRID undoability (Task 2 tests + `-unused-undo`/`-force-undo` seqs); validate-before-broadcast (Task 2 closure); the three differential gates (Task 4 state+summary, Task 5 persistence); deferral of `add_transient_track` (README, Task 5). No model/errors/validate edits (confirmed in Global Constraints). No spec requirement is unmapped.

**Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output.

**Type consistency:** `MediaDerivativesPatch`/`WorkspacePaths` defined in Task 1 are imported verbatim in Task 2; `applySetMediaDerivatives`/`applySetMediaWorkspacePaths`/`referencingLayers` signatures match between the producing task and the consuming closures; dispatch keys (`set_media_derivatives`/`set_media_workspace_paths`/`remove_media`) match across `actor.ts`, `replay.ts` `SUPPORTED_OPS`, `buildArgs`, the driver arms, and the sequence `op` fields.
