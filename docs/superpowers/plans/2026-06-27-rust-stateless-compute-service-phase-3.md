# Rust stateless-compute-service — Phase 3: MCP resources

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every MCP resource read stateless. The TS MCP host serves the pure-state `project://*` views directly from the actor (the sole state owner); the three resources that stay Rust compute become stateless — `project://compiled` (audio mix plan) takes an injected full project, `media://*` (binary) takes an injected `MediaItem`, and `composition://meter` reads live Rust state (no slice). After this phase `mcp/resources.rs` no longer calls `snapshot_for_read`, so the mirror's last reader is gone (the mirror itself is deleted in Phase 5).

**Architecture:** Spec `docs/superpowers/specs/2026-06-27-rust-stateless-compute-service-design.md`, Phase 3, building on the Phase 1/2 pattern (the TS host injects state at the call boundary; Rust drops `snapshot_for_read`). Resource reads flow agent → `server.ts` `ReadResourceRequestSchema` → (TS-served | `backend.mcpReadResource`). The split:

- **TS-served (no Rust call):** `project://current`, `project://composition`, `project://media`, `project://tracks`, `project://markers`, `project://history`, `project://layers/{id}` — built directly from `actor.snapshot()` / `actor.historyView(100)` and returned as the same wire `{ contents: [{ uri, mimeType, text }] }` the Rust `text_resource` produced. (This is exactly the existing `motifs://current` TS-served pattern.)
- **Rust compute, stateless:** `project://compiled` (needs `crate::audio::mix::plan_for_project` — Rust-only), `media://*` (needs `b.cache` + `jobs::extract_frame` — Rust-only), `composition://meter` (reads `b.audio_meter` — live Rust state). The host forwards these to `backend.mcpReadResource(uri, injectionJson)`; the Rust `read_resource` deserializes the injected `{ project?, media? }` slice instead of reading the mirror.

The napi `mcp_read_resource` gains a second arg (the injected state JSON). This is the one structural difference from Phases 1/2 (which injected into the existing JSON args of `dispatch`/`mcpCallTool` and so needed no napi rebuild): the resource entry point takes only a URI, so adding the slice requires a signature change → one `napi:build`.

**Tech Stack:** Rust (napi-rs addon, `apps/desktop/native`), TypeScript (Electron main + MCP host, `apps/desktop/src/main`). Rust async via tokio; tests via `cargo test`. TS tests via vitest. MCP wire types in `mcp/wire.rs`; SDK low-level `Server` in `server.ts`.

## Global Constraints

- Native Rust build/test MUST pass `--features export,mcp,cloud` — the default (no-feature) build does not compile. (`export` and `cloud` both imply `jobs`.)
- **napi rebuild:** changing `mcp_read_resource`'s signature regenerates `native/index.d.ts` (gitignored, built locally). Run `npm --prefix apps/desktop run napi:build` after the Rust task and BEFORE any TS typecheck that passes the second arg. **Close the app first** — the running `weftcut-core.*.node` is file-locked on Windows. The new arg is `state_json: Option<String>` so the existing 1-arg flag-off call (`backend.mcpReadResource(uri)`) still typechecks across the transition.
- Do NOT delete `read_mirror` / `set_project_mirror` / `snapshot_for_read` / `mirror_history_view` / the per-commit mirror push — that is Phase 5. Phase 3 only removes their last *callers* in `mcp/resources.rs`. `snapshot_for_read` and `mirror_history_view` become caller-less after this phase; mark them `#[allow(dead_code)]` (deleted in Phase 5). `read_mirror_handle` stays in use (the `media.rs` enqueue path; removed in Phase 4).
- The advertised resource catalog (`static_resources()` in `mcp/resources.rs`) is UNCHANGED — URIs are the contract; who serves them is transparent to the agent. Only the READS move.
- TS-served `project://current` uses `serializeProject(snapshot)` (the same wire shape the mirror pushed — identity except group member sort); `project://history` uses `actor.historyView(100)` (byte-identical to what `pushMirror` mirrored as `historyViewJson`).
- Commit after each task. Stage by explicit path (other sessions edit this checkout concurrently).
- End every task green on `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud` and `npm --prefix apps/desktop run typecheck` + `npm --prefix apps/desktop test`.

---

## File Structure

- `apps/desktop/native/src/mcp/resources.rs` — add a `ResourceState { project, media }` slice struct; `read_resource(b, uri, state_json)` drops `snapshot_for_read` and the `project://*` view arms (now TS-served), keeping only `project://compiled` (injected project), `composition://meter` (no state), and the `media://*` peel-off (injected `MediaItem`); `read_media_resource` takes `Option<MediaItem>` instead of `&Project`; replace the `read_mirror_tests` module with stateless tests.
- `apps/desktop/native/src/napi_backend.rs` — `mcp_read_resource(uri, state_json: Option<String>)`; mark `snapshot_for_read` / `mirror_history_view` `#[allow(dead_code)]`; extend the source-guard `mirror_backed_reads_use_the_mirror_not_an_actor` to assert `mcp/resources.rs` no longer reads the mirror.
- `apps/desktop/src/main/state/resource-views.ts` (new) + `__tests__/resource-views.test.ts` (new) — `serveProjectResource` (TS-served views) + `buildResourceInjection` (compute-resource slice).
- `apps/desktop/src/main/mcp/server.ts` — extract `handleReadResource(backend, getTsHost, uri)` (exported, testable, mirroring `handleCallTool`); serve the project views in TS, inject the slice for the compute resources; `buildMcpServer`'s `ReadResourceRequestSchema` handler delegates to it.
- `apps/desktop/src/main/mcp/server.resource.test.ts` (new) — integration test for `handleReadResource`.

