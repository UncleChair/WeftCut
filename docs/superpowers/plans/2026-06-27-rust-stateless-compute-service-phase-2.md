# Rust stateless-compute-service — Phase 2: broad-state compute

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the two broad-state Rust compute readers so the Electron main process passes the state they need, instead of the Rust core reading it from the resident read-mirror: the audio-export channels (`export_project_audio_only`, `ensure_export_audio_conform`) take the full `Project`; the clip-audio MCP tools (`detect_silences`, `transcribe_clip`) take the resolved `{ layer, media }` slice.

**Architecture:** Spec `docs/superpowers/specs/2026-06-27-rust-stateless-compute-service-design.md`, Phase 2, building on Phase 1's pattern (the TS host injects state at the call boundary; Rust fns drop `snapshot_for_read`). Two transports:
- **Export** flows renderer → `index.ts` `backend:invoke` → Rust `dispatch`. The handler injects the wire-shape project (the same `serializeProject` the read-mirror uses) into the args for these two channels, exactly like Phase 1's single-media interception.
- **MCP** flows agent → `server.ts` `handleCallTool` → `backend.mcpCallTool` → Rust `dispatch_tool`. These two tools route `'rust'`; the host resolves the layer (by `layer_id`) + its `MediaItem` from the actor snapshot and merges them into the tool args. The injected fields are `#[serde(default)] #[schemars(skip)]`, so they deserialize but never appear in the advertised tool schema agents see.

The mirror, `snapshot_for_read`, and the per-commit mirror push all still exist after this phase — `mcp/resources.rs` (`project://current` / `project://history` / `media://`) still reads the mirror until Phase 3, and the mirror itself is deleted in Phase 5.

**Tech Stack:** Rust (napi-rs addon, `apps/desktop/native`), TypeScript (Electron main + MCP host, `apps/desktop/src/main`). Rust async via tokio; tests via `cargo test`. TS tests via vitest. MCP schemas via `schemars` 0.8.

## Global Constraints

