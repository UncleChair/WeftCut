# State-actor TS migration — Phase 3c-ii-b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-home the `project_open` / `save_as` / `new_workspace` orchestration into a pure, dependency-injected TypeScript module in Electron main that drives the gated TS state actor + the 3b pure persistence pieces, backed by a small new granular napi surface for the Rust-native workspace bookkeeping (cache / workspace slot / agent-session / LogBus / recents) — all **built and unit-gated, not yet wired live** (the `backend:invoke` flip is 3c-ii-d).

**Architecture:** A new `src/main/state/workspace-orchestrator.ts` owns the open/save/new sequence as three pure async functions taking injected dependencies (the TS actor handle, a `WorkspaceNapi` facade, an `OrchestratorFs`, `node:path.join`, and `idGen`). The pure 3b functions (`loadProjectFromJson`, `serializeProjectToJson`) do the disk-format work; `actor.replaceState` / `actor.snapshot` carry state; the new napi `Backend::commit_workspace` / `push_recent` / `set_last_new_project_parent` carry the Rust-native bookkeeping (an exact extract of the head/tail of `commands/persistence.rs`). Nothing in `src/main/index.ts` is rewired — the orchestrator is dormant, exercised only by unit tests, and activated atomically with the rest of the flip in 3c-ii-d.

**Tech Stack:** TypeScript (Electron main, Immer-based actor), Rust (napi addon `@weftcut/core`), Vitest, `cargo test`.

## Global Constraints