---

## Task 1: Rust — `read_resource` becomes stateless (inject project/media, drop the mirror) + relax the guard + rebuild napi

`read_resource` calls `b.snapshot_for_read().await?` once at the top and feeds that `snap` to every `project://*` arm + the `media://*` peel-off + `project://compiled`. Phase 3 removes that read: the project-view arms move to TS (Task 2), `project://compiled` takes the project from an injected slice, and `media://*` takes the `MediaItem` from the slice. `composition://meter` already needs no project (it reads `b.audio_meter`). Removing the last `snapshot_for_read` from `resources.rs` trips the whole-file guard, so the guard relaxation must land in the SAME commit (same lesson as Phase 1 Task 2 / Phase 2 Task 1).

**Files:**
- Modify: `apps/desktop/native/src/mcp/resources.rs:57-155` (the `read_resource` fn), `:184-246` (`read_media_resource` signature, both cfg variants), `:390-413` (the test module)
- Modify: `apps/desktop/native/src/napi_backend.rs:364-367` (`mcp_read_resource`), `:391-408` (`snapshot_for_read` / `mirror_history_view` allow-dead-code), `:828-903` (the source-guard)

**Interfaces:**
- Produces: `pub(crate) async fn read_resource(b: &Backend, uri: &str, state_json: &str) -> Result<ResourceResult, McpToolError>`
- Produces: `mcp_read_resource(&self, uri: String, state_json: Option<String>) -> napi::Result<String>` (napi; regenerates `mcpReadResource(uri: string, stateJson?: string | undefined | null)` in `index.d.ts`)
- Internal: `struct ResourceState { project: Option<crate::state::Project>, media: Option<crate::state::MediaItem> }` (serde-default both)

- [ ] **Step 1: Replace the test module with stateless tests (failing).** In `apps/desktop/native/src/mcp/resources.rs`, replace the entire `mod read_mirror_tests { ... }` block (`:390-413`) with:

```rust
#[cfg(test)]
mod stateless_tests {
    use super::*;
    use crate::napi_backend::Backend;

    /// project://compiled computes the audio mix plan from the INJECTED project
    /// (Phase 3), not the mirror. A blank project has no audio layers, so the plan
    /// is an empty layer list — proving the arm read `state.project`.
    #[cfg(feature = "export")]
    #[tokio::test]
    async fn compiled_uses_injected_project() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        let p = crate::state::Project::new_blank("compiled-test");
        let state = serde_json::json!({ "project": p }).to_string();
        let r = read_resource(&b, URI_COMPILED, &state).await.unwrap();
        let text = match &r.contents[0] {
            ResourceContent::Text { text, .. } => text.clone(),
            _ => panic!("expected text"),
        };
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(body["kind"], "audio_mix_plan");
        assert_eq!(body["layers"].as_array().unwrap().len(), 0, "blank project has no audio layers");
    }

    /// composition://meter reads live Rust state and needs no injected slice — an
    /// empty state JSON resolves to `live: false` (nothing has played).
    #[tokio::test]
    async fn meter_needs_no_state() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        let r = read_resource(&b, URI_METER, "{}").await.unwrap();
        let text = match &r.contents[0] {
            ResourceContent::Text { text, .. } => text.clone(),
            _ => panic!("expected text"),
        };
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(body["live"], false);
    }

    /// project://* state views are now served by the TS MCP host — the Rust reader
    /// no longer handles them and returns a clear not-found.
    #[tokio::test]
    async fn project_views_are_not_served_by_rust() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        let err = read_resource(&b, "project://current", "{}").await.unwrap_err();
        assert!(
            err.message.contains("TS-served") || err.message.contains("unknown"),
            "project://current must report it is TS-served; got: {}", err.message
        );
    }

    /// media://* resolves from the INJECTED MediaItem (Phase 3). With a fabricated
    /// item whose thumbnail cache is empty, the reader reports "not generated yet"
    /// — proving it read `state.media` (it never touched the mirror).
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn media_resource_uses_injected_item() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let id = uuid::Uuid::now_v7();
        let item = serde_json::json!({
            "id": id, "label": null, "path_abs": "/nonexistent", "path_rel": null,
            "kind": "Video", "metadata": crate::state::MediaMetadata::default(),
            "proxy_path": null, "proxy_format_version": 0, "quick_proxy_path": null,
            "proxy_bypassed": false, "export_uses_original": false, "waveform_path": null,
            "conform_path": null, "thumbnails_dir": null,
            "file_hash_blake3": format!("test-{id}"), "file_size": 0, "file_mtime": 0,
            "imported_at": chrono::Utc::now(),
        });
        let state = serde_json::json!({ "media": item }).to_string();
        let uri = format!("media://{id}/thumbnail");
        let err = read_resource(&b, &uri, &state).await.unwrap_err();
        assert!(
            err.message.contains("not generated yet"),
            "media:// must read the injected item (cache empty → not generated yet); got: {}", err.message
        );
    }
}
```