- Native Rust build/test MUST pass `--features export,mcp,cloud` — the default (no-feature) build does not compile. (`export` and `cloud` both imply `jobs`.)
- The TS `Project` / `Layer` / `MediaItem` models are JSON-native: `serialize.ts`'s `serializeProject` is identity except for `groups` (sorted members, omitted null label), so `actor.snapshot().tracks[].layers[]` and `actor.snapshot().media_pool[id]` are already in Rust wire shape and forward verbatim into Rust serde. The full-project injection uses `serializeProject` so `groups` match the mirror exactly.
- Do not change the renderer (`src/renderer/ipc/index.ts` keeps sending `{ outputPath, audio, startUs, endUs }` / `{ startUs, endUs }`) and do not change the MCP tool schemas agents see (`detect_silences` advertises only `layer_id` / `threshold_amp` / `min_silence_us`; `transcribe_clip` only `layer_id` / `t_start_us` / `t_end_us` / `language`).
- Do not delete `read_mirror` / `set_project_mirror` / `snapshot_for_read` / `mirror_history_view` in this phase — `mcp/resources.rs` still uses them (Phase 3); the mirror is deleted in Phase 5. `ensure_export_audio_conform` still passes `backend.read_mirror_handle()` to `enqueue_conform` (the background job's `fresh_media_item` re-read); that handle is removed in Phase 4.
- Commit after each task. Stage by explicit path (other sessions edit this checkout concurrently).
- End every task green on `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud` and `npm --prefix apps/desktop run typecheck` + `npm --prefix apps/desktop test`.

---

## File Structure

- `apps/desktop/native/src/commands/mod.rs` — add a `project: Project` field to `ExportAudioOnlyArgs` and `ExportConformArgs`.
- `apps/desktop/native/src/commands/export.rs` — `export_project_audio_only` / `ensure_export_audio_conform` take `Project`; drop `snapshot_for_read`. (`export_project_audio_only` no longer needs `&Backend`.)
- `apps/desktop/native/src/mcp/tools.rs` — `DetectSilencesArgs` / `TranscribeClipArgs` gain skipped `layer` / `media` slice fields; `detect_silences`, `resolve_clip_audio_source`, `transcribe_clip_inner` read the injected slice instead of `snapshot_for_read`.
- `apps/desktop/native/src/mcp/catalog.rs` — add a schema-parity test (skipped fields are not advertised).
- `apps/desktop/native/src/napi_backend.rs` — the two export dispatch arms pass `a.project`; update `ensure_export_audio_conform_blank_is_empty` + `transcribe_clip_without_key_is_clean_error`; add a `detect_silences` slice test; relax the source-guard for `export.rs` (Task 1) and extend it to `mcp/tools.rs` (Task 3).
- `apps/desktop/src/main/state/export-project-forward.ts` (new) + `__tests__/export-project-forward.test.ts` (new) — the export channel set + project-injection helper.
- `apps/desktop/src/main/state/clip-slice-forward.ts` (new) + `__tests__/clip-slice-forward.test.ts` (new) — the clip-audio tool set + `{ layer, media }` slice resolver.
- `apps/desktop/src/main/index.ts` — inject the project for the export channels in `backend:invoke`.
- `apps/desktop/src/main/mcp/server.ts` — inject the slice for the clip-audio tools in `handleCallTool`.
- `apps/desktop/src/main/mcp/server.flip.test.ts` — add a slice-forwarding case.

---

## Task 1: Rust — export-audio channels take a `Project` (+ relax the mirror source-guard for `export.rs`)

`export_project_audio_only` and `ensure_export_audio_conform` are the only `snapshot_for_read` callers in `commands/export.rs`. Converting both removes the last `snapshot_for_read` from `export.rs`, so the whole-file source-guard `mirror_backed_reads_use_the_mirror_not_an_actor` must be relaxed in the **same commit** (Steps 6–8) — otherwise the full native suite goes red (same lesson as Phase 1 Task 2: the guard is whole-file, not splittable across commits).

`export_project_audio_only` used `backend` *only* for the snapshot, so it drops the `&Backend` param entirely (`export::export_audio_only` reads conform paths from `MediaItem.conform_path`, not the cache). `ensure_export_audio_conform` keeps `&Backend` — it still needs `backend.events` / `backend.cache` / `backend.read_mirror_handle()` for `enqueue_conform`.

**Files:**
- Modify: `apps/desktop/native/src/commands/mod.rs:44-70` (the two args structs)
- Modify: `apps/desktop/native/src/commands/export.rs:27-44` + `:101-124` (the two fns)
- Modify: `apps/desktop/native/src/napi_backend.rs:491-504` (dispatch arms), `:591-602` (the blank test), `:803-858` (the source-guard)

**Interfaces:**
- Produces: `pub async fn export_project_audio_only(project: Project, output_path: String, audio: AudioEncodeSpec, start_us: Option<i64>, end_us: Option<i64>) -> Result<bool, String>`
- Produces: `pub async fn ensure_export_audio_conform(backend: &Backend, project: Project, start_us: Option<i64>, end_us: Option<i64>) -> Result<Vec<String>, String>`
- Produces: `ExportAudioOnlyArgs.project` / `ExportConformArgs.project` (serde `project` field, full `crate::state::Project`).

- [ ] **Step 1: Update the blank-project export test to pass the project (failing).** In `apps/desktop/native/src/napi_backend.rs`, replace `ensure_export_audio_conform_blank_is_empty` (`:591-602`) with one that injects a blank project in the args and drops `push_blank_mirror`:

```rust
    /// Blank project has no audio layers, so the export-audio gate returns an
    /// empty waiting list with no ffmpeg involvement — proves the arm reads the
    /// project from the request (Phase 2), not the mirror.
    #[cfg(feature = "export")]
    #[tokio::test]
    async fn ensure_export_audio_conform_blank_is_empty() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        let p = crate::state::Project::new_blank("test");
        let args = serde_json::json!({ "project": p, "startUs": 0, "endUs": 1_000_000 }).to_string();
        let out = b
            .dispatch("ensure_export_audio_conform", &args)
            .await
            .unwrap();
        assert_eq!(out, "[]", "blank project has no audio layers to conform");
    }
```

- [ ] **Step 2: Run it — verify it fails.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud ensure_export_audio_conform_blank_is_empty`
Expected: FAIL — the arm still parses `ExportConformArgs` without `project` and calls `snapshot_for_read` (which errors "read-mirror not set", since no mirror is pushed).

- [ ] **Step 3: Add the `project` field to both args structs.** In `apps/desktop/native/src/commands/mod.rs`, add a `project` field to `ExportAudioOnlyArgs` (`:44-52`) and `ExportConformArgs` (`:64-70`):

```rust
#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportAudioOnlyArgs {
    /// Full project, injected by the TS host (sole state owner) — Phase 2.
    pub project: crate::state::Project,
    pub output_path: String,
    pub audio: crate::export::AudioEncodeSpec,
    pub start_us: Option<i64>,
    pub end_us: Option<i64>,
}
```

```rust
#[cfg(feature = "export")]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportConformArgs {
    /// Full project, injected by the TS host (sole state owner) — Phase 2.
    pub project: crate::state::Project,
    pub start_us: Option<i64>,
    pub end_us: Option<i64>,
}
```

Note: `#[serde(rename_all = "camelCase")]` renames only this struct's own fields (`start_us` → `startUs`); `project` stays `project`, and the nested `Project` deserializes by its own (snake_case) serde rules.

- [ ] **Step 4: Convert the two fns.** In `apps/desktop/native/src/commands/export.rs`, replace `export_project_audio_only` (`:27-44`) and `ensure_export_audio_conform` (`:101-124`):

```rust
/// Audio-only export → `output_path` (.m4a AAC / .mka Opus). The mix is Rust
/// (sample-accurate over conform PCM); ffmpeg is the encode tail. Emits no
/// events; the JS orchestrator drives the panel. The TS host passes the full
/// project (Phase 2) — export is user-triggered and infrequent, so a one-shot
/// full serialize is fine.
pub async fn export_project_audio_only(
    project: crate::state::Project,
    output_path: String,
    audio: AudioEncodeSpec,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<bool, String> {
    let path = PathBuf::from(output_path);
    let window = match (start_us, end_us) {
        (Some(s), Some(e)) => Some((s, e)),
        _ => None,
    };
    export::export_audio_only(&project, &path, &audio, window)
        .await
        .map_err(|e| format!("{e:#}"))
}
```

```rust
/// Export-readiness audio gate: media ids of audible in-window audio layers
/// whose conform cache is absent/invalid, each with a conform job kicked.
/// Selection mirrors the mix plan exactly (mute/solo/lock/window). The TS host
/// passes the full project (Phase 2).
pub async fn ensure_export_audio_conform(
    backend: &Backend,
    project: crate::state::Project,
    start_us: Option<i64>,
    end_us: Option<i64>,
) -> Result<Vec<String>, String> {
    let window = match (start_us, end_us) {
        (Some(s), Some(e)) => Some((s, e)),
        _ => None,
    };
    let waiting = crate::audio::mix::conform_waiting_media(&project, window);
    for id in &waiting {
        let Some(item) = project.media_pool.get(id).cloned() else {
            continue;
        };
        crate::jobs::enqueue_conform(
            backend.events.clone(),
            backend.cache.clone(),
            item,
            backend.read_mirror_handle(),
        );
    }
    Ok(waiting.iter().map(|u| u.to_string()).collect())
}
```

