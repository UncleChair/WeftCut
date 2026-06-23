# State-actor TS migration — Phase 3c-ii-c Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the autosave subscriber, the jobs derivative write-back event seam, and the open-time derivative re-fan-out for the TS state actor — all as pure, dependency-injected modules + a faithful Rust event-emit path — **built and unit-gated, not yet wired live** (the `backend:invoke` / `onEvent` flip and the `WEFTCUT_TS_ACTOR` flag are 3c-ii-d).

**Architecture:** Three pieces, mirroring `io/autosave.rs` + the `jobs/mod.rs` completion path + `commands/persistence.rs`'s open re-fan-out. (1) A new pure `src/main/state/autosave.ts` subscribes the TS actor, debounces 500 ms, serializes + writes `project.json`, and rotates a `Backups/` snapshot directory — fs/clock/timer injected so it's deterministic in tests. (2) The Rust jobs pipeline gains a derivative-authority toggle + a `commit_media_derivatives` seam: when the TS actor is authoritative it emits `media:derivatives {media_id, patch}` (the patch's `Option<Option<PathBuf>>` proxy fields serialize to the absent/`null`/string tri-state the TS `'key' in patch` contract expects) instead of writing the Rust actor; a new pure `src/main/state/jobs-writeback.ts` `applyDerivativesEvent(actor, payload)` applies it through the gated `set_media_derivatives` dispatch arm. (3) A new napi `Backend::enqueue_jobs_for_media(mediaItemsJson)` invalidates stale-format proxies (via the same seam) then re-enqueues derivative jobs for a media list, and the 3c-ii-b orchestrator's `enqueueDerivatives` seam is given its concrete factory. Nothing in `src/main/index.ts` is rewired — every piece is dormant, exercised only by unit + `cargo` tests, and activated atomically in 3c-ii-d.

**Tech Stack:** TypeScript (Electron main, Immer-based actor), Rust (napi addon `@weftcut/core`, `serde`), Vitest, `cargo test`.

## Global Constraints

- **Working dir for all commands:** `apps/desktop/`. Paths below are relative to it unless absolute.
- **No live wiring in this slice.** Do NOT touch `src/main/index.ts`, the `backend:invoke` handler, the `onEvent` bridge (`index.ts:154-164`), or introduce/read the `WEFTCUT_TS_ACTOR` env flag. Those are 3c-ii-d (the atomic flip, spec §3c-ii-d). 3c-ii-c ships dormant, unit-tested code + the Rust emit path + the napi surface 3c-ii-d will consume.
- **The derivative-authority toggle is an INTERNAL switch, not the launch flag.** Task 1 adds a process-global `AtomicBool` (default `false` = Rust authoritative, today's behavior) with a setter that 3c-ii-d wires to `WEFTCUT_TS_ACTOR`. In 3c-ii-c only the Rust *unit test* flips it. With it off, production behavior is byte-unchanged (jobs still write the Rust actor). Mirrors the det-mode process-global precedent (`state/ids.rs:20`).
- **`save_to_dir` is a plain write (verified `io/mod.rs:24-37`):** `to_string_pretty` → `create_dir_all(dir)` → `write(dir/"project.json", json)`. No atomic temp-rename, no sidecar, no trailing newline. The TS autosave write replicates exactly that: `mkdirp(dir)` then `writeFile(join(dir, PROJECT_FILE), serializeProjectToJson(snapshot))`. Reuse `serializeProjectToJson` + `PROJECT_FILE` from `persistence.ts` — never re-implement serialize.
- **Autosave constants are copied verbatim from `io/autosave.rs:36-41`:** `DEBOUNCE = 500ms`, `SNAPSHOT_EVERY_COMMITS = 50`, `SNAPSHOT_EVERY_DUR = 5*60s`, `RETAIN_SNAPSHOTS = 20`, `BACKUPS_DIR = "Backups"`. The backup-file timestamp is colon-free ISO so it sorts lexicographically == chronologically: Rust `%Y%m%dT%H%M%S%3fZ`; TS `date.toISOString().replace(/[-:.]/g, '')` yields the identical `YYYYMMDDThhmmssSSSZ` form.
- **Tri-state derivative patch (the D5 landmine).** `MediaDerivativesPatch.proxy_path` / `quick_proxy_path` are Rust `Option<Option<PathBuf>>` and TS keys off **`'key' in patch`** (absent = leave / `null` = clear / string = set), NOT `!== undefined` (`mutations/media.ts:67-68`, `actor.rs:269-286`). The Rust→TS event must preserve absent vs `null` vs string. `#[serde(skip_serializing_if = "Option::is_none")]` on the outer `Option` produces exactly that. The other patch fields are plain `Option<T>` (skip-or-value). The TS interface (`mutations/media.ts:45-54`) already matches the Rust struct field-for-field — do NOT change it.
- **napi build env (verified working, prior phases):** `napi:build` = `napi build --platform --release --manifest-path native/Cargo.toml --output-dir native --features jobs,export,mcp,cloud,motifs`. Native builds on this machine need `FFMPEG_DIR=<Gyan.FFmpeg.Shared>/ffmpeg-8.1.1-full_build-shared`, `LIBCLANG_PATH=C:/Program Files/LLVM/bin`, `PATH += $FFMPEG_DIR/bin`. `cargo test` for the Rust units needs the same env + `--features jobs,export,mcp,cloud,motifs`.
- **`native/index.d.ts` is gitignored** (`apps/desktop/.gitignore:4`) — regenerated on-disk but not committed; same as the 3c-ii-b carry-forward (a). The new napi method is regenerated here; 3c-ii-d regenerates the bindings in its own env to consume them.

---

## Scope findings (read before starting — these refine the spec's §3c-ii-c text)

Three findings, each verified against code, that shape this slice:

**S1 — The jobs write-back is gated by an internal authority toggle, not threaded through every job signature.** All 7 completion sites (`jobs/mod.rs:226,306,349,414,493,581,652`) share one shape: `let patch = MediaDerivativesPatch {…}; if let Err(e) = project.set_media_derivatives(actor_for_jobs(), media_id, patch).await { warn!(…); emit(error) }`. Rather than thread a `Backend`/engine handle through `enqueue_for_media` → `spawn_*` → the async tasks (invasive, 7+ signatures), Task 1 introduces a process-global `AtomicBool` consulted by one helper `commit_media_derivatives(&events, &project, media_id, patch)` that replaces the inline actor call at all 7 sites. This mirrors the det-mode global (`ids.rs`) and keeps the diff a 1-line-per-site swap.

**S2 — The TS handler applies through the EXISTING gated dispatch arm; no new mutation logic.** `set_media_derivatives` is already on the TS actor (`actor.ts:374`, dispatch arm `{ media, patch }`; closure `actor.ts:217`; `applySetMediaDerivatives` `mutations/media.ts:62`; UNRECORDED, 1 broadcast id, `MediaNotFound` first). `applyDerivativesEvent` is a thin pure adapter `payload → actor.dispatch('set_media_derivatives', { media, patch })` — it adds parsing + logging, nothing the differential corpus hasn't already gated. The cross-language fidelity risk is purely the *wire shape* of the patch, which Task 1's Rust serialize test + Task 2's golden-fixture test pin from both ends.

**S3 — The open-time derivative re-fan-out + stale-proxy invalidation are inseparable from the jobs seam, so they land here (per the 3c-ii-b S2 deferral).** `commands/persistence.rs:92-105` re-fans `jobs::enqueue_for_media` per media item on open; `io/mod.rs:151` (`invalidate_stale_proxies`, `#[cfg(feature="jobs")]`) clears `proxy_path` for proxies whose `proxy_format_version < PROXY_FORMAT_VERSION` *before* enqueue so a stale cached file isn't treated as ready. In the flipped world the authoritative pool is the TS actor, so both must run Rust-side (they need `PROXY_FORMAT_VERSION`) and report back through the **same `media:derivatives` seam**. Task 4 builds one napi `enqueue_jobs_for_media(mediaItemsJson)` that does invalidate-then-enqueue and wires the orchestrator's `enqueueDerivatives` seam — dormant until 3c-ii-d. The flag-off Rust `project_open` keeps its own in-`load_from_dir` invalidation, so nothing double-runs.

**Non-goal / carry-forward to 3c-ii-d (documented, not built here):**
- The live `onEvent` route `media:derivatives → applyDerivativesEvent`, the `project_save → autosave.forceFlush()` route, injecting the real `enqueueDerivatives` factory into the orchestrator, and setting the authority toggle from the flag at `Backend::init`.
- **The spec's "Playwright e2e behind the flag" consolidates into 3c-ii-d** (same logic as the 3c-ii-b S3 finding): with the flag off, the Rust paths are still authoritative and there's nothing flipped to observe; a meaningful autosave/jobs round-trip needs the renderer mutations + `project_summary` routed to TS, which is 3c-ii-d. 3c-ii-c proves correctness by Vitest unit tests + `cargo test` (the behavioral analogues), not Playwright.
- **Actor attribution:** the Rust path stamps `actor_for_jobs()` = `Agent{client:"jobs"}`; the TS `dispatch` uses the actor handle's default actor. The *state effect* (the pool patch) is identical; only the broadcast event's `actor`/`actor_kind` metadata differs. Refining jobs-driven changes to read as Agent in the TS event payload is a 3c-ii-d wiring detail (the `onEvent` handler can pass an actor hint), NOT a state-fidelity gap.
- **`fresh_media_item` (`jobs/mod.rs:702`)** still reads the *Rust* actor's snapshot as its freshness source, falling back to the enqueue-time item. With the Rust actor stale in the flipped world it returns the fallback (the just-loaded item) — acceptable, since the completion patch only sets specific derivative fields and the TS actor merges them. A Phase-4 cleanup, not a 3c-ii-c blocker.

---

## File structure

- **Modify** `native/src/state/actor.rs` — add `#[derive(Serialize)]` + `#[serde(skip_serializing_if = "Option::is_none")]` to `MediaDerivativesPatch` (struct at `:269-286`).
- **Modify** `native/src/jobs/mod.rs` — add the authority `AtomicBool` + setter + `commit_media_derivatives` helper; replace the 7 inline `project.set_media_derivatives(...)` call sites with it; add `#[cfg(test)]` tests (tri-state serialize golden + emit-vs-actor branch).
- **Modify** `native/src/napi_backend.rs` — add `#[napi] #[cfg(feature="jobs")] pub fn enqueue_jobs_for_media(&self, media_items_json: String) -> napi::Result<()>` (invalidate stale proxies via the seam, then `enqueue_for_media` per item) + a `#[cfg(test)]` test.
- **Modify** `native/index.d.ts` — regenerated by `napi:build` (gitignored; do not hand-edit).
- **Create** `src/main/state/jobs-writeback.ts` — `applyDerivativesEvent(actor, payload)` + the payload type.
- **Create** `src/main/state/__tests__/jobs-writeback.test.ts` — golden-fixture tri-state tests.
- **Create** `src/main/state/autosave.ts` — the injected autosave controller (debounce + persist + Backups rotation + gc + forceFlush).
- **Create** `src/main/state/__tests__/autosave.test.ts` — unit tests (forceFlush write+backup, gc cap, debounce coalescing, snapshot-interval).
- **Modify** `src/main/state/workspace-orchestrator.ts` — extend `WorkspaceNapi` with `enqueueJobsForMedia`; add an exported `makeEnqueueDerivatives(napi)` factory for the 3c-ii-d wiring (the orchestrator body is unchanged — it already calls `deps.enqueueDerivatives?.`).
- **Modify** `src/main/state/__tests__/workspace-orchestrator.test.ts` — test the factory + that `openProject` invokes it.
- **Modify** `fixtures/state-corpus/README.md` — note 3c-ii-c adds no corpus dimension (behavioral), record S1–S3 + the carry-forwards.

---

### Task 1: Rust jobs derivative write-back seam (`commit_media_derivatives` + tri-state serialize)

The authoritative-engine branch for job completion. With the toggle off (default) it calls today's `project.set_media_derivatives`; with it on it emits `media:derivatives {media_id, patch}` as faithful tri-state JSON. This is the single un-gated cross-language wire shape of the slice, pinned from the Rust side here and the TS side in Task 2.

**Files:**
- Modify: `native/src/state/actor.rs` (derive Serialize on `MediaDerivativesPatch`)
- Modify: `native/src/jobs/mod.rs` (toggle + helper + 7 call-site swaps + tests)

**Interfaces:**
- Produces (Rust, `jobs` module):
  - `pub fn set_ts_derivative_authority(on: bool)` — flip the process-global; 3c-ii-d calls this from `Backend::init`.
  - `pub(crate) fn ts_derivative_authority() -> bool` — read it (default `false`).
  - `async fn commit_media_derivatives(events: &Arc<dyn EventSink>, project: &ProjectHandle, media_id: MediaId, patch: MediaDerivativesPatch) -> Result<(), CommandError>` — on (off→Rust actor) / (on→`events.emit("media:derivatives", {media_id, patch})`).
- Event wire (consumed by Task 2): `event = "media:derivatives"`, `payload = { "media_id": "<uuid>", "patch": { …MediaDerivativesPatch… } }`.
- Consumes (existing): `crate::events::EventSink::emit`, `ProjectHandle::set_media_derivatives` (`actor.rs:1738`), `actor_for_jobs()` (`jobs/mod.rs:719`), `MediaDerivativesPatch`, `MediaId`, `CommandError`.

- [ ] **Step 1: Derive `Serialize` on `MediaDerivativesPatch`**

In `native/src/state/actor.rs`, the struct at line 269. First grep to confirm there's no existing hand-written `impl Serialize for MediaDerivativesPatch` (there isn't — it's `#[derive(Clone, Debug, Default)]`). Add `Serialize` to the derive and `skip_serializing_if` to every field. `serde` is already used throughout `actor.rs` (`use serde::{Serialize, Deserialize}` near the top — confirm it's imported; `MarkerPatch` two structs below already derives `Serialize`, so the import exists).

```rust
#[derive(Clone, Debug, Default, Serialize)]
pub struct MediaDerivativesPatch {
    /// Tri-state (Option<Option<PathBuf>>): outer None = absent (leave), Some(None)
    /// = null (clear), Some(Some(p)) = string (set). `skip_serializing_if` on the
    /// OUTER Option is what produces the absent/null/string the TS `'key' in patch`
    /// contract reads (mutations/media.ts:67). DO NOT change to a plain Option.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_path: Option<Option<std::path::PathBuf>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_format_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quick_proxy_path: Option<Option<std::path::PathBuf>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_bypassed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub export_uses_original: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waveform_path: Option<std::path::PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conform_path: Option<std::path::PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnails_dir: Option<std::path::PathBuf>,
}
```

(Field order/names are unchanged — only the derive + attributes are added. The default serde field name is the snake_case Rust field name, which already matches the TS interface keys.)

- [ ] **Step 2: Write the failing Rust tests (serialize tri-state + emit branch)**

In `native/src/jobs/mod.rs`, in the existing `#[cfg(test)] mod tests` (near `:725`), add. Use `serde_json::to_value` for the tri-state assertions and `VecEventSink` for the emit-branch assertion.

```rust
    #[test]
    fn derivatives_patch_serializes_tristate() {
        use crate::state::MediaDerivativesPatch;
        use serde_json::json;

        // absent: outer None → key omitted entirely.
        let p = MediaDerivativesPatch { conform_path: Some("c.bin".into()), ..Default::default() };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("proxy_path").is_none(), "absent proxy_path must be omitted");
        assert_eq!(v.get("conform_path").unwrap(), &json!("c.bin"));

        // clear: Some(None) → null.
        let p = MediaDerivativesPatch { proxy_path: Some(None), ..Default::default() };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("proxy_path").unwrap(), &serde_json::Value::Null);

        // set: Some(Some(path)) → string.
        let p = MediaDerivativesPatch { quick_proxy_path: Some(Some("q.mp4".into())), ..Default::default() };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("quick_proxy_path").unwrap(), &json!("q.mp4"));

        // plain bool field skips when None, emits when Some.
        let p = MediaDerivativesPatch { proxy_bypassed: Some(true), ..Default::default() };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("proxy_bypassed").unwrap(), &json!(true));
    }

    #[tokio::test]
    async fn commit_derivatives_emits_event_when_ts_authoritative() {
        use crate::events::VecEventSink;
        use crate::state::{spawn, MediaDerivativesPatch, Project};
        use std::sync::Arc;

        let sink = Arc::new(VecEventSink::new());
        let events: Arc<dyn crate::events::EventSink> = sink.clone();
        let handle = spawn(Project::new_blank("ts-auth"));
        let media_id = uuid::Uuid::now_v7();

        set_ts_derivative_authority(true);
        let patch = MediaDerivativesPatch { proxy_path: Some(None), conform_path: Some("c.bin".into()), ..Default::default() };
        commit_media_derivatives(&events, &handle, media_id, patch).await.unwrap();
        set_ts_derivative_authority(false); // reset the global for other tests

        let recorded = sink.events.lock().unwrap().clone();
        let (name, payload) = recorded.iter().find(|(n, _)| n == "media:derivatives")
            .expect("a media:derivatives event must be emitted in TS mode");
        assert_eq!(name, "media:derivatives");
        assert_eq!(payload.get("media_id").unwrap(), &serde_json::json!(media_id.to_string()));
        let patch_v = payload.get("patch").unwrap();
        assert_eq!(patch_v.get("proxy_path").unwrap(), &serde_json::Value::Null); // cleared
        assert_eq!(patch_v.get("conform_path").unwrap(), &serde_json::json!("c.bin"));
    }
```

(Confirm `spawn` + `Project::new_blank` are re-exported from `crate::state` — `io/autosave.rs:231` uses `use crate::state::{spawn, Actor, Project};`, so they are. The test resets the global; if the harness runs tests in parallel within the file, the `set(true)…set(false)` window could race a Rust-mode test — keep the two emit/actor tests in one `#[tokio::test]` or use `serial_test` if already a dep; otherwise the single test above is self-contained and resets.)

- [ ] **Step 3: Run to verify failure**

```bash
cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud,motifs \
  derivatives_patch_serializes_tristate commit_derivatives_emits_event -- --nocapture
```
Expected: FAIL — `set_ts_derivative_authority` / `commit_media_derivatives` not defined (and the serialize test fails to compile until Step 1's derive lands, which it does).

- [ ] **Step 4: Implement the toggle + helper**

In `native/src/jobs/mod.rs`, near the top (after the existing `use` block + the `ffmpeg_sem`/`conform_in_flight` globals, ~line 60), add:

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use crate::state::CommandError;

/// Which engine owns the project state's media-pool, for job-completion
/// write-back. `false` (default) = the Rust actor is authoritative (today's
/// behavior: jobs call `set_media_derivatives` directly). `true` = the TS
/// actor in Electron main is authoritative; completion emits a
/// `media:derivatives` event the main process applies to the TS actor (spec
/// 3c-ii / D5). 3c-ii-d sets this at `Backend::init` from `WEFTCUT_TS_ACTOR`;
/// in 3c-ii-c only tests flip it. Process-global by the same rationale as the
/// det-id toggle (`state/ids.rs`): jobs spawn from many sites and a global
/// avoids threading an engine handle through every signature.
static TS_DERIVATIVE_AUTHORITY: AtomicBool = AtomicBool::new(false);

/// Set the derivative write-back authority (see `TS_DERIVATIVE_AUTHORITY`).
pub fn set_ts_derivative_authority(on: bool) {
    TS_DERIVATIVE_AUTHORITY.store(on, Ordering::SeqCst);
}

pub(crate) fn ts_derivative_authority() -> bool {
    TS_DERIVATIVE_AUTHORITY.load(Ordering::SeqCst)
}

/// Apply a completed job's derivative patch to whichever engine is
/// authoritative. Rust mode: the actor command (unchanged). TS mode: emit
/// `media:derivatives {media_id, patch}` — the patch serializes with the
/// absent/null/string tri-state for the `Option<Option<PathBuf>>` proxy fields
/// (mutations/media.ts:67). Returns `Ok` in TS mode (fire-and-forget; the TS
/// actor's `set_media_derivatives` is `MediaNotFound`-tolerant and the caller
/// only logs failures). `pub(crate)` so the open re-fan-out napi (Task 4) can
/// reuse the same seam for stale-proxy clearing.
pub(crate) async fn commit_media_derivatives(
    events: &Arc<dyn EventSink>,
    project: &ProjectHandle,
    media_id: MediaId,
    patch: MediaDerivativesPatch,
) -> Result<(), CommandError> {
    if ts_derivative_authority() {
        events.emit(
            "media:derivatives",
            serde_json::json!({ "media_id": media_id.to_string(), "patch": patch }),
        );
        Ok(())
    } else {
        project.set_media_derivatives(actor_for_jobs(), media_id, patch).await
    }
}
```

(`MediaId` is already imported at `:45`; `EventSink` at `:40`; `ProjectHandle` + `MediaDerivativesPatch` at `:45`. Add `CommandError` to the `crate::state::{…}` import or import it standalone as shown — confirm it isn't already imported to avoid a duplicate.)

- [ ] **Step 5: Swap the 7 completion call sites**

At each of the 7 sites (`jobs/mod.rs` ~`:226,306,349,414,493,581,652`), the current shape is:

```rust
                if let Err(e) = project
                    .set_media_derivatives(actor_for_jobs(), media_id, patch)
                    .await
                {
```

Replace the `project.set_media_derivatives(actor_for_jobs(), media_id, patch).await` call with `commit_media_derivatives(&events, &project, media_id, patch).await`, leaving the `if let Err(e) = … { warn!(…); emit(error) }` wrapper untouched:

```rust
                if let Err(e) = commit_media_derivatives(&events, &project, media_id, patch).await {
```

Do all 7. (They're inside `tokio::spawn(async move { … })` closures that own `events` + `project` by move; `&events`/`&project` borrow them — fine, the closure keeps using them after, but each site is the last use within its match arm. If a borrow-after-move complains, the site already `.clone()`s `events`/`project` earlier for the `emit` calls; pass `&events`/`&project` — they're owned locals in the async move block, borrowing is OK.) Grep to confirm zero remaining `project.set_media_derivatives` calls in `jobs/mod.rs`:

```bash
grep -n "\.set_media_derivatives(" native/src/jobs/mod.rs   # expect: none
```

- [ ] **Step 6: Run to verify pass**

```bash
cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud,motifs \
  derivatives_patch_serializes_tristate commit_derivatives_emits_event -- --nocapture
```
Expected: PASS. Also run the existing jobs tests to confirm no regression: `cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud,motifs jobs::`.

- [ ] **Step 7: Commit**

```bash
git add native/src/state/actor.rs native/src/jobs/mod.rs
git commit -m "feat(state-migration): jobs derivative write-back seam + tri-state serialize (Phase 3c-ii-c)"
```

---

### Task 2: TS jobs write-back handler (`applyDerivativesEvent`)

The main-process adapter that applies a `media:derivatives` event to the TS actor through the gated dispatch arm. Pure (actor injected). Golden fixtures lock the exact wire shapes Task 1 emits.

**Files:**
- Create: `src/main/state/jobs-writeback.ts`
- Create: `src/main/state/__tests__/jobs-writeback.test.ts`

**Interfaces:**
- Produces:
  - `interface MediaDerivativesEvent { media_id: string; patch: MediaDerivativesPatch }`
  - `function applyDerivativesEvent(actor: Pick<ActorHandle, 'dispatch'>, payload: MediaDerivativesEvent): DispatchResult` — calls `actor.dispatch('set_media_derivatives', { media: payload.media_id, patch: payload.patch })`; returns the result; on `!ok` logs a `console.warn` (a `MediaNotFound` is benign — the media may have been removed between enqueue and completion) and still returns it.
- Consumes: `ActorHandle`, `DispatchResult` (`actor.ts`); `MediaDerivativesPatch` (`mutations/media.ts`).

- [ ] **Step 1: Write the failing tests**

Create `src/main/state/__tests__/jobs-writeback.test.ts`. The fixtures are the EXACT JSON shapes Task 1's Rust serialize test asserts — paste them as parsed objects so this gates the wire contract from the TS end.

```typescript
import { describe, it, expect, vi } from 'vitest'
import { applyDerivativesEvent } from '../jobs-writeback'
import { createActor, type ActorHandle } from '../actor'
import { blankProject, type MediaItem, type Project } from '../model'
import { seededGen } from '../ids'

const MID = '00000000-0000-0000-0000-0000000000aa'

function actorWithMedia(): ActorHandle {
  const idGen = seededGen()
  const base = blankProject(idGen, 'p')
  const item: MediaItem = {
    id: MID, label: null, path_abs: '/ws/Media/clip.mp4', path_rel: 'Media/clip.mp4',
    kind: 'Video', metadata: { duration_us: 1_000_000 }, file_hash_blake3: 'x', file_size: 0, file_mtime: 0,
    imported_at: '2026-01-01T00:00:00Z', proxy_path: 'old.mp4', quick_proxy_path: null,
    proxy_bypassed: false, export_uses_original: false, proxy_format_version: 0,
    conform_path: null, waveform_path: null, thumbnails_dir: null,
  }
  const initial: Project = { ...base, media_pool: { [MID]: item } }
  return createActor({ initial, idGen })
}

describe('applyDerivativesEvent', () => {
  it('SET: a string proxy_path is applied', () => {
    const a = actorWithMedia()
    const r = applyDerivativesEvent(a, { media_id: MID, patch: { proxy_path: 'new.mp4', proxy_format_version: 3 } })
    expect(r.ok).toBe(true)
    expect(a.snapshot().media_pool[MID].proxy_path).toBe('new.mp4')
    expect(a.snapshot().media_pool[MID].proxy_format_version).toBe(3)
  })

  it('CLEAR: an explicit null proxy_path clears it (tri-state)', () => {
    const a = actorWithMedia()
    applyDerivativesEvent(a, { media_id: MID, patch: { proxy_path: null } })
    expect(a.snapshot().media_pool[MID].proxy_path).toBeNull()
  })

  it('LEAVE: an absent proxy_path key leaves the existing value', () => {
    const a = actorWithMedia()
    applyDerivativesEvent(a, { media_id: MID, patch: { conform_path: 'c.bin' } }) // no proxy_path key
    expect(a.snapshot().media_pool[MID].proxy_path).toBe('old.mp4')   // unchanged
    expect(a.snapshot().media_pool[MID].conform_path).toBe('c.bin')
  })

  it('returns MediaNotFound (and warns) for an unknown media id without throwing', () => {
    const a = actorWithMedia()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = applyDerivativesEvent(a, { media_id: '00000000-0000-0000-0000-0000000000ff', patch: { proxy_bypassed: true } })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.error).toBe('MediaNotFound')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/state/__tests__/jobs-writeback.test.ts`
Expected: FAIL — module `../jobs-writeback` not found.

- [ ] **Step 3: Implement the handler**

Create `src/main/state/jobs-writeback.ts`:

```typescript
// apps/desktop/src/main/state/jobs-writeback.ts
//
// Main-process adapter for the Rust jobs derivative write-back (spec 3c-ii / D5).
// When the TS actor is authoritative, a completed background job (proxy /
// thumbnail / waveform / conform) emits `media:derivatives { media_id, patch }`
// (native/src/jobs/mod.rs commit_media_derivatives) instead of writing the Rust
// actor; the onEvent bridge routes it here (live route wired in 3c-ii-d). This
// is a thin adapter over the gated `set_media_derivatives` dispatch arm
// (actor.ts:374) — the patch's proxy fields carry the absent/null/string
// tri-state (`'key' in patch`, mutations/media.ts:67) the Rust serialize
// preserves. UNRECORDED on the actor (durable across undo; 1 broadcast id).
import type { ActorHandle, DispatchResult } from './actor'
import type { MediaDerivativesPatch } from './mutations/media'

export interface MediaDerivativesEvent {
  media_id: string
  patch: MediaDerivativesPatch
}

/** Apply a `media:derivatives` event to the TS actor. Returns the dispatch
 *  result. A `MediaNotFound` is benign (the media may have been removed between
 *  job enqueue and completion) — logged, not thrown, matching the Rust path's
 *  `warn!`-and-continue on a `set_media_derivatives` Err. */
export function applyDerivativesEvent(
  actor: Pick<ActorHandle, 'dispatch'>,
  payload: MediaDerivativesEvent,
): DispatchResult {
  const r = actor.dispatch('set_media_derivatives', { media: payload.media_id, patch: payload.patch })
  if (!r.ok) {
    console.warn(`[jobs-writeback] set_media_derivatives failed for ${payload.media_id}: ${r.error.error}`)
  }
  return r
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/state/__tests__/jobs-writeback.test.ts`
Expected: PASS (set / clear / leave tri-state + MediaNotFound).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc -b` → clean.
```bash
git add src/main/state/jobs-writeback.ts src/main/state/__tests__/jobs-writeback.test.ts
git commit -m "feat(state-migration): TS jobs derivative write-back handler (Phase 3c-ii-c)"
```

---

### Task 3: Autosave port (`src/main/state/autosave.ts`)

Port `io/autosave.rs`: subscribe the TS actor, debounce 500 ms, serialize + write `project.json`, rotate `Backups/`. Pure + dependency-injected (actor / fs / clock / timer / workspace-dir), so the debounce + interval + gc are deterministic in tests — the analogue of the Rust module's `force_flush`-driven + `gc_snapshots`-driven tests.

**Files:**
- Create: `src/main/state/autosave.ts`
- Create: `src/main/state/__tests__/autosave.test.ts`

**Interfaces:**
- Produces:
  - `interface AutosaveFs { writeFile(path: string, text: string): void; exists(path: string): boolean; copyFile(src: string, dest: string): void; mkdirp(dir: string): void; readdir(dir: string): string[]; rm(path: string): void }`
  - `interface AutosaveDeps { actor: Pick<ActorHandle, 'subscribe' | 'snapshot'>; fs: AutosaveFs; workspaceDir: () => string | null; join: (...parts: string[]) => string; serialize: (p: Project) => string; now?: () => Date; debounceMs?: number; setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clearTimer?: (h: ReturnType<typeof setTimeout>) => void }`
  - `interface AutosaveController { start(): void; forceFlush(): Promise<void>; stop(): void }`
  - `function createAutosave(deps: AutosaveDeps): AutosaveController`
  - `export const BACKUPS_DIR = 'Backups'`
- Consumes: `ActorHandle`, `ChangeEvent` (`actor.ts`); `Project` (`model.ts`); `serializeProjectToJson`, `PROJECT_FILE` (`persistence.ts`, passed in as `serialize`/used by the caller).

- [ ] **Step 1: Write the failing tests**

Create `src/main/state/__tests__/autosave.test.ts`. Most tests drive `forceFlush()` (deterministic, like the Rust `force_flush_writes_project_and_snapshot` test); one uses `vi.useFakeTimers()` for debounce coalescing; one injects `now` to step the snapshot interval.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAutosave, BACKUPS_DIR, type AutosaveFs, type AutosaveDeps } from '../autosave'
import { createActor, type ActorHandle } from '../actor'
import { serializeProjectToJson, PROJECT_FILE } from '../persistence'
import { blankProject } from '../model'
import { seededGen } from '../ids'

/** In-memory fs: files map + dirs set, with copyFile/readdir for Backups. */
function memFs(): AutosaveFs & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    files, dirs,
    writeFile: (p, t) => { files.set(p, t) },
    exists: (p) => files.has(p) || dirs.has(p),
    copyFile: (s, d) => { const t = files.get(s); if (t === undefined) throw new Error(`ENOENT ${s}`); files.set(d, t) },
    mkdirp: (d) => { dirs.add(d) },
    readdir: (d) => [...files.keys()].filter((k) => k.startsWith(d + '/')).map((k) => k.slice(d.length + 1)),
    rm: (p) => { files.delete(p) },
  }
}

const posixJoin = (...p: string[]) => p.join('/')

function setup(over: Partial<AutosaveDeps> = {}) {
  const fs = (over.fs as ReturnType<typeof memFs>) ?? memFs()
  const idGen = seededGen()
  const actor: ActorHandle = createActor({ initial: blankProject(idGen, 'auto'), idGen })
  const deps: AutosaveDeps = {
    actor, fs, workspaceDir: () => '/ws', join: posixJoin, serialize: serializeProjectToJson,
    now: () => new Date('2026-06-23T12:00:00.000Z'), ...over,
  }
  return { fs, actor, deps, ctl: createAutosave(deps) }
}

describe('autosave forceFlush', () => {
  it('writes project.json and a Backups snapshot', async () => {
    const { fs, ctl } = setup()
    ctl.start()
    await ctl.forceFlush()
    ctl.stop()
    expect(fs.files.has(`/ws/${PROJECT_FILE}`)).toBe(true)
    // a snapshot landed in Backups/ with the colon-free timestamp form.
    const backups = [...fs.files.keys()].filter((k) => k.startsWith(`/ws/${BACKUPS_DIR}/`))
    expect(backups).toHaveLength(1)
    expect(backups[0]).toBe(`/ws/${BACKUPS_DIR}/20260623T120000000Z.json`)
  })

  it('is a no-op when no workspace is set', async () => {
    const { fs, ctl } = setup({ workspaceDir: () => null })
    ctl.start(); await ctl.forceFlush(); ctl.stop()
    expect(fs.files.size).toBe(0)
  })
})

describe('autosave debounce', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces a flurry of commits into ONE write after 500ms quiet', async () => {
    const { fs, actor, ctl } = setup()
    ctl.start()
    for (let i = 0; i < 5; i++) actor.dispatch('add_track', {})  // 5 commits in quick succession
    expect(fs.files.has(`/ws/${PROJECT_FILE}`)).toBe(false)       // nothing written yet (debouncing)
    await vi.advanceTimersByTimeAsync(500)
    expect(fs.files.has(`/ws/${PROJECT_FILE}`)).toBe(true)        // exactly one write after quiet
    ctl.stop()
  })
})

describe('Backups gc + snapshot interval', () => {
  it('caps retained snapshots at 20 (oldest dropped)', async () => {
    const fs = memFs()
    // 25 pre-existing snapshots with sortable names.
    for (let i = 0; i < 25; i++) fs.files.set(`/ws/${BACKUPS_DIR}/200001${String(i).padStart(2, '0')}T000000000Z.json`, '{}')
    fs.files.set(`/ws/${PROJECT_FILE}`, '{}')
    // step `now` forward so each forceFlush mints a distinct backup name.
    let t = Date.parse('2026-06-23T12:00:00.000Z')
    const { ctl } = setup({ fs, now: () => new Date((t += 1000)) })
    ctl.start(); await ctl.forceFlush(); ctl.stop()
    const remaining = [...fs.files.keys()].filter((k) => k.startsWith(`/ws/${BACKUPS_DIR}/`) && k.endsWith('.json'))
    expect(remaining).toHaveLength(20)
  })

  it('debounced writes snapshot only every 50 commits or 5 minutes', async () => {
    vi.useFakeTimers()
    let t = Date.parse('2026-06-23T12:00:00.000Z')
    const { fs, actor, ctl } = setup({ now: () => new Date(t) })
    ctl.start()
    // one debounced write at t0 → snapshots (first commit, last_snapshot_at starts now → 0 elapsed,
    // commits_since=1 < 50, so NO snapshot on the first debounced write per Rust). Assert no backup yet.
    actor.dispatch('add_track', {}); await vi.advanceTimersByTimeAsync(500)
    expect([...fs.files.keys()].some((k) => k.startsWith(`/ws/${BACKUPS_DIR}/`))).toBe(false)
    // advance wall clock past 5 min, one more debounced write → snapshot fires.
    t += 5 * 60_000 + 1
    actor.dispatch('add_track', {}); await vi.advanceTimersByTimeAsync(500)
    expect([...fs.files.keys()].some((k) => k.startsWith(`/ws/${BACKUPS_DIR}/`))).toBe(true)
    ctl.stop(); vi.useRealTimers()
  })
})
```

(If a unit test's reliance on the exact first-write snapshot behavior proves brittle, simplify to assert "forceFlush always snapshots" + "gc caps at 20" + "debounce coalesces" — the snapshot-interval nuance is faithfully ported but the keystone assertions are the write coalescing + the cap.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/state/__tests__/autosave.test.ts`
Expected: FAIL — `../autosave` not found.

- [ ] **Step 3: Implement the autosave controller**

Create `src/main/state/autosave.ts`:

```typescript
// apps/desktop/src/main/state/autosave.ts
//
// Auto-save subscriber + periodic Backups/ snapshots — the TS port of
// native/src/io/autosave.rs. Per docs/data-model.md the workspace is the truth:
// every actor commit eventually lands on disk as project.json, no explicit Save.
// Subscribes the TS actor, debounces 500ms (a 10-event drag → one write), stays
// silent while no workspace is set, and after each successful write copies
// project.json to Backups/<timestamp>.json once 50 commits OR 5 minutes elapse
// (whichever first), retaining the most recent 20. forceFlush() skips the
// debounce (the Cmd-S / quit gate). Pure + injected (fs / clock / timer /
// workspace-dir) so the debounce, interval, and gc are deterministic in tests.
// Dormant in 3c-ii-c — the live wiring (subscribe at backend bring-up;
// project_save → forceFlush) is the 3c-ii-d flip.
import type { ActorHandle, ChangeEvent } from './actor'
import type { Project } from './model'
import { PROJECT_FILE } from './persistence'

const DEBOUNCE_MS = 500
const SNAPSHOT_EVERY_COMMITS = 50
const SNAPSHOT_EVERY_MS = 5 * 60 * 1000
const RETAIN_SNAPSHOTS = 20
export const BACKUPS_DIR = 'Backups'

export interface AutosaveFs {
  writeFile(path: string, text: string): void
  exists(path: string): boolean
  copyFile(src: string, dest: string): void
  mkdirp(dir: string): void
  readdir(dir: string): string[]
  rm(path: string): void
}

export interface AutosaveDeps {
  actor: Pick<ActorHandle, 'subscribe' | 'snapshot'>
  fs: AutosaveFs
  /** workspace.current() — null in the blank-boot window before Save As / Open. */
  workspaceDir: () => string | null
  join: (...parts: string[]) => string
  /** serializeProjectToJson (persistence.ts) — injected to keep this module pure. */
  serialize: (p: Project) => string
  now?: () => Date
  debounceMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void
}

export interface AutosaveController {
  start(): void
  forceFlush(): Promise<void>
  stop(): void
}

export function createAutosave(deps: AutosaveDeps): AutosaveController {
  const now = deps.now ?? (() => new Date())
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))

  let unsubscribe: (() => void) | null = null
  let pending: ReturnType<typeof setTimeout> | null = null
  let commitsSinceSnapshot = 0
  let lastSnapshotAtMs = now().getTime()

  /** ISO-8601, no colons/dashes/dots — sorts lexicographically == chronologically
   *  (Windows-filename-safe). Matches Rust `%Y%m%dT%H%M%S%3fZ` (io/autosave.rs:196). */
  function stamp(): string {
    return now().toISOString().replace(/[-:.]/g, '')
  }

  function persist(ws: string): void {
    deps.fs.writeFile(deps.join(ws, PROJECT_FILE), deps.serialize(deps.actor.snapshot()))
  }

  function takeSnapshot(ws: string): void {
    const src = deps.join(ws, PROJECT_FILE)
    if (!deps.fs.exists(src)) return // defensive: nothing to copy yet
    const backups = deps.join(ws, BACKUPS_DIR)
    deps.fs.mkdirp(backups)
    deps.fs.copyFile(src, deps.join(backups, `${stamp()}.json`))
    gcSnapshots(backups)
  }

  function gcSnapshots(backups: string): void {
    const names = deps.fs.readdir(backups).filter((n) => n.endsWith('.json'))
    names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) // descending: newest (largest) first
    for (const stale of names.slice(RETAIN_SNAPSHOTS)) {
      try { deps.fs.rm(deps.join(backups, stale)) } catch { /* logged-only in prod; ignore */ }
    }
  }

  /** Debounced write: persist, then snapshot if the commit/time threshold passed. */
  function flushDebounced(): void {
    pending = null
    const ws = deps.workspaceDir()
    if (ws === null) return // no workspace yet — edits stay dirty for the next cycle
    persist(ws)
    commitsSinceSnapshot += 1
    if (commitsSinceSnapshot >= SNAPSHOT_EVERY_COMMITS || now().getTime() - lastSnapshotAtMs >= SNAPSHOT_EVERY_MS) {
      takeSnapshot(ws)
      commitsSinceSnapshot = 0
      lastSnapshotAtMs = now().getTime()
    }
  }

  function onChange(_e: ChangeEvent): void {
    if (pending !== null) clearTimer(pending)
    pending = setTimer(flushDebounced, debounceMs)
  }

  return {
    start() {
      if (unsubscribe) return
      unsubscribe = deps.actor.subscribe(onChange)
    },
    /** Flush + snapshot right now, skipping the debounce (Cmd-S / quit gate). The
     *  force path always snapshots and resets the counters (io/autosave.rs:106-113). */
    async forceFlush(): Promise<void> {
      if (pending !== null) { clearTimer(pending); pending = null }
      const ws = deps.workspaceDir()
      if (ws === null) return
      persist(ws)
      takeSnapshot(ws)
      commitsSinceSnapshot = 0
      lastSnapshotAtMs = now().getTime()
    },
    stop() {
      if (pending !== null) { clearTimer(pending); pending = null }
      if (unsubscribe) { unsubscribe(); unsubscribe = null }
    },
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/main/state/__tests__/autosave.test.ts`
Expected: PASS. If the snapshot-interval test is brittle, relax it per the Step-1 note (keep forceFlush-snapshot + gc-cap + debounce-coalesce as the hard assertions).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc -b` → clean.
```bash
git add src/main/state/autosave.ts src/main/state/__tests__/autosave.test.ts
git commit -m "feat(state-migration): TS autosave subscriber + Backups rotation (Phase 3c-ii-c)"
```

---

### Task 4: Open-time derivative re-fan-out (napi `enqueue_jobs_for_media` + orchestrator factory)

The 3c-ii-b S2 deferral. On open, the loaded media pool's derivative jobs must be re-fanned (proxies/thumbnails/waveforms regenerate) and stale-format proxies invalidated — both Rust-side (they need `PROXY_FORMAT_VERSION`), reporting back through Task 1's `media:derivatives` seam. One new napi method + the orchestrator's `enqueueDerivatives` factory; dormant until 3c-ii-d injects it.

**Files:**
- Modify: `native/src/napi_backend.rs` (new `#[napi]` method + `#[cfg(test)]` test)
- Modify: `native/index.d.ts` (regenerated by `napi:build`)
- Modify: `src/main/state/workspace-orchestrator.ts` (extend `WorkspaceNapi`; add `makeEnqueueDerivatives`)
- Modify: `src/main/state/__tests__/workspace-orchestrator.test.ts`

**Interfaces:**
- Produces (Rust, `#[napi] #[cfg(feature="jobs")]` on `Backend`):
  - `pub async fn enqueue_jobs_for_media(&self, media_items_json: String) -> napi::Result<()>` — **async** (napi drives it on the tokio runtime; `enqueue_for_media` internally `tokio::spawn`s, which panics from a sync napi on the JS thread — same reason 3c-ii-b made `commit_workspace` async). Deserialize `Vec<MediaItem>`; for each: if it has a `proxy_path` whose `proxy_format_version < jobs::proxy::PROXY_FORMAT_VERSION`, clear it (`.await commit_media_derivatives` with `proxy_path: Some(None)`, best-effort delete the file) and pass a cleared copy onward; then `jobs::enqueue_for_media(self.events.clone(), self.cache.clone(), self.project()?, item)`.
- Produces (TS, `workspace-orchestrator.ts`):
  - extend `interface WorkspaceNapi` with `enqueueJobsForMedia(mediaItemsJson: string): Promise<void> | void` (async napi binding → `Promise<void>`; the factory fire-and-forgets it)
  - `function makeEnqueueDerivatives(napi: Pick<WorkspaceNapi, 'enqueueJobsForMedia'>): (project: Project) => void` — `(p) => { void napi.enqueueJobsForMedia(JSON.stringify(Object.values(serializeProject(p).media_pool))) }`
- Consumes: `jobs::enqueue_for_media` (`jobs/mod.rs:142`), `jobs::proxy::PROXY_FORMAT_VERSION`, `commit_media_derivatives` (Task 1, now `pub(crate)`), `self.project()` (`napi_backend.rs:398`-style accessor), `MediaItem`; `serializeProject` (`serialize.ts`), `Project` (`model.ts`).

- [ ] **Step 1: Add the napi method + Rust test**

In `native/src/napi_backend.rs`, inside the `#[napi] impl Backend` block, add (gate on `jobs` — production always builds it; the `.d.ts` declares it for 3c-ii-d):

```rust
    /// Re-fan-out background derivative jobs for a media list (open-time
    /// regeneration of proxies / thumbnails / waveforms) — the TS-orchestrated
    /// analogue of `commands::persistence::project_open`'s post-load enqueue loop
    /// (persistence.rs:92-105). First invalidates stale-format proxies (the
    /// `load_from_dir` `invalidate_stale_proxies` pass, io/mod.rs:151): a proxy
    /// whose `proxy_format_version` predates the encoder's current version is
    /// cleared (through the derivative write-back seam, so the authoritative
    /// engine's pool drops it) and its cached file best-effort deleted, so the
    /// enqueue below doesn't see a stale file as "ready". `media_items_json` is a
    /// JSON array of serialized `MediaItem` (the TS actor's pool values).
    #[napi]
    #[cfg(feature = "jobs")]
    pub async fn enqueue_jobs_for_media(&self, media_items_json: String) -> napi::Result<()> {
        use crate::jobs::proxy::PROXY_FORMAT_VERSION;
        let items: Vec<crate::state::MediaItem> = serde_json::from_str(&media_items_json)
            .map_err(|e| Error::from_reason(format!("parse media list: {e}")))?;
        let handle = self.project().map_err(Error::from_reason)?;
        for mut item in items {
            let stale = item.proxy_path.is_some() && item.proxy_format_version < PROXY_FORMAT_VERSION;
            if stale {
                if let Some(path) = item.proxy_path.take() {
                    let _ = std::fs::remove_file(&path); // best-effort; logged-only in prod
                }
                // Clear the stale proxy through the same seam as job completion, so
                // the authoritative engine's pool drops it (TS mode emits the event;
                // Rust mode writes the actor). We're in an async napi → tokio runtime
                // is present, so `.await` directly. `item` carries the cleared copy on.
                let patch = crate::state::MediaDerivativesPatch { proxy_path: Some(None), ..Default::default() };
                let _ = crate::jobs::commit_media_derivatives(&self.events, &handle, item.id, patch).await;
            }
            crate::jobs::enqueue_for_media(self.events.clone(), self.cache.clone(), handle.clone(), item);
        }
        Ok(())
    }
```

(`enqueue_for_media` is sync but internally `tokio::spawn`s its jobs; calling it from this async method runs inside napi's tokio runtime, so the spawn has a context. A *sync* `#[napi]` here would panic on that spawn — hence `async`.)

Then a Rust test in `napi_backend.rs`'s `#[cfg(test)] mod tests` (search `new_for_test` for the convention). Build a test backend with a `VecEventSink`, flip `set_ts_derivative_authority(true)`, call `enqueue_jobs_for_media` with one stale-proxy item, and assert a `media:derivatives` clearing event (`proxy_path: null`) is emitted. Reset the toggle after.

```rust
    #[tokio::test]
    async fn enqueue_jobs_for_media_invalidates_stale_proxy() {
        use std::sync::Arc;
        let sink = Arc::new(crate::events::VecEventSink::new());
        let backend = Backend::new_for_test(sink.clone());
        backend.dispatch("__init_project_for_test", "{}").await.ok(); // ensure a project handle exists (see note)
        crate::jobs::set_ts_derivative_authority(true);

        // a media item with a proxy at format version 0 (stale vs current PROXY_FORMAT_VERSION).
        let item = serde_json::json!({
            "id": uuid::Uuid::now_v7().to_string(), "label": null,
            "path_abs": "/x/clip.mp4", "path_rel": null, "kind": "Video",
            "metadata": {}, "proxy_path": "/x/stale.mp4", "proxy_format_version": 0,
            "quick_proxy_path": null, "proxy_bypassed": false, "export_uses_original": false,
            "waveform_path": null, "conform_path": null, "thumbnails_dir": null,
            "file_hash_blake3": "h", "file_size": 0, "file_mtime": 0, "imported_at": "2026-01-01T00:00:00Z"
        });
        backend.enqueue_jobs_for_media(serde_json::to_string(&serde_json::json!([item])).unwrap())
            .await.unwrap();   // commit_media_derivatives is awaited inline — no sleep needed
        crate::jobs::set_ts_derivative_authority(false);

        let names = sink.names();
        assert!(names.iter().any(|n| n == "media:derivatives"), "stale proxy must emit a clearing event; saw {names:?}");
    }
```

**Confirm before coding:** how `new_for_test` installs a project handle (the test needs `self.project()` to succeed). If `new_for_test` doesn't spawn an actor, use the same project-handle setup the existing persistence/backend tests use (grep `new_for_test` + `project()` in the test module). The `__init_project_for_test` line above is a placeholder — replace with the real setup. Also confirm `MediaItem`'s exact JSON field set by reusing a serialized fixture from an existing test rather than hand-writing the object, to avoid a deserialize mismatch.

- [ ] **Step 2: Run to verify the Rust test fails then passes**

```bash
cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud,motifs \
  enqueue_jobs_for_media_invalidates_stale_proxy -- --nocapture
```
Iterate until PASS. (If `enqueue_for_media` requires a real ffmpeg to not panic, note it spawns tokio tasks that run ffmpeg under a semaphore and return immediately — the synchronous `enqueue_jobs_for_media` body returns before any ffmpeg runs, so the test asserts only the emitted clearing event, not job completion.)

- [ ] **Step 3: Regenerate the TS bindings**

```bash
npm run napi:build
```
Expected: `native/index.d.ts` declares `enqueueJobsForMedia(mediaItemsJson: string): Promise<void>` on `class Backend` (async napi → `Promise`). (Gitignored; not committed. If the full addon build is infeasible here, the hard gate is the `cargo test` + a clean `cargo build … --features jobs,export,mcp,cloud,motifs`; note the regen is deferred to 3c-ii-d's env.)

- [ ] **Step 4: Write the failing orchestrator-factory test**

Append to `src/main/state/__tests__/workspace-orchestrator.test.ts`:

```typescript
import { makeEnqueueDerivatives } from '../workspace-orchestrator'

describe('makeEnqueueDerivatives', () => {
  it('serializes the media pool values and calls the napi once', () => {
    const calls: string[] = []
    const enqueue = makeEnqueueDerivatives({ enqueueJobsForMedia: (json) => { calls.push(json) } })
    const project = blankProject(seededGen(), 'D') // empty pool → "[]"
    enqueue(project)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0])).toEqual([])
  })

  it('openProject runs the injected enqueueDerivatives after replaceState', async () => {
    const fs = memFs({ [`/ws/${PROJECT_FILE}`]: serializeProjectToJson(blankProject(seededGen(), 'Demo')) }); fs.dirs.add('/ws')
    const seen: unknown[] = []
    const d = deps({ fs, enqueueDerivatives: (p) => seen.push(p) })
    await openProject(d, '/ws')
    expect(seen).toHaveLength(1)
  })
})
```

- [ ] **Step 5: Implement the factory + interface extension**

In `src/main/state/workspace-orchestrator.ts`: extend `WorkspaceNapi`:

```typescript
export interface WorkspaceNapi {
  commitWorkspace(path: string): Promise<void>
  pushRecent(path: string, displayName: string): Promise<void> | void
  setLastNewProjectParent(parent: string): Promise<void> | void
  /** jobs::enqueue_for_media per media item (open-time derivative re-fan-out +
   *  stale-proxy invalidation). Built in 3c-ii-c; injected as enqueueDerivatives
   *  by the 3c-ii-d flip. mediaItemsJson = JSON array of serialized MediaItem.
   *  Async napi binding → Promise; the factory fire-and-forgets it. */
  enqueueJobsForMedia(mediaItemsJson: string): Promise<void> | void
}
```

Add the factory + the `serializeProject` import (`import { serializeProject } from './serialize'`):

```typescript
/** Build the `enqueueDerivatives` seam from the napi facade: serialize the
 *  project's media-pool values and hand them to the Rust open-time job re-fan-out
 *  (workspace-orchestrator's `enqueueDerivatives?` hook). Fire-and-forget (the
 *  Rust enqueue returns immediately; jobs run on tokio). 3c-ii-d injects this into
 *  the live OrchestratorDeps. Dormant in 3c-ii-c. */
export function makeEnqueueDerivatives(
  napi: Pick<WorkspaceNapi, 'enqueueJobsForMedia'>,
): (project: Project) => void {
  return (project) => { void napi.enqueueJobsForMedia(JSON.stringify(Object.values(serializeProject(project).media_pool))) }
}
```

(The `openProject`/`saveProjectAs`/`newWorkspace` bodies do NOT change — `openProject` already calls `deps.enqueueDerivatives?.(project)` at `:73`.)

- [ ] **Step 6: Run to verify pass + typecheck**

Run: `npx vitest run src/main/state/__tests__/workspace-orchestrator.test.ts` → PASS.
Run: `npx tsc -b` → clean.

- [ ] **Step 7: Commit**

```bash
git add native/src/napi_backend.rs native/src/jobs/mod.rs native/index.d.ts src/main/state/workspace-orchestrator.ts src/main/state/__tests__/workspace-orchestrator.test.ts
git commit -m "feat(state-migration): open-time derivative re-fan-out napi + orchestrator factory (Phase 3c-ii-c)"
```

---

### Task 5: Full-suite gate + docs

**Files:**
- Modify: `fixtures/state-corpus/README.md`

- [ ] **Step 1: Run the full state suite + typecheck + Rust units**

```bash
npx vitest run src/main/state
npx tsc -b
cargo test --manifest-path native/Cargo.toml --features jobs,export,mcp,cloud,motifs derivatives_patch_serializes_tristate commit_derivatives_emits_event enqueue_jobs_for_media_invalidates_stale_proxy jobs::
```
Expected: every prior gate stays green (`commands.differential`, `differential.phase2`, `summary.differential`, `persistence.differential`, all unit suites) + the new `jobs-writeback` / `autosave` / orchestrator-factory tests; `tsc` clean; Rust units pass. Confirm `git diff --diff-filter=M fixtures/state-corpus` = ∅ (this slice adds NO corpus dimension — autosave/jobs/open are behavioral, not state-evolution).

- [ ] **Step 2: Document the slice in the corpus README**

In `fixtures/state-corpus/README.md`, add a short note under the phase log: 3c-ii-c ports autosave (`src/main/state/autosave.ts`), the jobs derivative write-back seam (`media:derivatives` event → `src/main/state/jobs-writeback.ts`), and the open-time derivative re-fan-out (`Backend::enqueue_jobs_for_media` + orchestrator `makeEnqueueDerivatives`) — unit + `cargo` tested, no corpus dimension. Record S1 (the internal authority toggle, not the launch flag), S2 (the TS handler reuses the gated dispatch arm), S3 (open re-fan-out + stale-proxy invalidation fold here per the 3c-ii-b S2 deferral), and the 3c-ii-d carry-forwards (live `onEvent`/`project_save`/`enqueueDerivatives` wiring, the authority-toggle→flag wiring, actor attribution, `fresh_media_item`'s stale Rust-actor read).

- [ ] **Step 3: Commit**

```bash
git add fixtures/state-corpus/README.md
git commit -m "test(state-migration): full-suite gate + corpus docs (Phase 3c-ii-c)"
```

---

## Self-review notes (carry into execution)

- **Confirm-against-code items (verify to save iterations):** that `serde::Serialize` is imported in `actor.rs` (a sibling `MarkerPatch` derives it, so yes); that no hand-written `Serialize for MediaDerivativesPatch` exists; the exact `new_for_test` + project-handle setup for the Task-4 Rust test (grep `new_for_test`); `MediaItem`'s exact JSON field set (reuse a serialized fixture, don't hand-write); that `self.project()` returns a `ProjectHandle` clone usable by `enqueue_for_media`; the `ActorHandle.subscribe` signature returns an unsubscribe `() => void` (`actor.ts:53,548`).
- **Tri-state is the keystone:** the Rust `skip_serializing_if` on the OUTER `Option<Option<…>>` (Task 1 Step 1) and the TS `'key' in patch` (existing `applySetMediaDerivatives`) are two halves of one contract. Task 1's serialize test and Task 2's golden fixtures pin both ends — do not weaken either to `!= undefined`/plain `Option`.
- **No live wiring, no launch flag.** The authority toggle is an internal `AtomicBool` flipped only by tests in this slice; the `onEvent` route, `project_save` route, `enqueueDerivatives` injection, and toggle←flag wiring are all 3c-ii-d. If you find yourself editing `src/main/index.ts`, stop.
- **Autosave determinism:** drive the hard assertions through `forceFlush()` + `gcSnapshots` (mirrors the Rust tests); use `vi.useFakeTimers()` only for the debounce-coalescing and interval cases. The colon-free timestamp (`toISOString().replace(/[-:.]/g,'')`) must byte-match the Rust `%Y%m%dT%H%M%S%3fZ` form so backups sort chronologically.
- **`save_to_dir` parity:** TS autosave writes `serializeProjectToJson(snapshot)` to `join(ws, PROJECT_FILE)` with `mkdirp` — no atomic rename, no trailing newline (matches `io/mod.rs:24-37`).
- **Next slice:** 3c-ii-d — the flip: `backend:invoke` splitter routing category-A to the TS production adapter + `project_summary` to `buildProjectSummary`; the `onEvent` route for `media:derivatives`; `project_save` → autosave `forceFlush`; inject `makeEnqueueDerivatives` + the real `WorkspaceNapi`/`AutosaveFs`; set the authority toggle + det/prod from `WEFTCUT_TS_ACTOR`; **gate the `add_media_layer` AUTO-PAIR first** (the 3c-ii-a hard-gate carry-forward); pause MCP category-A mutations during the soak (D6).
```