- [ ] **Step 2: Run them — verify they fail to compile.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud --no-run`
Expected: FAIL — `read_resource` still has the 2-arg signature `(b, uri)`, so the 3-arg calls in the new tests do not compile (and `ResourceContent`/`URI_*` are referenced — they exist). This is the red state for a signature-changing refactor.

- [ ] **Step 3: Add the `ResourceState` slice struct.** In `apps/desktop/native/src/mcp/resources.rs`, after the `const` block (after `:39`, before `fn serialize_err`), add:

```rust
/// The state slice the TS MCP host injects for the resources that stay Rust
/// compute (Phase 3): `project://compiled` needs the full project (audio mix
/// plan); `media://*` needs the `MediaItem` resolved by id. `composition://meter`
/// reads live Rust state and needs neither. Both fields `serde(default)` so a
/// stateless read (`{}`) parses cleanly. The `project://*` state views are served
/// directly by the TS host and never reach this reader.
#[derive(Default, serde::Deserialize)]
struct ResourceState {
    #[serde(default)]
    project: Option<crate::state::Project>,
    #[serde(default)]
    media: Option<crate::state::MediaItem>,
}
```

- [ ] **Step 4: Rewrite `read_resource`.** In `apps/desktop/native/src/mcp/resources.rs`, replace the whole `read_resource` fn (`:57-155`) with:

```rust
pub(crate) async fn read_resource(
    b: &Backend,
    uri: &str,
    state_json: &str,
) -> Result<ResourceResult, McpToolError> {
    let state: ResourceState = serde_json::from_str(state_json).map_err(|e| {
        McpToolError::internal_error(format!("resource state injection: {e}"), None)
    })?;

    // media://* paths return binary content (image bytes, peaks file) and need the
    // MediaItem the TS host resolved by id (Phase 3 — TS owns state). We peel them
    // off here so the rest of `read_resource` can stay text/JSON oriented.
    if let Some(tail) = uri.strip_prefix(PREFIX_MEDIA) {
        return read_media_resource(b, uri, tail, state.media).await;
    }

    let body: Value = match uri {
        // The preview master-bus meter is live Rust state (no project needed).
        URI_METER => meter_payload(b),
        URI_COMPILED => {
            // The audio mix plan IS the compiled view of the export audio pipeline
            // (the lavfi IR it replaced is gone; ADR 0019). Envelope point COUNTS,
            // not values — keyframed gain on a long layer would be hundreds of
            // thousands of floats. A transient ConformMissing state reports inline
            // instead of failing the read. The TS host injects the full project
            // (Phase 3) — this resource is agent-triggered and infrequent.
            let project = state.project.ok_or_else(|| {
                McpToolError::internal_error(
                    "project://compiled requires the injected project (TS host)".to_string(),
                    None,
                )
            })?;
            match crate::audio::mix::plan_for_project(&project, None) {
                Ok(plan) => serde_json::json!({
                    "kind": "audio_mix_plan",
                    "sample_rate": crate::audio::mix::MIX_SAMPLE_RATE,
                    "window_frames": [plan.window_start_frame, plan.window_end_frame],
                    "layers": plan.layers.iter().map(|l| serde_json::json!({
                        "label": l.label,
                        "conform_path": l.conform_path.display().to_string(),
                        "start_frame": l.start_frame,
                        "src_in_frame": l.src_in_frame,
                        "src_out_frame": l.src_out_frame,
                        "gain_constant": l.gain.is_constant(),
                        "gain_points": l.gain.values.len(),
                        "pan_constant": l.pan.is_constant(),
                        "pan_points": l.pan.values.len(),
                    })).collect::<Vec<_>>(),
                }),
                Err(e) => serde_json::json!({
                    "kind": "audio_mix_plan",
                    "error": e.to_string(),
                }),
            }
        }
        // Phase 3 (stateless-compute-service): project://current / composition /
        // media / tracks / markers / history / layers/{id} are served directly by
        // the TS MCP host (the sole state owner) and never reach this reader.
        other => {
            return Err(McpToolError::resource_not_found(
                format!(
                    "unknown or TS-served resource URI: {other} (project://* state views are served by the TS MCP host since Phase 3)",
                ),
                None,
            ));
        }
    };

    text_resource(uri, &body)
}
```

Note: this drops the now-unused `use crate::state::LayerId;` (`:13`) and `use uuid::Uuid;` (`:10`) if no other code in the file uses them. `read_media_resource` still uses `Uuid` and `MediaId` (jobs-gated). `LayerId` was only used by the deleted `project://layers/` arm → remove the `use crate::state::LayerId;` line. Leave the jobs-gated `use` block (`:15-20`) untouched.