- **Working dir for all commands:** `apps/desktop/`. Paths below are relative to it unless absolute.
- **No live wiring in this slice.** Do NOT touch `src/main/index.ts`, the `backend:invoke` handler, or introduce the `WEFTCUT_TS_ACTOR` flag. Those are 3c-ii-d (the atomic flip, spec §3c-ii-d). 3c-ii-b ships dormant, unit-tested code + the napi surface 3c-ii-d will consume.
- **Faithful to Rust ordering + failure semantics.** The orchestrator mirrors `commands/persistence.rs` exactly: workspace bookkeeping (cache→workspace→agent-session-end→LogBus) happens **before** `replace_state` so any `project:changed` consumer sees the new workspace first; `recents.push` happens **after** a successful `replace_state`/write (a project that fails to load is never recorded — spec risk #6).
- **Reuse the gated core + the 3b pure pieces.** The orchestrator MUST call `actor.replaceState` / `actor.snapshot` and `loadProjectFromJson` / `serializeProjectToJson` — never re-implement load/save/serialize. Only the orchestration sequence + the three napi extracts are new.
- **`save_to_dir` is a plain write (verified `io/mod.rs:24-37`):** `serde_json::to_string_pretty` → `fs::create_dir_all(dir)` → `fs::write(dir/"project.json", json)`. **No** atomic temp-rename, **no** sidecar/manifest/lock, **no** trailing newline. The TS write must replicate exactly that: `mkdirp(dir)` then `writeFile(join(dir, "project.json"), serializeProjectToJson(p))`.
- **`migrate.rs` is gate-only (verified `io/migrate.rs:1-44`):** equal→ok, below→reject, above→reject. **No** version-to-version transforms. `SCHEMA_VERSION = 9` (`state/project.rs`). Therefore the load path stays **fully TS** (the 3b `schemaGate` already mirrors it byte-for-byte) — NO Rust `loadProjectBytes+migrate` napi is needed. (This resolves the spec's 3c-ii-b "`migrate.rs` transforms vs gating" caveat / risk #4.)
- **Project file constant:** the on-disk filename is `project.json` (`io::PROJECT_FILE`, `io/mod.rs:19`). Define it once as `PROJECT_FILE` in `persistence.ts` and import it.
- **napi build env (verified working, from prior phases):** `napi:build` = `napi build --platform --release --manifest-path native/Cargo.toml --output-dir native --features jobs,export,mcp,cloud,motifs`. Native builds on this machine need `FFMPEG_DIR=<Gyan.FFmpeg.Shared>/ffmpeg-8.1.1-full_build-shared`, `LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH += $FFMPEG_DIR/bin`. The new napi methods are NOT feature-gated (they use always-compiled stores), so they land in the production addon.

---

## Scope findings (read before starting — these refine the spec's §3c-ii-b text)

Three findings, each verified against code, that shape this slice:

**S1 — The load path stays 100% TS (no Rust migrate napi).** `migrate.rs` only gates; the 3b `schemaGate` already reproduces its three branches verbatim. So `openProject` reads bytes with `node:fs`, then `loadProjectFromJson` (3b: parse → schemaGate → reconcileMediaPaths → clearSessionQuickProxies) does everything. The spec's "if it transforms, the read+migrate stays a Rust napi call" branch is **not taken**.

**S2 — Open-time derivative re-fan-out is DEFERRED to 3c-ii-c (recommended deviation from the spec's literal §3c-ii-b bullet).** The spec lists `enqueueJobsForMedia` under 3c-ii-b, but a *correct* kick-off is inseparable from the jobs **write-back** rework that the spec itself places in 3c-ii-c: `jobs::enqueue_for_media` (`jobs/mod.rs:142`) takes a `ProjectHandle` and, on completion, calls `project.set_media_derivatives(...)` on it. In the flipped world the authoritative pool lives in the **TS** actor, so completion must instead emit `media:derivatives` → TS (spec D5). Building a kick-off napi in 3c-ii-b against the current Rust-handle write-back would build a path that's wrong until 3c-ii-c reworks completion. Per DRY/YAGNI and the spec's own "fold stragglers into the slice that needs them," the kick-off + the event write-back are built together in **3c-ii-c**. `openProject` here leaves a documented, injected no-op seam (`enqueueDerivatives`) so 3c-ii-c drops the live implementation in without touching the orchestrator's shape. **(Confirm this deviation with the user before execution — see Execution Handoff.)**

**S3 — A flag-on open/save/new *round-trip* e2e is unrunnable until 3c-ii-d, so this slice's gate is unit + `cargo test`, not Playwright.** With the flag off (this slice), the Rust persistence path is still authoritative; with the flag on, a meaningful round-trip also needs the renderer's `project_summary` + mutations routed to the TS actor — that routing is 3c-ii-d. So the spec's "open/save/new round-trip e2e behind the flag" naturally **consolidates into 3c-ii-d**. 3c-ii-b proves correctness by: (a) Rust `cargo test` on the napi extracts, (b) Vitest unit tests on the orchestrator with injected fakes, including a **new→save→open identity round-trip** through an in-memory fs fake (the behavioral analogue of the 3b `persistence.differential` gate).

---

## File structure

- **Modify** `native/src/napi_backend.rs` — add three `#[napi]` `Backend` methods (`commit_workspace`, `push_recent`, `set_last_new_project_parent`) that are an exact extract of the head/tail of `commands/persistence.rs`, plus a `#[cfg(test)]` Rust test module for them.
- **Modify** `native/index.d.ts` — regenerated by `npm run napi:build` (do NOT hand-edit); the three new methods appear on the `Backend` class for 3c-ii-d to consume.
- **Modify** `src/main/state/serialize.ts` — harden `parseProject` from a bare cast to a structural conformance check (Phase-1 carry-forward (a); spec "Carry-forwards" §`parseProject`).
- **Modify** `src/main/state/persistence.ts` — export `PROJECT_FILE = 'project.json'`.
- **Create** `src/main/state/workspace-orchestrator.ts` — the three pure orchestration functions + their injected-dependency interfaces.
- **Create** `src/main/state/__tests__/workspace-orchestrator.test.ts` — unit tests (fakes + round-trip).
- **Modify** `src/main/state/__tests__/persistence.test.ts` — add `parseProject` structural-rejection tests (or add them in `serialize.test.ts` if that's where serialize tests live; confirm at Task 2).
- **Modify** `fixtures/state-corpus/README.md` — note that 3c-ii-b adds no corpus dimension (orchestration is behavioral) and record the S2 deferral + S1 resolution.

---

### Task 1: Rust napi workspace-commit surface (`commit_workspace` / `push_recent` / `set_last_new_project_parent`)

The Rust-native bookkeeping that `commands/persistence.rs` does around `replace_state` / `save_to_dir`, exposed as three granular napi methods the TS orchestrator (and 3c-ii-d) will drive. Each is a **verbatim extract** of lines already in `persistence.rs`, so the existing persistence behavior is the spec.

**Files:**
- Modify: `native/src/napi_backend.rs` (new `#[napi] impl Backend` methods + a `#[cfg(test)]` test module)
- Modify: `native/index.d.ts` (regenerated by `napi:build`)

**Interfaces:**
- Produces (Rust, `#[napi]` on `Backend`):
  - `pub async fn commit_workspace(&self, path: String) -> napi::Result<()>` — `cache.set_workspace(path)` → `workspace.set(path)` → `agent_session::end_and_emit` → `log_slot.install(LogBus::spawn(path))`. **Async** because `LogBus::spawn` calls `tokio::spawn` internally and needs napi's tokio runtime. Errors only from `cache.set_workspace`.
  - `pub fn push_recent(&self, path: String, display_name: String)` — `recents.push(path, display_name)`. Sync (recents IO is small + synchronous; best-effort inside the store, never errors out).
  - `pub fn set_last_new_project_parent(&self, parent: String)` — `recents.set_last_new_project_parent(parent)`. Sync, best-effort.
- Consumes (existing, all always-compiled): `self.cache` (`CacheLayout::set_workspace`), `self.workspace` (`WorkspaceSlot::set`), `self.events`, `self.agent_session` (`crate::agent_session::end_and_emit`), `self.log_slot` (`LogBusSlot::install`), `crate::logs::LogBus::spawn`, `self.recents` (`RecentsStore::push` / `set_last_new_project_parent`), and for the test `Backend::new_for_test`, `Backend::dispatch`.

- [ ] **Step 1: Add the three napi methods**

In `native/src/napi_backend.rs`, inside the existing `#[napi] impl Backend { … }` block (the one ending at the `export_video_sink_write` method, ~line 270), add after `clear_cloud_key` (these are always-compiled — no feature gate):

```rust
    /// Re-point cache + workspace, end any in-flight agent session, and rotate
    /// the per-workspace LogBus — the pre-broadcast workspace bundle shared by
    /// open / save-as / new-workspace. This is the verbatim head of
    /// `commands::persistence` (cache.set_workspace → workspace.set →
    /// agent_session::end_and_emit → log_slot.install). The TS persistence
    /// orchestrator (Phase 3c-ii-b) calls this BEFORE `replace_state` so any
    /// `project:changed` consumer sees the new workspace first.
    ///
    /// Async: `LogBus::spawn` starts background tasks via `tokio::spawn`, which
    /// needs napi's tokio runtime — a sync `#[napi]` runs on the JS thread with
    /// no runtime and would panic.
    #[napi]
    pub async fn commit_workspace(&self, path: String) -> napi::Result<()> {
        let path = std::path::PathBuf::from(path);
        self.cache
            .set_workspace(&path)
            .map_err(|e| Error::from_reason(format!("cache set_workspace: {e:#}")))?;
        self.workspace.set(path.clone());
        let _ = crate::agent_session::end_and_emit(&*self.events, &self.agent_session);
        self.log_slot
            .install(crate::logs::LogBus::spawn(&path, self.events.clone()));
        Ok(())
    }

    /// `recents.push` — record the workspace in recents.json. The TS orchestrator
    /// calls this AFTER a successful `replace_state` (open / new) or write
    /// (save-as), matching the Rust handler order: a project that fails to load
    /// is never recorded. Best-effort inside the store (failures are logged).
    #[napi]
    pub fn push_recent(&self, path: String, display_name: String) {
        self.recents.push(std::path::PathBuf::from(path), display_name);
    }

    /// `recents.set_last_new_project_parent` — only the new-workspace flow, so the
    /// next "+ New project" form opens pre-filled at the same parent. Best-effort.
    #[napi]
    pub fn set_last_new_project_parent(&self, parent: String) {
        self.recents
            .set_last_new_project_parent(std::path::PathBuf::from(parent));
    }
```

(`Error` and `PathBuf` are already imported at the top of the file: `napi::bindgen_prelude::*` provides `Error`; `std::path::PathBuf` is in `use std::path::PathBuf;`. Use the fully-qualified `std::path::PathBuf` shown above if you prefer not to rely on the top-of-file import.)

- [ ] **Step 2: Add a Rust unit test for the three methods**

Find the existing `#[cfg(test)] mod tests` in `napi_backend.rs` (or the persistence integration tests — search `new_for_test` to locate the test conventions). Add a test that builds a test backend, commits a workspace, and asserts the observable effects via the existing query dispatch arms. **First confirm the exact query command names** by grepping the `dispatch` match for `workspace_dir` and `recents_list` (the fsGuard uses `workspace_dir`; adjust the literals below to match).

```rust
    #[tokio::test]
    async fn commit_workspace_sets_workspace_cache_and_recents() {
        use std::sync::Arc;
        let backend = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
        let dir = std::env::temp_dir().join(format!("weftcut-3cb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();

        backend.commit_workspace(path.clone()).await.unwrap();

        // workspace slot now reports the committed path (verify the command name).
        let ws = backend.dispatch("workspace_dir", "{}").await.unwrap();
        assert_eq!(ws, format!("{:?}", path).replace('\\', "\\\\")); // JSON-stringified path; adjust to the actual encoding the arm returns
        // cache.set_workspace creates <dir>/Cache synchronously.
        assert!(dir.join("Cache").exists(), "cache dir not created");

        backend.push_recent(path.clone(), "Demo".to_string());
        let recents = backend.dispatch("recents_list", "{}").await.unwrap();
        assert!(recents.contains(&path) || recents.contains(&path.replace('\\', "\\\\")),
            "recents_list did not include the pushed path: {recents}");

        let _ = std::fs::remove_dir_all(&dir);
    }
```

Note: the exact JSON encoding of `workspace_dir`'s return (quoting / Windows backslash escaping) is fiddly — prefer asserting `ws.contains(<the path's file name>)` or deserialize `ws` with `serde_json::from_str::<String>(&ws)` and compare the resulting `PathBuf` to `dir` rather than string-matching raw JSON. Make the assertion robust, not brittle.

- [ ] **Step 3: Compile + run the Rust test**

Run (with the build env from Global Constraints exported):
```bash
cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud,motifs commit_workspace_sets_workspace_cache_and_recents -- --nocapture
```
Expected: PASS. If `workspace_dir` / `recents_list` are not the real arm names, fix the literals (grep `dispatch` for the actual `"workspace_*"` / `"recents_*"` strings).

- [ ] **Step 4: Regenerate the TS bindings**

Run (build env exported):
```bash
npm run napi:build
```
Expected: `native/index.d.ts` now declares `commit_workspace(path: string): Promise<void>`, `push_recent(path: string, displayName: string): void`, `set_last_new_project_parent(parent: string): void` on `class Backend`. (napi-rs camelCases the binding names; the `.d.ts` is the source of truth for 3c-ii-d. Do not hand-edit it.)

If the full addon build is infeasible on the current machine, the hard gate for this task is Step 3 (`cargo test`) + a clean `cargo build --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud,motifs`; in that case note in the commit that `index.d.ts` regen is deferred to the next addon build. Prefer to complete the regen here.

- [ ] **Step 5: Commit**

```bash
git add native/src/napi_backend.rs native/index.d.ts
git commit -m "feat(state-migration): granular napi workspace-commit surface (Phase 3c-ii-b)"
```

---

### Task 2: Harden `parseProject` to a structural conformance check

Phase-1 carry-forward (a) / spec "Carry-forwards" §`parseProject`: the current `parseProject` (`serialize.ts:18`) only checks `schema_version`, then bare-casts. 3c-ii-b is "where 3c-ii-b wires real `.vproj` reads," so harden it now to reject a truncated/corrupt `project.json` (right `schema_version`, missing required top-level fields) with a clear error instead of letting `undefined` propagate into the actor. Keep it shallow (top-level presence + primitive/array/object kind) — a full recursive schema validator is YAGNI; the 3b round-trip gate + the prod-differential already prove field-level fidelity for well-formed projects.

**Files:**
- Modify: `src/main/state/serialize.ts`
- Modify (or create): the serialize/persistence unit test file (confirm whether `serialize.test.ts` exists; if not, add to `__tests__/persistence.test.ts`)

**Interfaces:**
- Produces: `parseProject(json: unknown): Project` — unchanged signature, stricter body. New private `assertProjectShape(json): asserts json is Project`-style guard (or inline checks).
- Consumes: `SCHEMA_VERSION`, `Project` (existing).

- [ ] **Step 1: Write the failing tests**

In the serialize/persistence test file, add:

```typescript
import { parseProject } from '../serialize'   // adjust path to the chosen test location
import { SCHEMA_VERSION, blankProject } from '../model'
import { seededGen } from '../ids'

describe('parseProject structural conformance', () => {
  const good = JSON.parse(JSON.stringify({ ...blankProject(seededGen(), 'p') })) // round-trippable plain object

  it('accepts a well-formed project', () => {
    expect(() => parseProject(good)).not.toThrow()
  })
  it('rejects a non-object', () => {
    expect(() => parseProject(42)).toThrow(/not an object/)
  })
  it('rejects a wrong schema_version', () => {
    expect(() => parseProject({ ...good, schema_version: SCHEMA_VERSION - 1 })).toThrow(/schema_version/)
  })
  it('rejects a project missing required top-level fields', () => {
    const { composition, ...noComposition } = good
    expect(() => parseProject(noComposition)).toThrow(/composition/)
    const { tracks, ...noTracks } = good
    expect(() => parseProject(noTracks)).toThrow(/tracks/)
    const { media_pool, ...noPool } = good
    expect(() => parseProject(noPool)).toThrow(/media_pool/)
  })
  it('rejects a wrong field type', () => {
    expect(() => parseProject({ ...good, tracks: {} })).toThrow(/tracks/)
    expect(() => parseProject({ ...good, composition: 'x' })).toThrow(/composition/)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/state/__tests__/<chosen-file>.test.ts -t "structural conformance"`
Expected: FAIL — the missing-field / wrong-type cases currently pass through the bare cast.

- [ ] **Step 3: Implement the structural guard**

Rewrite `parseProject` in `serialize.ts`:

```typescript
/** Validate + type a wire object as a Project. The load guard is the schema
 *  version (project.rs:17-22 rejects others); beyond that, a shallow structural
 *  check rejects a truncated/corrupt project.json (right version, missing/wrong
 *  required fields) with a clear error rather than letting `undefined` reach the
 *  actor. Shallow by design — field-level fidelity is proven by the differential
 *  + round-trip gates, and an undeclared NEW Rust field is carried through by the
 *  spread (acceptable; it can only be lost on the next save, never corrupts). */
export function parseProject(json: unknown): Project {
  if (json === null || typeof json !== 'object') throw new Error('parseProject: not an object')
  const o = json as Record<string, unknown>
  if (o.schema_version !== SCHEMA_VERSION) {
    throw new Error(`parseProject: unsupported schema_version ${String(o.schema_version)} (expected ${SCHEMA_VERSION})`)
  }
  const requireObject = (k: string) => {
    if (o[k] === null || typeof o[k] !== 'object' || Array.isArray(o[k])) throw new Error(`parseProject: ${k} must be an object`)
  }
  const requireArray = (k: string) => {
    if (!Array.isArray(o[k])) throw new Error(`parseProject: ${k} must be an array`)
  }
  const requireString = (k: string) => {
    if (typeof o[k] !== 'string') throw new Error(`parseProject: ${k} must be a string`)
  }
  // Top-level shape of Project (model.ts:98-101). Shallow presence/kind only.
  requireString('project_id')
  requireObject('metadata')
  requireObject('composition')
  requireObject('media_pool')
  requireArray('tracks')
  requireArray('markers')
  requireArray('transitions')
  requireArray('groups')
  requireObject('audio_roles')
  requireObject('settings')
  return json as Project
}
```

(Confirm the exact top-level field set against `model.ts` `interface Project` — the list above is from `model.ts:98-101` + `blankProject`. Add/remove `require*` calls to match exactly.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/state/__tests__/<chosen-file>.test.ts -t "structural conformance"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc -b` (or the project's `typecheck` script) → clean.
```bash
git add src/main/state/serialize.ts src/main/state/__tests__/<chosen-file>.test.ts
git commit -m "feat(state-migration): structural parseProject conformance check (Phase 3c-ii-b)"
```

---

### Task 3: TS workspace orchestrator — interfaces + `openProject`

The orchestrator's dependency-injection seams + the most complex of the three flows. `openProject` mirrors `commands::persistence::project_open` exactly: pre-check sentinels → load (3b) → delete stale quick proxies → `commit_workspace` (pre-broadcast) → `replace_state` → `push_recent`. The derivative re-fan-out is an injected no-op seam here (lit up in 3c-ii-c — see scope finding S2).

**Files:**
- Modify: `src/main/state/persistence.ts` (export `PROJECT_FILE`)
- Create: `src/main/state/workspace-orchestrator.ts`
- Create: `src/main/state/__tests__/workspace-orchestrator.test.ts`

**Interfaces:**
- Produces (`workspace-orchestrator.ts`):
  - `interface WorkspaceNapi { commitWorkspace(path: string): Promise<void>; pushRecent(path: string, displayName: string): Promise<void> | void; setLastNewProjectParent(parent: string): Promise<void> | void }`
  - `interface OrchestratorFs { exists(path: string): boolean; readFile(path: string): string; writeFile(path: string, text: string): void; mkdirp(dir: string): void; rm(path: string): void }` (`rm` is best-effort delete; `readFile` throws if missing — only called after `exists`).
  - `interface OrchestratorDeps { actor: Pick<ActorHandle, 'replaceState' | 'snapshot'>; napi: WorkspaceNapi; fs: OrchestratorFs; join: (...parts: string[]) => string; idGen: IdGen; enqueueDerivatives?: (project: Project) => void }`
  - `function openProject(deps: OrchestratorDeps, dir: string): Promise<void>`
- Consumes: `loadProjectFromJson`, `PROJECT_FILE` (persistence.ts); `ActorHandle` (actor.ts); `Project`, `IdGen` (model.ts / ids.ts).

- [ ] **Step 1: Export `PROJECT_FILE` from `persistence.ts`**

In `src/main/state/persistence.ts`, add near the top (after the imports):

```typescript
/** io/mod.rs:19 — the on-disk project file name inside a workspace folder. */
export const PROJECT_FILE = 'project.json'
```

- [ ] **Step 2: Write the failing `openProject` tests**

Create `src/main/state/__tests__/workspace-orchestrator.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { openProject, type OrchestratorDeps, type OrchestratorFs, type WorkspaceNapi } from '../workspace-orchestrator'
import { serializeProjectToJson, PROJECT_FILE } from '../persistence'
import { blankProject } from '../model'
import { seededGen } from '../ids'

const posixJoin = (...p: string[]) => p.join('/')

/** In-memory fs fake: a flat path→contents map. */
function memFs(seed: Record<string, string> = {}): OrchestratorFs & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>()
  return {
    files, dirs,
    exists: (p) => files.has(p) || dirs.has(p),
    readFile: (p) => { const t = files.get(p); if (t === undefined) throw new Error(`ENOENT ${p}`); return t },
    writeFile: (p, t) => { files.set(p, t) },
    mkdirp: (d) => { dirs.add(d) },
    rm: (p) => { files.delete(p) },
  }
}

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps & { calls: string[] } {
  const calls: string[] = []
  const napi: WorkspaceNapi = {
    commitWorkspace: vi.fn(async (p) => { calls.push(`commit:${p}`) }),
    pushRecent: vi.fn((p, n) => { calls.push(`recent:${p}:${n}`) }),
    setLastNewProjectParent: vi.fn((p) => { calls.push(`parent:${p}`) }),
  }
  const actor = {
    replaceState: vi.fn((_p) => { calls.push('replaceState') }),
    snapshot: vi.fn(() => blankProject(seededGen(), 'snap')),
  }
  return { actor, napi, fs: memFs(), join: posixJoin, idGen: seededGen(), calls, ...over } as OrchestratorDeps & { calls: string[] }
}

describe('openProject', () => {
  const project = blankProject(seededGen(), 'Demo')
  const projectJson = serializeProjectToJson(project)

  it('throws PROJECT_FOLDER_MISSING when the folder is absent', async () => {
    const d = deps()
    await expect(openProject(d, '/ws')).rejects.toThrow('PROJECT_FOLDER_MISSING')
  })

  it('throws NOT_PROJECT_FOLDER when project.json is absent', async () => {
    const d = deps({ fs: memFs() }); (d.fs as any).dirs.add('/ws')
    await expect(openProject(d, '/ws')).rejects.toThrow('NOT_PROJECT_FOLDER')
  })

  it('commits the workspace BEFORE replaceState, pushes recent AFTER', async () => {
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: projectJson }); fs.dirs.add('/ws')
    const d = deps({ fs })
    await openProject(d, '/ws')
    expect(d.calls).toEqual(['commit:/ws', 'replaceState', 'recent:/ws:Demo'])
    expect(d.actor.replaceState).toHaveBeenCalledOnce()
  })

  it('deletes stale quick proxies returned by the loader', async () => {
    // project with one media item carrying a quick_proxy_path
    const withProxy = {
      ...project,
      media_pool: { 'm1': { /* minimal MediaItem; see Step 4 note */ } as any },
    }
    // (Author a realistic MediaItem with quick_proxy_path set; assert fs.rm called with it.)
  })
})
```

(The stale-proxy test needs a realistic `MediaItem`; fill it in Step 4 against `model.ts` `MediaItem` once the happy path is green — or reuse a fixture from `persistence.test.ts`.)

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/main/state/__tests__/workspace-orchestrator.test.ts`
Expected: FAIL — `workspace-orchestrator` module / `openProject` not found.

- [ ] **Step 4: Implement `openProject` + the interfaces**

Create `src/main/state/workspace-orchestrator.ts`:

```typescript
// apps/desktop/src/main/state/workspace-orchestrator.ts
//
// The TS-in-main re-home of commands/persistence.rs (project_open / save_as /
// new_workspace). Pure + dependency-injected: the TS actor handle, a WorkspaceNapi
// facade (the granular Rust bookkeeping), an OrchestratorFs (node:fs in production,
// in-memory in tests), node:path.join, and an idGen. Dormant in 3c-ii-b — the live
// wiring into src/main/index.ts is the 3c-ii-d flip. Mirrors the Rust handler order
// exactly: workspace bookkeeping (cache→workspace→agent-end→LogBus, inside
// commitWorkspace) BEFORE replace_state; recents AFTER a successful swap/write.
import type { ActorHandle } from './actor'
import type { IdGen } from './ids'
import { blankProject, type Project } from './model'
import { loadProjectFromJson, serializeProjectToJson, PROJECT_FILE } from './persistence'

/** The Rust-native workspace bookkeeping, exposed over napi (Backend methods
 *  commit_workspace / push_recent / set_last_new_project_parent). */
export interface WorkspaceNapi {
  /** cache.set_workspace → workspace.set → agent_session end → LogBus rotate. */
  commitWorkspace(path: string): Promise<void>
  /** recents.push — after a successful replace_state / write. */
  pushRecent(path: string, displayName: string): Promise<void> | void
  /** recents.set_last_new_project_parent — new-workspace flow only. */
  setLastNewProjectParent(parent: string): Promise<void> | void
}

/** Filesystem shell, injected so the orchestrator stays unit-testable. */
export interface OrchestratorFs {
  exists(path: string): boolean
  /** Throws if the file is missing — only called after `exists`. */
  readFile(path: string): string
  writeFile(path: string, text: string): void
  /** create_dir_all equivalent. */
  mkdirp(dir: string): void
  /** Best-effort delete (stale quick proxies); must not throw on a missing file. */
  rm(path: string): void
}

export interface OrchestratorDeps {
  actor: Pick<ActorHandle, 'replaceState' | 'snapshot'>
  napi: WorkspaceNapi
  fs: OrchestratorFs
  join: (...parts: string[]) => string
  idGen: IdGen
  /** Open-time derivative re-fan-out. A no-op in 3c-ii-b; 3c-ii-c injects the
   *  live kick-off (paired with the event-based jobs write-back). See plan S2. */
  enqueueDerivatives?: (project: Project) => void
}

/** project_open (persistence.rs:50-108). Pre-check sentinels → load (3b) →
 *  delete stale quick proxies → commit_workspace (pre-broadcast) → replace_state
 *  → push_recent → (deferred) derivative re-fan-out. */
export async function openProject(deps: OrchestratorDeps, dir: string): Promise<void> {
  const { actor, napi, fs, join } = deps
  // Typed sentinels for the two common failure modes (renderer matches them).
  if (!fs.exists(dir)) throw new Error('PROJECT_FOLDER_MISSING')
  const file = join(dir, PROJECT_FILE)
  if (!fs.exists(file)) throw new Error('NOT_PROJECT_FOLDER')

  const text = fs.readFile(file)
  const { project, quickProxiesToDelete } = loadProjectFromJson(text, { dir, join })
  // Best-effort: never fail the open on a leftover proxy we couldn't remove.
  for (const p of quickProxiesToDelete) { try { fs.rm(p) } catch { /* ignore */ } }

  // Re-point cache + workspace BEFORE the state swap, so project:changed
  // consumers see the workspace, not the boot fallback (persistence.rs:71-79).
  await napi.commitWorkspace(dir)
  actor.replaceState(project)                 // throws CommandFailure on invalid; matches Rust replace_state Err
  await napi.pushRecent(dir, project.metadata.name)

  // Re-fan-out derivative jobs (proxies/thumbnails/waveforms). Deferred to
  // 3c-ii-c with the jobs write-back rework (plan S2); a no-op until then.
  deps.enqueueDerivatives?.(project)
}
```

Fill in the Step-2 stale-proxy test's `MediaItem` now (use a minimal valid item with `quick_proxy_path: '/ws/Cache/quick/m1.mp4'`), and assert `d.fs.rm` was called with that path.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/main/state/__tests__/workspace-orchestrator.test.ts`
Expected: PASS (open pre-checks, ordering, stale-proxy delete).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc -b` → clean.
```bash
git add src/main/state/persistence.ts src/main/state/workspace-orchestrator.ts src/main/state/__tests__/workspace-orchestrator.test.ts
git commit -m "feat(state-migration): TS workspace orchestrator openProject + napi seams (Phase 3c-ii-b)"
```

---

### Task 4: TS workspace orchestrator — `saveProjectAs` + `newWorkspace` + round-trip

The two write flows, plus the behavioral round-trip that is this slice's strongest correctness signal (the analogue of the 3b `persistence.differential` gate, but for the live orchestration).

**Files:**
- Modify: `src/main/state/workspace-orchestrator.ts` (add `saveProjectAs`, `newWorkspace`)
- Modify: `src/main/state/__tests__/workspace-orchestrator.test.ts` (add tests + round-trip)

**Interfaces:**
- Produces:
  - `function saveProjectAs(deps: OrchestratorDeps, dir: string): Promise<void>`
  - `interface NewWorkspaceArgs { parentFolder: string; name: string; width: number; height: number; fpsNum: number; fpsDen: number }`
  - `function newWorkspace(deps: OrchestratorDeps, args: NewWorkspaceArgs): Promise<string>` (returns the created workspace path)
- Consumes: `serializeProjectToJson`, `blankProject`, the Task-3 interfaces.

- [ ] **Step 1: Write the failing tests**

Append to `workspace-orchestrator.test.ts`:

```typescript
import { openProject, saveProjectAs, newWorkspace } from '../workspace-orchestrator'
import { canonicalize } from '../canonical'
import { serializeProject } from '../serialize'

describe('saveProjectAs', () => {
  it('snapshots, writes project.json under the dir, commits workspace, pushes recent', async () => {
    const d = deps()
    await saveProjectAs(d, '/out')
    expect((d.fs as any).dirs.has('/out')).toBe(true)
    expect((d.fs as any).files.get(`/out/${PROJECT_FILE}`)).toContain('"schema_version"')
    expect(d.calls).toEqual(['commit:/out', 'recent:/out:snap']) // snapshot() name is 'snap'
    expect(d.actor.replaceState).not.toHaveBeenCalled()           // save-as never swaps state
  })
})

describe('newWorkspace', () => {
  const args = { parentFolder: '/parent', name: 'Fresh', width: 1280, height: 720, fpsNum: 24, fpsDen: 1 }

  it('rejects an empty name', async () => {
    await expect(newWorkspace(deps(), { ...args, name: '  ' })).rejects.toThrow(/name is required/)
  })
  it('rejects a zero canvas/fps', async () => {
    await expect(newWorkspace(deps(), { ...args, width: 0 })).rejects.toThrow(/canvas preset/)
    await expect(newWorkspace(deps(), { ...args, fpsDen: 0 })).rejects.toThrow(/canvas preset/)
  })
  it('rejects an existing target folder', async () => {
    const fs = memFs(); fs.dirs.add('/parent/Fresh')
    await expect(newWorkspace(deps({ fs }), args)).rejects.toThrow(/already exists/)
  })
  it('writes a blank project with the canvas preset, commits, swaps, pushes recent + parent', async () => {
    const d = deps()
    const out = await newWorkspace(d, args)
    expect(out).toBe('/parent/Fresh')
    const written = JSON.parse((d.fs as any).files.get(`/parent/Fresh/${PROJECT_FILE}`))
    expect(written.composition).toMatchObject({ width: 1280, height: 720, fps: { num: 24, den: 1 } })
    expect(d.calls).toEqual(['commit:/parent/Fresh', 'replaceState', 'recent:/parent/Fresh:Fresh', 'parent:/parent'])
  })
})

describe('round-trip: new → save → open is state-identical', () => {
  it('reopens to the same serialized project', async () => {
    // shared in-memory fs so save writes and open reads the same map
    const fs = memFs()
    // capture what newWorkspace replaceState'd, and what openProject replaceState's
    let created: any, reopened: any
    const dNew = deps({ fs }); dNew.actor.replaceState = vi.fn((p) => { created = p })
    const out = await newWorkspace(dNew, { parentFolder: '/p', name: 'RT', width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 })
    // save the created project to its own folder (snapshot returns it)
    const dSave = deps({ fs }); dSave.actor.snapshot = vi.fn(() => created)
    await saveProjectAs(dSave, out)
    // reopen
    const dOpen = deps({ fs }); dOpen.actor.replaceState = vi.fn((p) => { reopened = p })
    await openProject(dOpen, out)
    expect(JSON.stringify(canonicalize(serializeProject(reopened))))
      .toBe(JSON.stringify(canonicalize(serializeProject(created))))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/state/__tests__/workspace-orchestrator.test.ts`
Expected: FAIL — `saveProjectAs` / `newWorkspace` not exported.

- [ ] **Step 3: Implement `saveProjectAs` + `newWorkspace`**

Append to `workspace-orchestrator.ts`:

```typescript
/** project_save_as (persistence.rs:23-48). snapshot → write project.json →
 *  commit_workspace → push_recent. Never swaps state (the actor already holds it). */
export async function saveProjectAs(deps: OrchestratorDeps, dir: string): Promise<void> {
  const { actor, napi, fs, join } = deps
  const snap = actor.snapshot()
  fs.mkdirp(dir)                                              // save_to_dir's create_dir_all
  fs.writeFile(join(dir, PROJECT_FILE), serializeProjectToJson(snap))
  await napi.commitWorkspace(dir)
  await napi.pushRecent(dir, snap.metadata.name)
}

export interface NewWorkspaceArgs {
  parentFolder: string; name: string
  width: number; height: number; fpsNum: number; fpsDen: number
}

/** project_new_workspace (persistence.rs:116-171). Validate → blank project with
 *  the canvas preset → write → commit_workspace → replace_state → push_recent +
 *  set_last_new_project_parent. Returns the created workspace path. */
export async function newWorkspace(deps: OrchestratorDeps, args: NewWorkspaceArgs): Promise<string> {
  const { actor, napi, fs, join, idGen } = deps
  const trimmed = args.name.trim()
  if (trimmed.length === 0) throw new Error('project name is required')
  if (args.width === 0 || args.height === 0 || args.fpsNum === 0 || args.fpsDen === 0) {
    throw new Error('invalid canvas preset')
  }
  const target = join(args.parentFolder, trimmed)
  if (fs.exists(target)) throw new Error(`folder already exists: ${target}`)

  const project = blankProject(idGen, trimmed)
  project.composition.width = args.width
  project.composition.height = args.height
  project.composition.fps = { num: args.fpsNum, den: args.fpsDen }

  fs.mkdirp(target)
  fs.writeFile(join(target, PROJECT_FILE), serializeProjectToJson(project))
  await napi.commitWorkspace(target)
  actor.replaceState(project)
  await napi.pushRecent(target, project.metadata.name)
  await napi.setLastNewProjectParent(args.parentFolder)
  return target
}
```

Note the error-message strings match the Rust handler verbatim (`"project name is required"`, `"invalid canvas preset"`, `"folder already exists: <path>"` — `persistence.rs:128/131/139`) so 3c-ii-d surfaces identical messages to the renderer.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/state/__tests__/workspace-orchestrator.test.ts`
Expected: PASS, including the round-trip.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc -b` → clean.
```bash
git add src/main/state/workspace-orchestrator.ts src/main/state/__tests__/workspace-orchestrator.test.ts
git commit -m "feat(state-migration): TS orchestrator saveProjectAs + newWorkspace + round-trip (Phase 3c-ii-b)"
```

---

### Task 5: Full-suite gate + docs

**Files:**
- Modify: `fixtures/state-corpus/README.md`

- [ ] **Step 1: Run the full state suite + typecheck**

Run: `npx vitest run src/main/state` and `npx tsc -b`
Expected: every prior gate stays green (`commands.differential`, `differential.phase2`, `summary.differential`, `persistence.differential`, all unit suites) + the new `workspace-orchestrator` + `parseProject` tests; `tsc` clean. Confirm `git diff --diff-filter=M fixtures/state-corpus` = ∅ (this slice adds NO corpus dimension — orchestration is behavioral).

- [ ] **Step 2: Document the slice in the corpus README**

In `fixtures/state-corpus/README.md`, add a short note under the phase log: 3c-ii-b re-homes `project_open`/`save_as`/`new_workspace` orchestration into `src/main/state/workspace-orchestrator.ts` (unit + round-trip tested, no corpus dimension). Record the two scope findings: **S1** the load path stays fully TS because `migrate.rs` only gates (`SCHEMA_VERSION=9`, no transforms); **S2** the open-time derivative re-fan-out is built in 3c-ii-c with the jobs write-back (shared `ProjectHandle`/event-seam entanglement). Note the new napi methods `commit_workspace`/`push_recent`/`set_last_new_project_parent` are dormant until the 3c-ii-d flip.

- [ ] **Step 3: Commit**

```bash
git add fixtures/state-corpus/README.md
git commit -m "test(state-migration): full-suite gate + corpus docs (Phase 3c-ii-b)"
```

---

## Self-review notes (carry into execution)

- **Confirm-against-code items (verify to save iterations):** exact `dispatch` arm names for the Rust test's queries (`workspace_dir`, `recents_list`); the exact top-level field set of `interface Project` (`model.ts:98-101`) for the `parseProject` guard; the `VecEventSink::new()` constructor availability for the Rust test (it's used by `new_for_test_with_sink`); the `ActorHandle` `replaceState`/`snapshot` signatures (`actor.ts:49,52` — `snapshot(): Project`, `replaceState(next): void`).
- **Ordering is the keystone:** `commitWorkspace` BEFORE `replaceState`; `pushRecent` AFTER. The `openProject`/`newWorkspace` call-order tests pin this; do not reorder.
- **`replaceState` throws on invalid** (`actor.ts:293` `runValidate` → `CommandFailure`). `openProject` lets it propagate (matches Rust `replace_state` returning `Err`); `push_recent` never runs for a project that failed to swap — preserving "a project that fails to load is never recorded."
- **No `src/main/index.ts` changes, no flag.** This slice is dormant; the atomic flip is 3c-ii-d. If you find yourself wiring the orchestrator into the live `backend:invoke` path, stop — that's the next slice.
- **S2 deferral is a deliberate, confirmed deviation** from the spec's literal §3c-ii-b bullet (`enqueueJobsForMedia`). The `enqueueDerivatives` injected seam is the hook 3c-ii-c fills.
- **Next slice:** 3c-ii-c (autosave port + jobs write-back seam, incl. the deferred open-time derivative re-fan-out).