- [ ] **Step 5: Update the two dispatch arms.** In `apps/desktop/native/src/napi_backend.rs:491-504`:

```rust
            #[cfg(feature = "export")]
            "export_project_audio_only" => {
                let a: crate::commands::ExportAudioOnlyArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::export::export_project_audio_only(a.project, a.output_path, a.audio, a.start_us, a.end_us).await)
            }
```

```rust
            #[cfg(feature = "export")]
            "ensure_export_audio_conform" => {
                let a: crate::commands::ExportConformArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::export::ensure_export_audio_conform(self, a.project, a.start_us, a.end_us).await)
            }
```

- [ ] **Step 6: Relax the source-guard (same commit).** Converting both fns removed the last `snapshot_for_read` from `commands/export.rs`, so the whole-file assert in `mirror_backed_reads_use_the_mirror_not_an_actor` (`apps/desktop/native/src/napi_backend.rs:803-858`) now fails. First read the test to confirm its exact shape, then replace the positive `export.contains("snapshot_for_read")` assert (`:828-834`) with a whole-file negative + per-fn negatives, keeping the `.project()?.snapshot()` prohibition loop and the `media.rs` checks unchanged:

```rust
        // Phase 2 (stateless-compute-service): the export-audio channels no longer
        // read the mirror — the TS host passes the full project in the request.
        // (mcp/tools.rs gets the same treatment in Phase 2 Task 3; resources.rs
        // still reads the mirror until Phase 3.)
        assert!(
            !export.contains("snapshot_for_read"),
            "commands/export.rs: export channels must NOT read the mirror — they take a `project` arg (Phase 2)"
        );
        for name in ["export_project_audio_only", "ensure_export_audio_conform"] {
            let start = export.find(&format!("fn {name}"))
                .unwrap_or_else(|| panic!("{name} must exist in commands/export.rs"));
            let body = &export[start..(start + 600).min(export.len())];
            assert!(!body.contains("snapshot_for_read"),
                "{name}: must NOT read the mirror — it takes a `project` arg (Phase 2)");
        }
```

- [ ] **Step 7: Full native suite (must be green before commit).** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud`
Expected: PASS, 0 failed. The relaxed guard passes; `commands/export.rs` has zero `snapshot_for_read`.

- [ ] **Step 8: Commit.**

```bash
git add apps/desktop/native/src/commands/mod.rs apps/desktop/native/src/commands/export.rs apps/desktop/native/src/napi_backend.rs
git commit -m "refactor(stateless): export-audio channels take Project; relax mirror guard for export.rs"
```

---

## Task 2: Main — inject the full project for the export channels (renderer path)

The renderer keeps calling `invoke("export_project_audio_only", { outputPath, audio, startUs, endUs })` / `invoke("ensure_export_audio_conform", { startUs, endUs })`. These route `'rust'` (they are in `MIRROR_BACKED_READS`), so they fall through to `backend.invoke`. `index.ts`'s `backend:invoke` handler must inject the wire-shape project for these two channels before that fall-through, exactly like Phase 1's single-media interception.

**Files:**
- Create: `apps/desktop/src/main/state/export-project-forward.ts`
- Create: `apps/desktop/src/main/state/__tests__/export-project-forward.test.ts`
- Modify: `apps/desktop/src/main/index.ts:398-405` (after the single-media intercept, before the router split)

**Interfaces:**
- Consumes: `tsHost.actor.snapshot()` → `Project` (model.ts); `serializeProject` (serialize.ts).
- Produces: `export const EXPORT_PROJECT_CHANNELS: ReadonlySet<string>`
- Produces: `export function injectProjectArgs(args: Record<string, unknown>, snapshot: Project): Record<string, unknown>`

- [ ] **Step 1: Write the failing test.** Create `apps/desktop/src/main/state/__tests__/export-project-forward.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { injectProjectArgs, EXPORT_PROJECT_CHANNELS } from '../export-project-forward'
import { blankProject } from '../model'
import { uuidV7Gen } from '../ids'

describe('injectProjectArgs', () => {
  it('adds the wire-shape project and preserves existing args', () => {
    const p = blankProject(uuidV7Gen(), 'export-test')
    const out = injectProjectArgs({ outputPath: 'a.m4a', startUs: null, endUs: null }, p)
    expect(out.outputPath).toBe('a.m4a')
    expect(out.startUs).toBeNull()
    expect((out.project as { project_id: string }).project_id).toBe(p.project_id)
    expect((out.project as { schema_version: number }).schema_version).toBe(p.schema_version)
  })

  it('lists exactly the two audio-export channels', () => {
    expect([...EXPORT_PROJECT_CHANNELS].sort()).toEqual(
      ['ensure_export_audio_conform', 'export_project_audio_only'],
    )
  })
})
```

- [ ] **Step 2: Run it — verify it fails.** Run: `npm --prefix apps/desktop test -- export-project-forward`
Expected: FAIL — `../export-project-forward` does not exist.

- [ ] **Step 3: Write the helper.** Create `apps/desktop/src/main/state/export-project-forward.ts`:

```ts
import type { Project } from './model'
import { serializeProject } from './serialize'