- [ ] **Step 5: Change `read_media_resource` to take `Option<MediaItem>`.** In `apps/desktop/native/src/mcp/resources.rs`, update BOTH cfg variants. The jobs variant (`:184-233`) — replace the signature and the `snap.media_pool.get(...)` lookup (`:204-213`) with the injected item:

```rust
#[cfg(feature = "jobs")]
async fn read_media_resource(
    b: &Backend,
    uri: &str,
    tail: &str,
    media: Option<MediaItem>,
) -> Result<ResourceResult, McpToolError> {
    // tail = "{id}/thumbnail" | "{id}/frame/{t_us}" | "{id}/waveform"
    let (id_part, sub) = tail.split_once('/').ok_or_else(|| {
        McpToolError::resource_not_found(
            format!("media URI missing sub-path: {uri}"),
            None,
        )
    })?;
    let media_id: MediaId = Uuid::parse_str(id_part).map_err(|_| {
        McpToolError::resource_not_found(
            format!("media URI has invalid UUID: {id_part}"),
            None,
        )
    })?;
    let media = media.ok_or_else(|| {
        McpToolError::resource_not_found(
            format!("media {media_id} not found"),
            None,
        )
    })?;

    if sub == "thumbnail" {
        serve_thumbnail(b, uri, &media).await
    } else if sub == "waveform" {
        serve_waveform(b, uri, &media).await
    } else if let Some(t_str) = sub.strip_prefix("frame/") {
        let t_us: i64 = t_str.parse().map_err(|_| {
            McpToolError::invalid_params(
                format!("frame URI t_us not an integer: {t_str}"),
                None,
            )
        })?;
        serve_frame(b, uri, &media, t_us).await
    } else {
        Err(McpToolError::resource_not_found(
            format!("unknown media sub-resource '{sub}'"),
            None,
        ))
    }
}
```

And the not-jobs variant (`:235-246`) — replace its signature so the `media` field is consumed in every build (no unused-field warning):

```rust
#[cfg(not(feature = "jobs"))]
async fn read_media_resource(
    _b: &Backend,
    uri: &str,
    _tail: &str,
    _media: Option<crate::state::MediaItem>,
) -> Result<ResourceResult, McpToolError> {
    Err(McpToolError::resource_not_found(
        format!("media resources require the jobs feature: {uri}"),
        None,
    ))
}
```

- [ ] **Step 6: Update the napi entry point.** In `apps/desktop/native/src/napi_backend.rs:364-367`, replace `mcp_read_resource`:

```rust
    #[napi]
    pub async fn mcp_read_resource(&self, uri: String, state_json: Option<String>) -> napi::Result<String> {
        // The TS MCP host injects the { project } / { media } slice the Rust
        // compute resources need (Phase 3); empty for stateless reads (meter).
        let state = state_json.as_deref().unwrap_or("{}");
        Ok(crate::mcp::reply(crate::mcp::read_resource(self, &uri, state).await))
    }
```

- [ ] **Step 7: Mark the now-caller-less mirror readers `#[allow(dead_code)]`.** In `apps/desktop/native/src/napi_backend.rs`, `resources.rs` was the last caller of both. Add the attribute (deleted in Phase 5). On `snapshot_for_read` (`:396`) prepend a line:

```rust
    /// Caller-less after Phase 3 (resources.rs no longer reads the mirror); kept
    /// until Phase 5 deletes the mirror wholesale.
    #[allow(dead_code)]
    pub(crate) async fn snapshot_for_read(&self) -> std::result::Result<std::sync::Arc<crate::state::Project>, String> {
```

And on `mirror_history_view` (`:406`):

```rust
    /// The mirrored history view (project://history) — caller-less after Phase 3
    /// (the TS host serves project://history from `actor.historyView`); deleted in Phase 5.
    #[allow(dead_code)]
    pub(crate) fn mirror_history_view(&self) -> Option<serde_json::Value> {
```

- [ ] **Step 8: Extend the source-guard to `mcp/resources.rs` (same commit).** In `apps/desktop/native/src/napi_backend.rs`, in `mirror_backed_reads_use_the_mirror_not_an_actor` (`:833-903`): read `mcp/resources.rs`, add it to the `.project()?.snapshot()` prohibition loop, and assert it no longer reads the mirror. After the `let tools = std::fs::read_to_string(...)` line (`:840-841`), add:

```rust
        let resources = std::fs::read_to_string(format!("{root}/src/mcp/resources.rs"))
            .expect("mcp/resources.rs must be readable");
```

Add `("mcp/resources.rs", &resources),` to the array in the `.project()?.snapshot()` loop (`:844-848`). Then, after the `mcp/tools.rs` assert block (`:872-879`), add:

```rust
        // Phase 3 (stateless-compute-service): MCP resource reads no longer touch
        // the mirror — the TS host serves the project:// state views directly and
        // injects the project / MediaItem the Rust compute resources need
        // (project://compiled, media://*). composition://meter reads live Rust state.
        assert!(
            !resources.contains("snapshot_for_read"),
            "mcp/resources.rs: resource reads must NOT read the mirror — TS serves state views + injects compute slices (Phase 3)"
        );
```

Also tidy the two now-stale parentheticals from Phase 2: in the `export.rs` comment (`:856-859`) drop "(mcp/tools.rs gets the same treatment in Phase 2 Task 3; resources.rs still reads the mirror until Phase 3.)" and in the `mcp/tools.rs` comment (`:872-875`) drop "(resources.rs still reads the mirror until Phase 3.)" — replace each trailing sentence with a period after the substantive clause. (Cosmetic; keep the asserts unchanged.)

- [ ] **Step 9: Full native suite (must be green before commit).** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud`
Expected: PASS, 0 failed. The four new `stateless_tests` pass; the relaxed guard passes (`resources.rs` has zero `snapshot_for_read`); no dead-code warnings from `snapshot_for_read` / `mirror_history_view`.

- [ ] **Step 10: Rebuild the napi addon (regenerate `index.d.ts`).** Close the app if running (the `.node` is file-locked). Run: `npm --prefix apps/desktop run napi:build`
Expected: build succeeds; `apps/desktop/native/index.d.ts` now shows `mcpReadResource(uri: string, stateJson?: string | undefined | null): Promise<string>`. Verify: `grep -n mcpReadResource apps/desktop/native/index.d.ts`.

- [ ] **Step 11: Commit.**

```bash
git add apps/desktop/native/src/mcp/resources.rs apps/desktop/native/src/napi_backend.rs
git commit -m "refactor(stateless): MCP resources take injected project/media; relax mirror guard for resources.rs"
```

---

## Task 2: Main — TS host serves the project views + injects the compute-resource slices

The host owns all state, so the `project://*` views are built in TS directly from the actor (zero Rust call), exactly like the existing `motifs://current` path. The three compute resources are forwarded to `backend.mcpReadResource(uri, injectionJson)` with the project (`compiled`) / MediaItem (`media://`) / nothing (`meter`) the Rust reader now expects. The inline `ReadResourceRequestSchema` body moves into an exported, testable `handleReadResource` (mirroring `handleCallTool`).

**Files:**
- Create: `apps/desktop/src/main/state/resource-views.ts`
- Create: `apps/desktop/src/main/state/__tests__/resource-views.test.ts`
- Create: `apps/desktop/src/main/mcp/server.resource.test.ts`
- Modify: `apps/desktop/src/main/mcp/server.ts:106-118` (extract `handleReadResource`, wire it in)

**Interfaces:**
- Consumes: `tsHost.actor` (`snapshot()` → `Project`; `historyView(100)` → `HistoryView`); `serializeProject` (serialize.ts); `unwrap` (server.ts, existing); `Backend.mcpReadResource(uri, stateJson?)` (Task 1 napi).
- Produces: `export function serveProjectResource(uri: string, actor: Pick<ActorHandle, 'snapshot' | 'historyView'>): ServerResult | null`
- Produces: `export function buildResourceInjection(uri: string, snapshot: Project): string`
- Produces: `export async function handleReadResource(backend: Backend, getTsHost: () => TsActorHost | null, uri: string): Promise<ServerResult>`

- [ ] **Step 1: Write the failing helper test.** Create `apps/desktop/src/main/state/__tests__/resource-views.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { serveProjectResource, buildResourceInjection } from '../resource-views'
import { createActor } from '../actor'
import { uuidV7Gen } from '../ids'
import { blankProject } from '../model'
import { mediaItemTemplate } from '../mutations/media'

function mkActor() {
  const idGen = uuidV7Gen()
  return createActor({ initial: blankProject(idGen, 'rv'), idGen, clock: () => '<TS>' })
}
function text(out: ReturnType<typeof serveProjectResource>): string {
  return (out as { contents: Array<{ text: string }> }).contents[0].text
}

describe('serveProjectResource', () => {
  it('serves project://current as a pretty JSON application/json block', () => {
    const actor = mkActor()
    const out = serveProjectResource('project://current', actor)!
    expect((out as { contents: Array<{ mimeType: string }> }).contents[0].mimeType).toBe('application/json')
    expect(JSON.parse(text(out)).project_id).toBe(actor.snapshot().project_id)
  })
  it('serves project://history with the {ops,cursor,len,checkpoints} shape', () => {
    const actor = mkActor()
    const body = JSON.parse(text(serveProjectResource('project://history', actor)))
    expect(Array.isArray(body.ops)).toBe(true)
    expect(body).toMatchObject({ cursor: expect.any(Number), len: expect.any(Number), checkpoints: expect.any(Array) })
  })
  it('serves composition / tracks from the snapshot', () => {
    const actor = mkActor()
    const snap = actor.snapshot()
    expect(JSON.parse(text(serveProjectResource('project://composition', actor)))).toEqual(JSON.parse(JSON.stringify(snap.composition)))
    expect(JSON.parse(text(serveProjectResource('project://tracks', actor)))).toHaveLength(snap.tracks.length)
  })
  it('serves a single layer for project://layers/{id}', () => {
    const actor = mkActor()
    const track = actor.snapshot().tracks[0].id
    const r = actor.mcpCall('add_color_layer', JSON.stringify({ track_id: track, color: { r: 0, g: 0, b: 0, a: 1 }, t_start_us: 0, t_end_us: 1_000_000 }))
    expect(r.ok).toBe(true)
    const layerId = actor.snapshot().tracks.flatMap((t) => t.layers)[0].id
    expect(JSON.parse(text(serveProjectResource(`project://layers/${layerId}`, actor))).id).toBe(layerId)
  })
  it('throws not-found for an absent layer id', () => {
    expect(() => serveProjectResource('project://layers/gone', mkActor())).toThrow(/not found/)
  })
  it('returns null for the Rust-compute resources', () => {
    const actor = mkActor()
    expect(serveProjectResource('project://compiled', actor)).toBeNull()
    expect(serveProjectResource('media://x/thumbnail', actor)).toBeNull()
    expect(serveProjectResource('composition://meter', actor)).toBeNull()
  })
})