/** Audio-export channels that used to read the Rust mirror for the full project
 *  and now receive it from the TS actor (the sole state owner). Phase 2. */
export const EXPORT_PROJECT_CHANNELS: ReadonlySet<string> = new Set([
  'export_project_audio_only', 'ensure_export_audio_conform',
])

/** Inject the wire-shape project into the export-channel args. Uses the SAME
 *  serialization as the read-mirror (`serializeProject` — identity except for
 *  group member sorting), so the Rust core deserializes an identical `Project`. */
export function injectProjectArgs(
  args: Record<string, unknown>,
  snapshot: Project,
): Record<string, unknown> {
  return { ...args, project: serializeProject(snapshot) }
}
```

- [ ] **Step 4: Run the test.** Run: `npm --prefix apps/desktop test -- export-project-forward`
Expected: PASS.

- [ ] **Step 5: Wire it into the handler.** In `apps/desktop/src/main/index.ts`, add the import near the other state imports:

```ts
import { EXPORT_PROJECT_CHANNELS, injectProjectArgs } from './state/export-project-forward.js'
```

Then in `ipcMain.handle('backend:invoke', ...)`, immediately AFTER the single-media block (`:398-405`) and BEFORE the `// TS actor splitter` comment (`:406`), add:

```ts
    // Audio export: the TS actor owns state, so inject the full project here and
    // forward it — the Rust fns no longer read the mirror (Phase 2).
    if (tsHost && EXPORT_PROJECT_CHANNELS.has(channel)) {
      const merged = injectProjectArgs((args ?? {}) as Record<string, unknown>, tsHost.actor.snapshot())
      const json = await backend!.invoke(channel, JSON.stringify(merged))
      return JSON.parse(json)
    }
```

- [ ] **Step 6: Typecheck + full TS suite.** Run: `npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 7: Commit.**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/main/state/export-project-forward.ts apps/desktop/src/main/state/__tests__/export-project-forward.test.ts
git commit -m "refactor(stateless): main injects project for export-audio channels"
```

---

## Task 3: Rust — `detect_silences` / `transcribe_clip` take the injected `{ layer, media }` slice (+ extend the source-guard to `mcp/tools.rs`)

Both tools resolve a layer (by `layer_id`) and its `MediaItem` from `snapshot_for_read`, then validate + compute. Phase 2 moves the lookup to the TS MCP host: the args gain `layer` / `media` fields the host injects. They are `#[serde(default)]` (so a direct Rust call with no injection deserializes them as `None`) and `#[schemars(skip)]` (so they never appear in the advertised tool schema — verified: schemars 0.8 maps `skip` to `skip_deserializing` for *schema generation only*, filtering the field out of the object schema with no `JsonSchema` bound required on `Layer` / `MediaItem`; the real serde `Deserialize` derive still deserializes them). All validation and error messages stay in Rust — a missing layer/media injects as `None` and the Rust fn produces the same structured error it does today.

`TranscribeClipArgs` also derives `Serialize` (it is logged); the injected fields get `#[serde(skip_serializing)]` too, so the (potentially large) slice never lands in the log details.

**Files:**
- Modify: `apps/desktop/native/src/mcp/tools.rs:91-101` (`DetectSilencesArgs`), `:109-189` (`detect_silences`), `:470-486` (`TranscribeClipArgs`), `:526-636` (`resolve_clip_audio_source`), `:726-771` (`transcribe_clip_inner`)
- Modify: `apps/desktop/native/src/napi_backend.rs:757-771` (`transcribe_clip_without_key_is_clean_error`) + add a `detect_silences` slice test; `:803-858` (extend the source-guard to `mcp/tools.rs`)
- Modify: `apps/desktop/native/src/mcp/catalog.rs` (add a schema-parity test)

**Interfaces:**
- Consumes: `crate::state::Layer`, `crate::state::MediaItem` (state mod).
- Produces: `DetectSilencesArgs.layer: Option<Layer>`, `DetectSilencesArgs.media: Option<MediaItem>` (skipped from schema, serde-default).
- Produces: `TranscribeClipArgs.layer` / `.media` (same, also `skip_serializing`).
- Produces: `fn resolve_clip_audio_source(layer: Option<&Layer>, media: Option<&MediaItem>, layer_id: LayerId, t_start_arg: Option<i64>, t_end_arg: Option<i64>) -> Result<ResolvedClipAudio, McpToolError>`

- [ ] **Step 1: Write the `detect_silences` slice test (failing).** In `apps/desktop/native/src/napi_backend.rs`, add next to `transcribe_clip_without_key_is_clean_error` (after `:771`):

```rust
    /// Phase 2: `detect_silences` resolves from the injected `layer` arg, NOT the
    /// mirror. With no mirror pushed and no injected layer, the new code reports
    /// "layer not found" (it read `args.layer == None`); the old mirror-backed
    /// code would report "read-mirror not set" instead.
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detect_silences_resolves_injected_layer_not_mirror() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let reply: serde_json::Value = serde_json::from_str(
            &b.mcp_call_tool(
                "detect_silences".into(),
                r#"{"layer_id":"00000000-0000-0000-0000-000000000000"}"#.into(),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(reply["ok"], false);
        let msg = reply["error"]["message"].as_str().unwrap_or("");
        assert!(
            msg.contains("not found") && !msg.contains("read-mirror"),
            "detect_silences must resolve from the injected layer, not the mirror; got: {msg}"
        );
    }
```