describe('buildResourceInjection', () => {
  it('injects the full project for project://compiled', () => {
    const actor = mkActor()
    expect(JSON.parse(buildResourceInjection('project://compiled', actor.snapshot())).project.project_id)
      .toBe(actor.snapshot().project_id)
  })
  it('injects the resolved MediaItem for media://{id}/...', () => {
    const actor = mkActor()
    const snap = { ...actor.snapshot(), media_pool: { m1: mediaItemTemplate('m1', 'Video', 1_000_000) } } as never
    expect(JSON.parse(buildResourceInjection('media://m1/waveform', snap)).media.id).toBe('m1')
  })
  it('injects media:null when the id is absent', () => {
    const actor = mkActor()
    expect(JSON.parse(buildResourceInjection('media://gone/thumbnail', actor.snapshot())).media).toBeNull()
  })
  it('injects nothing for composition://meter', () => {
    const actor = mkActor()
    expect(buildResourceInjection('composition://meter', actor.snapshot())).toBe('{}')
  })
})
```

- [ ] **Step 2: Run it — verify it fails.** Run: `npm --prefix apps/desktop test -- resource-views`
Expected: FAIL — `../resource-views` does not exist.

- [ ] **Step 3: Write the helper.** Create `apps/desktop/src/main/state/resource-views.ts`:

```ts
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js'
import type { ActorHandle } from './actor'
import type { Layer, Project } from './model'
import { serializeProject } from './serialize'

const APP_JSON = 'application/json'
const PREFIX_LAYERS = 'project://layers/'
const PREFIX_MEDIA = 'media://'

/** Build a Rust-faithful text ResourceResult: one application/json content block
 *  whose `text` is the pretty-printed body (matches resources.rs `text_resource`). */
function textResource(uri: string, body: unknown): ServerResult {
  return { contents: [{ uri, mimeType: APP_JSON, text: JSON.stringify(body, null, 2) }] } as unknown as ServerResult
}

/** Throw the SDK-shaped not-found error (code -32601), mirroring Rust's
 *  `McpToolError::resource_not_found`. */
function resourceNotFound(message: string): never {
  const e = new Error(message) as Error & { code?: number }
  e.code = -32601
  throw e
}

/** Serve a `project://*` state-view resource directly from the actor (the sole
 *  state owner — Phase 3): returns the wire ResourceResult, or `null` when the URI
 *  is a Rust-compute resource (`project://compiled`, `media://*`,
 *  `composition://meter`) the host forwards to the backend with an injected slice.
 *  Throws not-found for a bad `project://layers/{id}` URI. */
export function serveProjectResource(
  uri: string,
  actor: Pick<ActorHandle, 'snapshot' | 'historyView'>,
): ServerResult | null {
  if (uri.startsWith(PREFIX_LAYERS)) {
    const tail = uri.slice(PREFIX_LAYERS.length)
    const slash = tail.indexOf('/')
    if (slash !== -1) resourceNotFound(`unsupported layer sub-resource '${tail.slice(slash + 1)}'`)
    const layer: Layer | undefined = actor.snapshot().tracks.flatMap((t) => t.layers).find((l) => l.id === tail)
    if (!layer) resourceNotFound(`layer ${tail} not found`)
    return textResource(uri, layer)
  }
  switch (uri) {
    case 'project://current': return textResource(uri, serializeProject(actor.snapshot()))
    case 'project://composition': return textResource(uri, actor.snapshot().composition)
    case 'project://media': return textResource(uri, actor.snapshot().media_pool)
    case 'project://tracks': return textResource(uri, actor.snapshot().tracks)
    case 'project://markers': return textResource(uri, actor.snapshot().markers)
    case 'project://history': return textResource(uri, actor.historyView(100))
    default: return null
  }
}

/** Build the injected-state JSON the backend's `mcpReadResource` needs for the
 *  resources that stay Rust compute (Phase 3): `project://compiled` gets the full
 *  project (audio mix plan); `media://*` gets the MediaItem resolved by id;
 *  `composition://meter` gets nothing. */