- [ ] **Step 2: Update `transcribe_clip_without_key_is_clean_error` to drop the mirror push (failing).** In the same file (`:757-771`), remove the `push_blank_mirror(&b);` line and tighten the assertion so it exercises the injected-slice path:

```rust
    #[cfg(feature = "cloud")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transcribe_clip_without_key_is_clean_error() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        // No mirror, no injected layer → "layer not found" (resolves from
        // args.layer == None, Phase 2). Old mirror-backed code: "read-mirror not set".
        let reply: serde_json::Value = serde_json::from_str(
            &b.mcp_call_tool("transcribe_clip".into(), r#"{"layer_id":"00000000-0000-0000-0000-000000000000"}"#.into())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(reply["ok"], false);
        let msg = reply["error"]["message"].as_str().unwrap_or("");
        assert!(
            msg.contains("not found") && !msg.contains("read-mirror"),
            "transcribe_clip must resolve from the injected layer, not the mirror; got: {msg}"
        );
    }
```

- [ ] **Step 3: Run both — verify they fail.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud detect_silences_resolves_injected_layer_not_mirror transcribe_clip_without_key_is_clean_error`
Expected: FAIL — the fns still call `snapshot_for_read`, so with no mirror pushed the message is "read-mirror not set …" (does not contain "not found"; contains "read-mirror").

- [ ] **Step 4: Add the skipped slice fields to both args structs.** In `apps/desktop/native/src/mcp/tools.rs`, extend `DetectSilencesArgs` (`:91-101`):

```rust
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct DetectSilencesArgs {
    /// Target VideoClip or Audio layer id.
    pub layer_id: String,
    /// Peak amplitude threshold in [0.0, 1.0]. Anything strictly below this
    /// counts as silence. Default 0.02 (≈ -34 dBFS).
    pub threshold_amp: Option<f32>,
    /// Minimum contiguous silence duration (microseconds) to surface.
    /// Default 500000 (0.5 seconds).
    pub min_silence_us: Option<i64>,
    /// Injected by the TS MCP host (sole state owner) — the layer resolved by
    /// `layer_id` and its `MediaItem`. `#[schemars(skip)]` keeps them OUT of the
    /// advertised tool schema; serde still deserializes them. `None` on a direct
    /// Rust call → the handler produces the same not-found error (Phase 2).
    #[serde(default)]
    #[schemars(skip)]
    pub layer: Option<crate::state::Layer>,
    #[serde(default)]
    #[schemars(skip)]
    pub media: Option<crate::state::MediaItem>,
}
```

And `TranscribeClipArgs` (`:470-486`) — note the extra `skip_serializing` so the slice never lands in the log details:

```rust
#[cfg(feature = "cloud")]
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub(super) struct TranscribeClipArgs {
    /// Target VideoClip or Audio layer id.
    pub layer_id: String,
    /// Optional transcription window start in timeline microseconds.
    /// Defaults to the layer's `t_start_us`. Must lie within the layer.
    #[serde(default)]
    pub t_start_us: Option<i64>,
    /// Optional transcription window end in timeline microseconds.
    /// Defaults to the layer's `t_end_us`. Must lie within the layer.
    #[serde(default)]
    pub t_end_us: Option<i64>,
    /// Optional ISO-639-1 language hint (`"en"`, `"zh"`). Auto-detect when omitted.
    #[serde(default)]
    pub language: Option<String>,
    /// Injected by the TS MCP host (sole state owner) — see DetectSilencesArgs.
    /// `skip_serializing` keeps the slice out of the tool's log details (Phase 2).
    #[serde(default, skip_serializing)]
    #[schemars(skip)]
    pub layer: Option<crate::state::Layer>,
    #[serde(default, skip_serializing)]
    #[schemars(skip)]
    pub media: Option<crate::state::MediaItem>,
}
```

- [ ] **Step 5: Convert `detect_silences` to read the injected slice.** In `apps/desktop/native/src/mcp/tools.rs`, replace the lookup block at the top of `detect_silences` (`:114-142` — from `let snap = b.snapshot_for_read().await?;` through the `let media = snap.media_pool.get(...)?;` block) with reads of `args.layer` / `args.media`. The rest of the fn (threshold/min validation, `read_peaks_file`, the `src_in_us`/`src_out_us` match, `detect_silences_in_peaks`) is UNCHANGED — it already operates on a `&Layer` named `layer` and a `&MediaItem` named `media`:

```rust
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let layer = args.layer.as_ref().ok_or_else(|| {
        McpToolError::invalid_params(format!("layer {layer_id} not found"), None)
    })?;

    let media_id = match &layer.params {
        LayerParams::VideoClip(p) => p.media,
        LayerParams::Audio(p) => p.media,
        _ => {
            return Err(McpToolError::invalid_params(
                format!(
                    "layer {layer_id} kind is not analyzable for silence — pass a VideoClip or Audio layer",
                ),
                None,
            ));
        }
    };
    let media = args.media.as_ref().ok_or_else(|| {
        McpToolError::invalid_params(
            format!("layer {layer_id} references missing media {media_id}"),
            None,
        )
    })?;
    let waveform_path = b.cache.waveform(&media.file_hash_blake3);
```

(Leave everything from `if !cached_ok(&waveform_path) {` onward untouched.)

- [ ] **Step 6: Convert `resolve_clip_audio_source` to take the slice.** In `apps/desktop/native/src/mcp/tools.rs:526-545`, change the signature and the two lookups; the validation/computation tail (speed check, window bounds, source coordinate math, the returned `ResolvedClipAudio`) is UNCHANGED:

```rust
#[cfg(feature = "cloud")]
fn resolve_clip_audio_source(
    layer: Option<&crate::state::Layer>,
    media: Option<&crate::state::MediaItem>,
    layer_id: LayerId,
    t_start_arg: Option<i64>,
    t_end_arg: Option<i64>,
) -> Result<ResolvedClipAudio, McpToolError> {
    use crate::state::{AudioParams, VideoClipParams};

    let layer = layer.ok_or_else(|| {
        McpToolError::invalid_params(format!("layer {layer_id} not found"), None)
    })?;
```

Then replace the media lookup (`:579-586`, `let media = snap.media_pool.get(&media_id)...`) with:

```rust
    let media = media.ok_or_else(|| {
        McpToolError::invalid_params(
            format!(
                "layer {layer_id} references missing media {media_id} (project state is inconsistent)",
            ),
            None,
        )
    })?;
```

(The `let (media_id, src_in_us, src_out_us) = match &layer.params { ... }` block between them and everything after the media lookup are unchanged.)

- [ ] **Step 7: Update `transcribe_clip_inner` to pass the slice.** In `apps/desktop/native/src/mcp/tools.rs:726-738`, drop the snapshot and pass the injected slice:

```rust
#[cfg(feature = "cloud")]
async fn transcribe_clip_inner(
    b: &Backend,
    args: TranscribeClipArgs,
) -> Result<ToolResult, McpToolError> {
    let layer_id = parse_uuid(&args.layer_id, "layer_id")?;
    let resolved = resolve_clip_audio_source(
        args.layer.as_ref(),
        args.media.as_ref(),
        layer_id,
        args.t_start_us,
        args.t_end_us,
    )?;
```

(The transcriber pick, audio extract, transcribe, and SRT shift below are unchanged. `b` is still used for `cloud_keys` / `cache` / `log_slot`.)

- [ ] **Step 8: Run the two TDD tests — verify they pass.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud detect_silences_resolves_injected_layer_not_mirror transcribe_clip_without_key_is_clean_error`
Expected: PASS (both).

- [ ] **Step 9: Add the schema-parity test.** In `apps/desktop/native/src/mcp/catalog.rs`, inside `mod tests`, add:

```rust
    /// Phase 2 (stateless-compute-service): detect_silences / transcribe_clip gain
    /// serde-deserialized `layer` / `media` slice fields the TS host injects.
    /// `#[schemars(skip)]` MUST keep them out of the advertised tool schema so
    /// agents never see (or try to fill) them.
    #[cfg(all(feature = "jobs", feature = "cloud"))]
    #[test]
    fn injected_slice_fields_are_not_advertised() {
        let cat = catalog();
        for name in ["detect_silences", "transcribe_clip"] {
            let tool = cat.tools.iter().find(|t| t.name == name)
                .unwrap_or_else(|| panic!("{name} must be advertised"));
            if let Some(props) = tool.input_schema.get("properties").and_then(|p| p.as_object()) {
                assert!(!props.contains_key("layer"), "{name}: `layer` must not be advertised (schemars skip)");
                assert!(!props.contains_key("media"), "{name}: `media` must not be advertised (schemars skip)");
            }
        }
    }
```

- [ ] **Step 10: Extend the source-guard to `mcp/tools.rs`.** In `apps/desktop/native/src/napi_backend.rs`, in `mirror_backed_reads_use_the_mirror_not_an_actor` (`:803-858`): add a read of `mcp/tools.rs`, include it in the `.project()?.snapshot()` prohibition loop, and assert it no longer reads the mirror. After the `let export = std::fs::read_to_string(...)` line (`:813-814`), add:

```rust
        let tools = std::fs::read_to_string(format!("{root}/src/mcp/tools.rs"))
            .expect("mcp/tools.rs must be readable");
```

Add `("mcp/tools.rs", &tools),` to the array in the `.project()?.snapshot()` loop (`:817-820`). Then, after the `export.rs` per-fn negatives added in Task 1, add:

```rust
        // Phase 2 (stateless-compute-service): detect_silences / transcribe_clip
        // no longer read the mirror — the TS MCP host passes the { layer, media }
        // slice resolve_clip_audio_source needs. (resources.rs still reads the
        // mirror until Phase 3.)
        assert!(
            !tools.contains("snapshot_for_read"),
            "mcp/tools.rs: clip-audio compute tools must NOT read the mirror — they take an injected slice (Phase 2)"
        );
```

- [ ] **Step 11: Full native suite (must be green before commit).** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud`
Expected: PASS, 0 failed. (If `#[schemars(skip)]` fails to compile — e.g. a `JsonSchema` bound is demanded on `Layer`/`MediaItem` — STOP: the fallback is to special-case these two tools' dispatch with a private `*WithSlice` deserialize struct so the catalog macro keeps the clean public type for the schema. This is not expected; the schemars 0.8.22 source confirms skipped fields are filtered before any `subschema_for` call.)

- [ ] **Step 12: Commit.**

```bash
git add apps/desktop/native/src/mcp/tools.rs apps/desktop/native/src/mcp/catalog.rs apps/desktop/native/src/napi_backend.rs
git commit -m "refactor(stateless): detect_silences/transcribe_clip take injected layer+media slice"
```

---

## Task 4: MCP host — inject the layer+media slice for the clip-audio tools

`detect_silences` / `transcribe_clip` route `'rust'` (unchanged — `routeMcpTool` still returns `'rust'`, asserted by `mcpRouter.test.ts`). `handleCallTool` must, for these two, resolve `{ layer, media }` from the actor snapshot and merge it into the args before the `backend.mcpCallTool` call. The Rust handler produces the not-found / not-analyzable errors when the slice is `null`, so the host does a best-effort lookup and never throws.

**Files:**
- Create: `apps/desktop/src/main/state/clip-slice-forward.ts`
- Create: `apps/desktop/src/main/state/__tests__/clip-slice-forward.test.ts`
- Modify: `apps/desktop/src/main/mcp/server.ts:45-83` (the `handleCallTool` `tsHost` branch)
- Modify: `apps/desktop/src/main/mcp/server.flip.test.ts` (add a slice-forwarding case)

**Interfaces:**
- Consumes: `tsHost.actor.snapshot()` → `Project` (model.ts); `unwrap` (server.ts, existing).
- Produces: `export const CLIP_SLICE_TOOLS: ReadonlySet<string>`
- Produces: `export function resolveClipSliceArgs(args: Record<string, unknown>, snapshot: Pick<Project, 'tracks' | 'media_pool'>): Record<string, unknown>`

- [ ] **Step 1: Write the failing helper test.** Create `apps/desktop/src/main/state/__tests__/clip-slice-forward.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveClipSliceArgs, CLIP_SLICE_TOOLS } from '../clip-slice-forward'

const media = { id: 'm1', file_hash_blake3: 'h' } as never
const vclip = { id: 'L1', params: { kind: 'VideoClip', media: 'm1' } } as never
const text = { id: 'L2', params: { kind: 'Text', content: 'hi' } } as never
const snap = { tracks: [{ layers: [vclip, text] }], media_pool: { m1: media } } as never

describe('resolveClipSliceArgs', () => {
  it('injects the layer and its MediaItem for an AV layer, preserving args', () => {
    const out = resolveClipSliceArgs({ layer_id: 'L1', threshold_amp: 0.02 }, snap)
    expect(out.layer).toBe(vclip)
    expect(out.media).toBe(media)
    expect(out.threshold_amp).toBe(0.02)
  })
  it('null layer + null media when the layer id is absent', () => {
    expect(resolveClipSliceArgs({ layer_id: 'gone' }, snap)).toMatchObject({ layer: null, media: null })
  })
  it('null media for a non-AV layer (Rust produces the not-analyzable error)', () => {
    const out = resolveClipSliceArgs({ layer_id: 'L2' }, snap)
    expect(out.layer).toBe(text)
    expect(out.media).toBeNull()
  })
  it('lists exactly the two clip-audio tools', () => {
    expect([...CLIP_SLICE_TOOLS].sort()).toEqual(['detect_silences', 'transcribe_clip'])
  })
})
```

- [ ] **Step 2: Run it — verify it fails.** Run: `npm --prefix apps/desktop test -- clip-slice-forward`
Expected: FAIL — `../clip-slice-forward` does not exist.

- [ ] **Step 3: Write the helper.** Create `apps/desktop/src/main/state/clip-slice-forward.ts`:

```ts
import type { Layer, MediaItem, Project } from './model'

/** MCP clip-audio compute tools that used to read the Rust mirror for one layer
 *  + its MediaItem (the `resolve_clip_audio_source` inputs) and now receive that
 *  slice from the TS actor (the sole state owner). Phase 2. */
export const CLIP_SLICE_TOOLS: ReadonlySet<string> = new Set([
  'detect_silences', 'transcribe_clip',
])

/** Resolve the `{ layer, media }` slice for a clip-audio MCP tool from the actor
 *  snapshot and merge it into the tool args. The layer is found by `layer_id`;
 *  its MediaItem comes from the layer's params (VideoClip / Audio carry a `media`
 *  id). Missing layer/media → `null`; the Rust handler then produces the
 *  structured not-found / not-analyzable error (single source of truth). */
export function resolveClipSliceArgs(
  args: Record<string, unknown>,
  snapshot: Pick<Project, 'tracks' | 'media_pool'>,
): Record<string, unknown> {
  const layerId = (args as { layer_id?: string }).layer_id ?? ''
  const layer: Layer | null =
    snapshot.tracks.flatMap((t) => t.layers).find((l) => l.id === layerId) ?? null
  const mediaId =
    layer && (layer.params.kind === 'VideoClip' || layer.params.kind === 'Audio')
      ? layer.params.media
      : null
  const media: MediaItem | null = mediaId ? snapshot.media_pool[mediaId] ?? null : null
  return { ...args, layer, media }
}
```

- [ ] **Step 4: Run the test.** Run: `npm --prefix apps/desktop test -- clip-slice-forward`
Expected: PASS.

- [ ] **Step 5: Write the failing server-integration test.** In `apps/desktop/src/main/mcp/server.flip.test.ts`, add a case inside the `describe('handleCallTool flip routing', ...)` block:

```ts
  it('resolves the { layer, media } slice for a clip-audio tool and forwards it to the backend', async () => {
    const ts = tsHostStub()
    const spy = vi.fn(async () => '{"ok":true,"result":{"content":[{"type":"text","text":"[]"}]}}')
    await handleCallTool(fakeBackend(spy), () => ts, 'detect_silences', { layer_id: 'gone' })
    expect(spy).toHaveBeenCalledTimes(1)
    const merged = JSON.parse(spy.mock.calls[0][1] as string)
    // The slice was resolved + merged (the intercept ran); 'gone' is not in the
    // blank project, so both are null — Rust then produces "layer not found".
    expect('layer' in merged).toBe(true)
    expect('media' in merged).toBe(true)
    expect(merged.layer).toBeNull()
    expect(merged.media).toBeNull()
    expect(merged.layer_id).toBe('gone')
  })
```

- [ ] **Step 6: Run it — verify it fails.** Run: `npm --prefix apps/desktop test -- server.flip`
Expected: FAIL — without the intercept, `detect_silences` falls straight through and the backend is called with `JSON.stringify({ layer_id: 'gone' })` (no `layer` / `media` keys).

- [ ] **Step 7: Wire the intercept into `handleCallTool`.** In `apps/desktop/src/main/mcp/server.ts`, add the import:

```ts
import { CLIP_SLICE_TOOLS, resolveClipSliceArgs } from '../state/clip-slice-forward.js'
```

Then inside the `if (tsHost) { ... }` block, replace the trailing `// route === 'rust' → fall through (reads are mirror-backed).` comment (`:71`) with the clip-audio intercept:

```ts
    // Clip-audio compute (detect_silences / transcribe_clip) routes to 'rust', but
    // the Rust core no longer holds state (stateless-compute Phase 2): resolve the
    // { layer, media } slice from the actor (sole state owner) and forward it.
    if (CLIP_SLICE_TOOLS.has(name)) {
      const merged = resolveClipSliceArgs(args, tsHost.actor.snapshot())
      return unwrap(await backend.mcpCallTool(name, JSON.stringify(merged))) as ServerResult
    }
    // route === 'rust' → fall through (other reads are served by the backend).
```

- [ ] **Step 8: Typecheck + full TS suite.** Run: `npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test`
Expected: typecheck clean; all tests pass (incl. `mcpRouter.test.ts` — `routeMcpTool` is unchanged, so `detect_silences` / `transcribe_clip` still assert `'rust'`).

- [ ] **Step 9: Commit.**

```bash
git add apps/desktop/src/main/mcp/server.ts apps/desktop/src/main/mcp/server.flip.test.ts apps/desktop/src/main/state/clip-slice-forward.ts apps/desktop/src/main/state/__tests__/clip-slice-forward.test.ts
git commit -m "refactor(stateless): MCP host injects layer+media slice for clip-audio tools"
```

---

## Task 5: Integration verification

**Files:** none (verification only).

- [ ] **Step 1: Native suite green.** Run: `cargo test --manifest-path apps/desktop/native/Cargo.toml --features export,mcp,cloud`
Expected: PASS, 0 failed.

- [ ] **Step 2: TS typecheck + suite green.** Run: `npm --prefix apps/desktop run typecheck && npm --prefix apps/desktop test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 3: Confirm the converted readers no longer touch the mirror.** Run: `rg "snapshot_for_read" apps/desktop/native/src/commands/export.rs apps/desktop/native/src/mcp/tools.rs`
Expected: no matches in either file. (`mcp/resources.rs` still matches — that is Phase 3.)

- [ ] **Step 4: Manual smoke (optional, real app).** Build the addon (`npm --prefix apps/desktop run napi:build` — close the app first; the running `.node` is locked) and launch. Import a video with audio, then: (a) run an audio-only export and confirm it produces a file (exercises `export_project_audio_only` + `ensure_export_audio_conform` through the new project-injection path); (b) from an MCP client, call `detect_silences` and `transcribe_clip` on a clip layer and confirm they return regions / SRT (exercises the slice-injection path through `server.ts`).

---

## Self-review notes (for the executor)

- Phase 2 leaves `read_mirror` / `set_project_mirror` / `snapshot_for_read` / `mirror_history_view` in place — `mcp/resources.rs` (Phase 3) still reads them, and the mirror push is removed in Phase 5. Do NOT delete them here.
- `ensure_export_audio_conform` still passes `backend.read_mirror_handle()` to `enqueue_conform`; that handle (the background job's `fresh_media_item` re-read) is removed in Phase 4 (it needs the hash-first guarantee).
- `export_project_audio_only` drops `&Backend` because it used it only for the snapshot (`export::export_audio_only` reads conform paths from `MediaItem.conform_path`, confirmed at `export/mod.rs:58`). `ensure_export_audio_conform` keeps `&Backend` (events/cache/read_mirror_handle for `enqueue_conform`).
- The injected `project` for export uses `serializeProject(snapshot)` (NOT the raw snapshot) so `groups` match the mirror's wire shape; layers / `media_pool` are identity, so the clip-slice helper reads them straight off `actor.snapshot()`.
- `#[schemars(skip)]` is verified against `schemars_derive-0.8.22`: `skip` maps to `skip_serializing` + `skip_deserializing` in the *schema* view, and the object-property generator filters `skip_deserializing` fields, so no `JsonSchema` bound is required on the skipped field types. The real serde `Deserialize` derive (a separate proc-macro) ignores `#[schemars(...)]` and still deserializes them. If this somehow fails to compile, see Task 3 Step 11's fallback.
- `routeMcpTool` is intentionally NOT changed — the slice intercept lives in `handleCallTool` after the route check, so `mcpRouter.test.ts` (`detect_silences` / `transcribe_clip` → `'rust'`) stays green.
- Within this phase, the Rust signature change (Tasks 1, 3) lands before the TS injection (Tasks 2, 4), so runtime export / MCP is briefly inconsistent between commits — same as Phase 1 (Rust-first, then main). Each task is green on its own suite; full integration is verified in Task 5. The phase as a whole is independently mergeable.
- Next phases (own plan files): Phase 3 (MCP resources `project://current` / `project://history` / `media://` served by the TS host), Phase 4 (import hash-first rework + delete `fresh_media_item` / `pending` / migrate), Phase 5 (delete the mirror + the per-commit push).
```