export function buildResourceInjection(uri: string, snapshot: Project): string {
  if (uri === 'project://compiled') return JSON.stringify({ project: serializeProject(snapshot) })
  if (uri.startsWith(PREFIX_MEDIA)) {
    const id = uri.slice(PREFIX_MEDIA.length).split('/')[0] ?? ''
    return JSON.stringify({ media: snapshot.media_pool[id] ?? null })
  }
  return '{}'
}
```

- [ ] **Step 4: Run the test.** Run: `npm --prefix apps/desktop test -- resource-views`
Expected: PASS.

- [ ] **Step 5: Write the failing server-integration test.** Create `apps/desktop/src/main/mcp/server.resource.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { handleReadResource } from './server'
import { createActor } from '../state/actor'
import { uuidV7Gen } from '../state/ids'
import { blankProject } from '../state/model'

function tsHostStub() {
  const idGen = uuidV7Gen()
  const actor = createActor({ initial: blankProject(idGen, 'res'), idGen, clock: () => '<TS>' })
  return { actor, motifTool: () => [] } as any
}
function fakeBackend(spy: (u: string, s?: string) => Promise<string>) {
  return { mcpReadResource: spy } as any
}
function contents(out: unknown) {
  return (out as { contents: Array<{ text: string; mimeType: string }> }).contents
}

describe('handleReadResource', () => {
  it('serves project://current from the actor without calling the backend', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async () => '{"ok":true,"result":{"contents":[]}}')
    const out = await handleReadResource(fakeBackend(spy), () => ts, 'project://current')
    expect(spy).not.toHaveBeenCalled()
    expect(contents(out)[0].mimeType).toBe('application/json')
    expect(JSON.parse(contents(out)[0].text).project_id).toBe(ts.actor.snapshot().project_id)
  })
  it('serves project://history from the actor (no backend call)', async () => {
    const ts = tsHostStub()
    const out = await handleReadResource(fakeBackend(async () => { throw new Error('no backend') }), () => ts, 'project://history')
    const body = JSON.parse(contents(out)[0].text)
    expect(Array.isArray(body.ops)).toBe(true)
  })
  it('forwards project://compiled to the backend with the injected project', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async () => '{"ok":true,"result":{"contents":[{"uri":"project://compiled","mimeType":"application/json","text":"{}"}]}}')
    await handleReadResource(fakeBackend(spy), () => ts, 'project://compiled')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toBe('project://compiled')
    expect(JSON.parse(spy.mock.calls[0][1] as string).project.project_id).toBe(ts.actor.snapshot().project_id)
  })
  it('forwards media://{id} with the resolved MediaItem (null when absent)', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async () => '{"ok":true,"result":{"contents":[]}}')
    await handleReadResource(fakeBackend(spy), () => ts, 'media://gone/thumbnail')
    const injected = JSON.parse(spy.mock.calls[0][1] as string)
    expect('media' in injected).toBe(true)
    expect(injected.media).toBeNull()
  })
  it('forwards composition://meter with no state injection', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async () => '{"ok":true,"result":{"contents":[]}}')
    await handleReadResource(fakeBackend(spy), () => ts, 'composition://meter')
    expect(spy.mock.calls[0][1]).toBe('{}')
  })
})
```

- [ ] **Step 6: Run it — verify it fails.** Run: `npm --prefix apps/desktop test -- server.resource`
Expected: FAIL — `handleReadResource` is not exported from `./server`.

- [ ] **Step 7: Extract `handleReadResource` and wire the views + injection.** In `apps/desktop/src/main/mcp/server.ts`, add the import near the other state imports (after the `CLIP_SLICE_TOOLS` import, `:15`):

```ts
import { serveProjectResource, buildResourceInjection } from '../state/resource-views.js'
```

Add the exported function just below `handleCallTool` (after `:91`):

```ts
/** ReadResource routing (tsHost present): project:// state views served in TS from
 *  the actor (sole state owner); the Rust-compute resources (project://compiled,
 *  media://*, composition://meter) forwarded to the backend with an injected slice.
 *  Stateless-compute Phase 3. */
export async function handleReadResource(
  backend: Backend,
  getTsHost: () => TsActorHost | null,
  uri: string,
): Promise<ServerResult> {
  const tsHost = getTsHost()
  if (tsHost) {
    if (uri === 'motifs://current') {
      const raw = tsHost.motifTool('list_motifs', {}) as Array<Record<string, unknown>>
      const list = raw.map((e) => { const { html: _html, ...rest } = e; return rest })
      return { contents: [{ uri: 'motifs://current', mimeType: 'application/json', text: JSON.stringify(list) }] } as unknown as ServerResult
    }
    const served = serveProjectResource(uri, tsHost.actor)
    if (served) return served
    // project://compiled / media://* / composition://meter stay Rust compute —
    // inject the project / MediaItem / nothing the stateless reader now needs.
    const injection = buildResourceInjection(uri, tsHost.actor.snapshot())
    return unwrap(await backend.mcpReadResource(uri, injection)) as ServerResult
  }
  return unwrap(await backend.mcpReadResource(uri)) as ServerResult
}
```

Then replace the inline `ReadResourceRequestSchema` handler (`:110-118`) with a delegation:

```ts
  server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
    handleReadResource(backend, getTsHost, req.params.uri),
  )
```

- [ ] **Step 8: Run the integration test.** Run: `npm --prefix apps/desktop test -- server.resource`
Expected: PASS.

- [ ] **Step 9: Typecheck + full TS suite.** Run: `npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test`
Expected: typecheck clean (the regenerated `index.d.ts` from Task 1 Step 10 has the 2-arg `mcpReadResource`); all tests pass. If typecheck reports `Expected 1 arguments, but got 2` on `mcpReadResource`, Task 1 Step 10's `napi:build` did not run / did not regenerate — re-run it before continuing.

- [ ] **Step 10: Commit.**

```bash
git add apps/desktop/src/main/mcp/server.ts apps/desktop/src/main/mcp/server.resource.test.ts apps/desktop/src/main/state/resource-views.ts apps/desktop/src/main/state/__tests__/resource-views.test.ts
git commit -m "refactor(stateless): TS MCP host serves project views + injects compute-resource slices"
```

---

## Task 3: Integration verification

**Files:** none (verification only).

- [ ] **Step 1: Native suite green.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud`
Expected: PASS, 0 failed.

- [ ] **Step 2: TS typecheck + suite green.** Run: `npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 3: Confirm `mcp/resources.rs` no longer touches the mirror.** Run: `rg "snapshot_for_read|mirror_history_view" apps/desktop/native/src/mcp/resources.rs`
Expected: no matches. (`napi_backend.rs` still defines both — deleted in Phase 5; `read_mirror_handle` still used by `media.rs` until Phase 4.)

- [ ] **Step 4: Manual smoke (optional, real app).** With the addon already rebuilt (Task 1 Step 10), launch the app and from an MCP client: (a) read `project://current` and `project://history` — confirm they return the live project / history (now TS-served, no Rust round-trip); (b) import a video and read `project://compiled` — confirm the audio mix plan returns (exercises the injected-project path); (c) read `media://{id}/thumbnail` once thumbnails are generated — confirm the JPEG blob returns (exercises the injected-MediaItem path); (d) read `composition://meter` while playing — confirm `live: true` (exercises the no-state path).

---

## Self-review notes (for the executor)

- Phase 3 leaves `read_mirror` / `set_project_mirror` / `snapshot_for_read` / `mirror_history_view` / the per-commit push in place — they are deleted wholesale in Phase 5. `snapshot_for_read` and `mirror_history_view` are now caller-less and carry `#[allow(dead_code)]`; do NOT delete them here (the per-commit `pushMirror` in `ts-actor-host.ts` still calls `setProjectMirror`, which still populates the mirror struct — harmless, removed in Phase 5).
- The advertised resource catalog (`static_resources()`) is unchanged: the agent-facing URI list is identical; only *who serves the read* changed. `ListResourcesRequestSchema` still merges `backend.mcpCatalog()` resources with the motif resources.
- Parity: `project://current` is `serializeProject(snapshot)` (the exact wire shape the mirror pushed — proven identical to Rust serialization by the existing differential / round-trip gates), pretty-printed; `project://history` is `actor.historyView(100)` (the exact value `pushMirror` mirrored as `historyViewJson`). Agents parse JSON, so the pretty-printer whitespace difference vs serde `to_string_pretty` is immaterial.
- `project://layers/{id}` divergence from Rust: the Rust reader rejected a malformed UUID with a distinct "invalid UUID" error; the TS reader treats any unmatched id (malformed or absent) as "layer {id} not found". Both are not-found (`-32601`); the precise wording differs. Acceptable — the agent gets a clear not-found either way.
- `media://*` and `project://compiled` stay in Rust because they need Rust-only compute (`jobs::extract_frame` + the cache for media binaries; `audio::mix::plan_for_project` for the mix plan). Re-implementing either in TS would create a cross-language twin — explicitly avoided. So they take an injected slice, the Phase 1/2 pattern applied to resources.
- The napi signature change (`state_json: Option<String>`) is the one place Phase 3 differs from Phases 1/2 mechanically: the resource entry point takes only a URI, so the slice cannot ride in existing JSON args. `Option<String>` keeps the flag-off `mcpReadResource(uri)` call (and the `server.flip.test.ts` `fakeBackend` stub) typechecking; the rebuild (Task 1 Step 10) must precede the Task 2 typecheck.
- Within this phase, the Rust change (Task 1) lands before the TS injection (Task 2): between commits, a resource read of `project://current` would hit the old TS code calling `backend.mcpReadResource('project://current')`, which the new Rust reader answers with a not-found — i.e. resource reads are briefly inconsistent between the two commits (same caveat as Phases 1/2; each task is green on its own suite, full integration verified in Task 3). The phase as a whole is independently mergeable.
- Next phases (own plan files): Phase 4 (import hash-first rework + delete `fresh_media_item` / `pending` / migrate + drop the `read_mirror_handle` on the jobs path), Phase 5 (delete the mirror + the per-commit push + the now-dead `snapshot_for_read` / `mirror_history_view`).
```
