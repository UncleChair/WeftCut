//! `Backend` — the napi entry point. Holds the TS-fed read-mirror + managed
//! stores, exposes a single `invoke` dispatcher and an `init` that warms up the
//! motif watcher + ffmpeg. The TS state actor is the sole project writer; this
//! boundary owns no actor (Phase 4b).

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde::Serialize;

use chrono::Utc;

use crate::agent_session::AgentSessionSlot;
use crate::app_settings::AppSettingsStore;
use crate::cache::CacheLayout;
use crate::events::{EventSink, TsfnEventSink};
use crate::keybindings::KeybindingsStore;
use crate::logs::{self, LogBusSlot};
use crate::recents::RecentsStore;
use crate::workspace::WorkspaceSlot;

/// A TS-fed read-replica of the project: the TS state actor is the sole writer,
/// so the Rust read paths (resources, detect_silences, transcribe_clip, the
/// Phase-3d-e compute hybrids) serve fresh state from this mirror. Set only from
/// TS via `set_project_mirror`; never mutated by Rust handlers. The TS host
/// pushes the initial mirror at boot before any read can run (bring-up order).
pub(crate) struct ReadMirror {
    pub(crate) project: std::sync::Arc<crate::state::Project>,
    pub(crate) history_view: serde_json::Value,
}

#[napi]
pub struct Backend {
    pub(crate) events: Arc<dyn EventSink>,
    pub(crate) recents: RecentsStore,
    pub(crate) keybindings: KeybindingsStore,
    pub(crate) app_settings: AppSettingsStore,
    pub(crate) cache: CacheLayout,
    #[cfg(feature = "jobs")]
    pub(crate) import_queue: crate::jobs::import::ImportQueue,
    #[cfg(feature = "jobs")]
    pub(crate) audio_meter: crate::commands::media::AudioMeterState,
    #[cfg(feature = "export")]
    pub(crate) video_sink: crate::export::videosink::VideoSinkState,
    #[cfg(feature = "export")]
    pub(crate) hw_encoder: crate::export::HwEncoderCache,
    pub(crate) workspace: WorkspaceSlot,
    pub(crate) agent_session: AgentSessionSlot,
    pub(crate) log_slot: LogBusSlot,
    pub(crate) config_dir: String,
    pub(crate) cache_dir: String,
    /// Plaintext cloud-provider API keys, keyed by provider tag ("openai").
    /// Pushed in by Electron main (decrypted from safeStorage) via
    /// `set_cloud_key`; read synchronously by the cloud reqwest providers.
    /// Always compiled (cache is feature-independent) so main can push keys
    /// regardless of the addon's feature set.
    pub(crate) cloud_keys: std::sync::Mutex<std::collections::HashMap<String, String>>,
    /// See ReadMirror. Behind an Arc<Mutex> so background jobs can hold a
    /// handle to the same mirror without borrowing the Backend across await.
    read_mirror: std::sync::Arc<std::sync::Mutex<Option<ReadMirror>>>,
    #[cfg(feature = "motifs")]
    pub(crate) motif_store: crate::motifs::store::UserMotifStore,
    #[cfg(feature = "motifs")]
    pub(crate) motif_watcher: OnceLock<crate::motifs::watcher::MotifWatcher>,
}

/// Build the config-dir-rooted stores + cache layout + log slot, install the
/// tracing→LogBus bridge once, and assemble a `Backend`. Shared by the napi
/// `new` constructor and the `new_for_test` helper so both run identical setup.
fn build_backend(events: Arc<dyn EventSink>, config_dir: String, cache_dir: String) -> Backend {
    let config_path = PathBuf::from(&config_dir);
    if let Err(e) = std::fs::create_dir_all(&config_path) {
        tracing::warn!("app config dir setup failed: {e:#} ({})", config_path.display());
    }
    let cache = CacheLayout::new(PathBuf::from(&cache_dir));
    if let Err(e) = cache.ensure_dirs() {
        tracing::warn!("cache dir setup failed: {e:#}");
    }
    let log_slot = LogBusSlot::new();
    // The TS read-mirror is the sole project source; the import queue reads it
    // to rewrite `pending-` derivative paths, so share the one Arc.
    let read_mirror: std::sync::Arc<std::sync::Mutex<Option<ReadMirror>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    #[cfg(feature = "jobs")]
    let import_queue =
        crate::jobs::import::ImportQueue::new(events.clone(), log_slot.clone(), read_mirror.clone());
    #[cfg(feature = "motifs")]
    let motif_store = crate::motifs::store::UserMotifStore::new(config_path.clone().join("motifs"));

    // Forward our crate's `tracing` events into whichever LogBus is current.
    // `try_init` (vs `init`) so constructing multiple Backends — e.g. in the
    // test suite — never panics on a double global-subscriber install.
    use tracing_subscriber::{prelude::*, EnvFilter};
    let _ = tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,weftcut=debug,weftcut_lib=debug")),
        )
        .with(tracing_subscriber::fmt::layer())
        .with(logs::LogBusLayer::new(log_slot.clone()))
        .try_init();

    Backend {
        events,
        recents: RecentsStore::new(config_path.clone()),
        keybindings: KeybindingsStore::new(config_path.clone()),
        app_settings: AppSettingsStore::new(config_path),
        cache,
        #[cfg(feature = "jobs")]
        import_queue,
        #[cfg(feature = "jobs")]
        audio_meter: crate::commands::media::AudioMeterState::default(),
        #[cfg(feature = "export")]
        video_sink: crate::export::videosink::VideoSinkState::default(),
        #[cfg(feature = "export")]
        hw_encoder: crate::export::HwEncoderCache::default(),
        workspace: WorkspaceSlot::new(),
        agent_session: AgentSessionSlot::new(),
        log_slot,
        config_dir,
        cache_dir,
        cloud_keys: std::sync::Mutex::new(std::collections::HashMap::new()),
        read_mirror,
        #[cfg(feature = "motifs")]
        motif_store,
        #[cfg(feature = "motifs")]
        motif_watcher: OnceLock::new(),
    }
}

#[napi]
impl Backend {
    #[napi(constructor)]
    pub fn new(app_config_dir: String, app_cache_dir: String, on_event: ThreadsafeFunction<String>) -> Self {
        let events: Arc<dyn EventSink> = Arc::new(TsfnEventSink::new(on_event));
        build_backend(events, app_config_dir, app_cache_dir)
    }

    /// Warm up the motif watcher + ffmpeg sidecar. Must be awaited once before
    /// any `invoke`. The project itself lives in the TS state actor (the sole
    /// writer); the `project:changed` UI bridge + autosave moved to the TS host
    /// in Phase 4b, so this no longer spawns a Rust actor.
    /// Runs inside napi's tokio runtime, so `tokio::spawn` has a runtime.
    #[napi]
    pub async fn init(&self) -> napi::Result<()> {
        // S5: watch <config_dir>/motifs/ so external edits + agent writes resync
        // the renderer catalog (motifs:changed → syncCatalog → ?v= host buster).
        #[cfg(feature = "motifs")]
        {
            let events = self.events.clone();
            let root = std::path::PathBuf::from(&self.config_dir).join("motifs");
            match crate::motifs::watcher::spawn(root, move || {
                events.emit("motifs:changed", serde_json::json!({}));
            }) {
                Ok(w) => { let _ = self.motif_watcher.set(w); }
                Err(e) => tracing::warn!("motif watcher failed to start: {e:#}"),
            }
        }

        // S3: warm up ffmpeg-sidecar (resolve / auto-download the binary) off
        // the init path so the first media job doesn't pay the download.
        #[cfg(any(feature = "jobs", feature = "export"))]
        tokio::spawn(async {
            match crate::ffmpeg::bootstrap().await {
                Ok(crate::ffmpeg::BootstrapStatus::Ready(v)) => tracing::info!("ffmpeg ready: {v}"),
                Ok(crate::ffmpeg::BootstrapStatus::Unavailable(m)) => {
                    tracing::warn!("ffmpeg unavailable: {m}")
                }
                Err(e) => tracing::warn!("ffmpeg bootstrap error: {e:#}"),
            }
        });

        Ok(())
    }

    #[napi]
    pub async fn invoke(&self, cmd: String, args_json: String) -> napi::Result<String> {
        self.dispatch(&cmd, &args_json).await.map_err(Error::from_reason)
    }

    /// Push a decrypted cloud API key into the in-memory cache. Called by
    /// Electron main after reading safeStorage; never a renderer-invoke arm
    /// (key material stays off the renderer).
    #[napi]
    pub fn set_cloud_key(&self, provider: String, key: String) {
        self.cloud_keys.lock().expect("cloud_keys poisoned").insert(provider, key);
    }

    /// Remove a cloud API key from the cache (key cleared in Settings).
    #[napi]
    pub fn clear_cloud_key(&self, provider: String) {
        self.cloud_keys.lock().expect("cloud_keys poisoned").remove(&provider);
    }

    /// Replace the read-mirror with a TS-serialized project + history view.
    /// Called by the TS host on every project:changed under WEFTCUT_TS_ACTOR.
    #[napi]
    pub fn set_project_mirror(&self, project_json: String, history_view_json: String) -> napi::Result<()> {
        let project: crate::state::Project = serde_json::from_str(&project_json)
            .map_err(|e| Error::from_reason(format!("set_project_mirror: invalid project json: {e}")))?;
        let history_view: serde_json::Value = serde_json::from_str(&history_view_json)
            .map_err(|e| Error::from_reason(format!("set_project_mirror: invalid history json: {e}")))?;
        *self.read_mirror.lock().expect("read_mirror poisoned") =
            Some(ReadMirror { project: std::sync::Arc::new(project), history_view });
        Ok(())
    }

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
        for mut item in items {
            let stale = item.proxy_path.is_some() && item.proxy_format_version < PROXY_FORMAT_VERSION;
            if stale {
                if let Some(path) = item.proxy_path.take() {
                    let _ = std::fs::remove_file(&path); // best-effort; logged-only in prod
                }
                // Clear the stale proxy through the same seam as job completion, so
                // the TS actor's pool drops it (the seam emits `media:derivatives`,
                // which Electron main applies). We're in an async napi → tokio
                // runtime is present, so `.await` directly.
                let patch = crate::state::MediaDerivativesPatch { proxy_path: Some(None), ..Default::default() };
                let _ = crate::jobs::commit_media_derivatives(&self.events, item.id, patch).await;
            }
            crate::jobs::enqueue_for_media(self.events.clone(), self.cache.clone(), item, self.read_mirror_handle());
        }
        Ok(())
    }

    /// Probe + hash a source file into a serialized `MediaItem` — the compute half
    /// of the `import_media` hybrid (Phase 3d-e). NO actor write: the TS host
    /// applies the insert (`actor.dispatch('add_media_item', { media })`). Reuses
    /// the EXACT probe body `import_media` uses, so the hybrid and the flag-off
    /// path produce identical items. (Subtitles route through the subtitle hybrid;
    /// `probe_media` is for non-subtitle media — the orchestrator branches by ext.)
    #[napi]
    #[cfg(feature = "jobs")]
    pub async fn probe_media(&self, path: String) -> napi::Result<String> {
        let buf = std::path::PathBuf::from(&path);
        let has_workspace = self.workspace.current().is_some();
        let item = tokio::task::spawn_blocking(move || crate::commands::media::probe_media_item(buf, has_workspace))
            .await
            .map_err(|e| Error::from_reason(format!("probe join: {e}")))?
            .map_err(Error::from_reason)?;
        serde_json::to_string(&item).map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Pure parse half of the `apply_subtitles` hybrid (Phase 3d-e). Validates
    /// the body, sniffs/applies the format, runs the parser, and returns a JSON
    /// string `{ cues: Cue[], simplified: boolean }`. NO actor write — the TS
    /// host applies the caption-track write via `actor.dispatch('add_caption_track',
    /// { cues, comp_w, comp_h, label })`. `format` is one of "srt"/"ass"/"vtt"
    /// (case-insensitive) or null to auto-sniff.
    #[napi]
    pub async fn parse_subtitles(&self, body: String, format: Option<String>) -> napi::Result<String> {
        let fmt = format
            .map(|f| crate::subtitles::SubFormat::from_str(&f))
            .transpose()
            .map_err(Error::from_reason)?;
        let (cues, simplified) =
            crate::subtitles::parse_subtitle_cues(&body, fmt)
                .map_err(Error::from_reason)?;
        serde_json::to_string(&serde_json::json!({ "cues": cues, "simplified": simplified }))
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// install_motif hybrid compute (Phase 3d-e): publish the draft (store side)
    /// + extract motif layers from the READ-MIRROR snapshot + build_rebind_updates.
    /// Returns JSON `{ published_id: string, updates: MotifRebindEntry[] }`.
    /// NO actor write — the TS host applies the rebind via `actor.dispatch('rebind_motif', {updates})`.
    /// Reads `snapshot_for_read()` (the mirror) so the frozen Rust actor is never consulted.
    #[napi]
    #[cfg(feature = "motifs")]
    pub async fn compute_motif_rebind(&self, install_args_json: String) -> napi::Result<String> {
        let args: crate::motifs::authoring_commands::InstallArgs =
            serde_json::from_str(&install_args_json).map_err(|e| Error::from_reason(e.to_string()))?;
        let snap = self.snapshot_for_read().await.map_err(Error::from_reason)?;
        let (published_id, updates) =
            crate::motifs::authoring_commands::install_motif_compute(&self.motif_store, &snap, &args)
                .await
                .map_err(Error::from_reason)?;
        // Emit motifs:changed — the store was just mutated (draft installed).
        self.events.emit(
            crate::motifs::authoring_commands::MOTIFS_CHANGED_EVENT,
            serde_json::json!({}),
        );
        serde_json::to_string(&serde_json::json!({ "published_id": published_id, "updates": updates }))
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// acknowledge_motif_staleness hybrid compute (Phase 3d-e): read the READ-MIRROR
    /// snapshot, build ack entries, and return JSON `{ count: number, updates: MotifRebindEntry[] }`.
    /// NO actor write — the TS host applies the rebind via `actor.dispatch('rebind_motif', {updates})`.
    /// Reads `snapshot_for_read()` (the mirror) so the frozen Rust actor is never consulted.
    #[napi]
    #[cfg(feature = "motifs")]
    pub async fn compute_ack_motif_rebind(&self) -> napi::Result<String> {
        let snap = self.snapshot_for_read().await.map_err(Error::from_reason)?;
        let (count, updates) =
            crate::commands::motif_authoring::acknowledge_motif_compute(&self.motif_store, &snap)
                .await
                .map_err(Error::from_reason)?;
        serde_json::to_string(&serde_json::json!({ "count": count, "updates": updates }))
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// synthesize_speech hybrid compute (Phase 3d-e): validate text → pick
    /// synthesizer → content-addressed cache key → synthesize+write if not cached
    /// → spawn_blocking probe → build `MediaItem`. Returns JSON
    /// `{ media_item: MediaItem, duration_us: i64, cached: boolean }`.
    /// NO actor write — the TS host applies the add_media_item + add Audio layer
    /// (Voiceover role) writes via the authoritative actor.
    #[napi]
    #[cfg(feature = "cloud")]
    pub async fn synthesize_speech_compute(&self, args_json: String) -> napi::Result<String> {
        let args: crate::mcp::SynthesizeSpeechArgs =
            serde_json::from_str(&args_json).map_err(|e| Error::from_reason(e.to_string()))?;
        let (media_item, cached) =
            crate::mcp::synthesize_speech_audio(self, &args)
                .await
                .map_err(|e| Error::from_reason(e.message))?;
        let duration_us = media_item.metadata.duration_us.unwrap_or(0);
        serde_json::to_string(&serde_json::json!({
            "media_item": media_item,
            "duration_us": duration_us,
            "cached": cached,
        }))
        .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Queue the background workspace-copy job for an already-inserted media item
    /// (the write half of the `import_media` hybrid is the COPY's path/hash result,
    /// re-routed through the `media:workspace_paths` seam in `import.rs`). Reads the
    /// workspace internally; no-op when none is set (the item keeps referencing the
    /// original source). The copy job's write-back is seam-routed (the TS host
    /// applies it), so no actor handle is threaded through.
    #[napi]
    #[cfg(feature = "jobs")]
    pub async fn enqueue_workspace_copy(&self, media_id: String, source_path: String) -> napi::Result<()> {
        let id = uuid::Uuid::parse_str(&media_id).map_err(|e| Error::from_reason(format!("media_id: {e}")))?;
        let Some(ws) = self.workspace.current() else { return Ok(()); };
        self.import_queue.enqueue(self.cache.clone(), id, std::path::PathBuf::from(source_path), ws);
        Ok(())
    }

    /// `recents.set_last_new_project_parent` — only the new-workspace flow, so the
    /// next "+ New project" form opens pre-filled at the same parent. Best-effort.
    #[napi]
    pub fn set_last_new_project_parent(&self, parent: String) {
        self.recents
            .set_last_new_project_parent(std::path::PathBuf::from(parent));
    }

    /// Open the agent-session slot: installs a new session with `client = "mcp"`
    /// and the given `reason`, then emits `agent_session:changed` so the UI
    /// switches to agent mode. Called by the TS MCP host after `actor.mcpCall`
    /// mints the auto-checkpoint. Idempotent — a second call while
    /// a session is already open replaces it (last writer wins, as per slot API).
    #[napi]
    pub fn begin_agent_session_slot(&self, reason: String) {
        let session = crate::agent_session::AgentSession {
            client: "mcp".into(),
            reason,
            started_at: Utc::now(),
        };
        crate::agent_session::begin_and_emit(self.events.as_ref(), &self.agent_session, session);
    }

    /// Close the agent-session slot and emit `agent_session:changed` (null
    /// payload) so the UI exits agent mode. Idempotent — safe to call when no
    /// session is active. Called by the TS MCP host at agent-session end.
    #[napi]
    pub fn end_agent_session_slot(&self) {
        crate::agent_session::end_and_emit(self.events.as_ref(), &self.agent_session);
    }

    /// Stream one raw encoded frame to the active 10-bit video sink over native
    /// IPC (PoC: the Electron-native alternative to the loopback WebSocket).
    /// Binary in, no JSON — bypasses the `invoke` dispatcher.
    #[cfg(feature = "export")]
    #[napi]
    pub async fn export_video_sink_write(
        &self,
        bytes: napi::bindgen_prelude::Buffer,
    ) -> napi::Result<()> {
        // Time the per-frame copy (deferred-opt signal — see docs/export-ipc-transport.md).
        let t = std::time::Instant::now();
        let data = bytes.to_vec();
        let copy_ns = t.elapsed().as_nanos() as u64;
        crate::export::videosink::video_sink_write(&self.video_sink, data, copy_ns)
            .await
            .map_err(napi::Error::from_reason)
    }
}

#[cfg(feature = "mcp")]
#[napi]
impl Backend {
    #[napi]
    pub async fn mcp_catalog(&self) -> napi::Result<String> {
        Ok(serde_json::to_string(&crate::mcp::catalog()).unwrap())
    }

    #[napi]
    pub async fn mcp_call_tool(&self, name: String, args_json: String) -> napi::Result<String> {
        Ok(crate::mcp::reply(crate::mcp::dispatch_tool(self, &name, &args_json).await))
    }

    #[napi]
    pub async fn mcp_read_resource(&self, uri: String) -> napi::Result<String> {
        Ok(crate::mcp::reply(crate::mcp::read_resource(self, &uri).await))
    }

    #[napi]
    pub async fn mcp_list_prompts(&self) -> napi::Result<String> {
        Ok(serde_json::to_string(&crate::mcp::list_prompts()).unwrap())
    }

    #[napi]
    pub async fn mcp_get_prompt(&self, name: String, args_json: String) -> napi::Result<String> {
        let args: serde_json::Value = serde_json::from_str(&args_json).unwrap_or(serde_json::json!({}));
        Ok(crate::mcp::reply(crate::mcp::get_prompt(&name, args.as_object())))
    }
}

/// A `motif:` file resolved for the Electron `protocol.handle('motif')` handler.
#[cfg(feature = "motifs")]
#[napi(object)]
pub struct MotifFile {
    pub bytes: napi::bindgen_prelude::Buffer,
    pub content_type: String,
}

#[cfg(feature = "motifs")]
#[napi]
impl Backend {
    /// Resolve a `motif://<id>/<rest>` file to bytes + content-type for the main
    /// process's `protocol.handle`. Built-ins first, then the on-disk user store.
    /// `None` → main returns 404.
    #[napi]
    pub fn motif_resolve_file(&self, id: String, rest: String) -> Option<MotifFile> {
        let bytes = crate::motifs::builtin::resolve_bytes(Some(&self.motif_store), &id, &rest)?;
        Some(MotifFile {
            content_type: crate::motifs::builtin::content_type_for(&rest).to_string(),
            bytes: bytes.into(),
        })
    }

    /// Resolve the capture `ctx.duration` (seconds) for a Motif + instance props.
    /// Backs the JS capture orchestrator's `meta.duration` (the frozen renderer
    /// shim can't pass it). Built-ins resolve without touching disk.
    #[napi]
    pub fn motif_ctx_duration_s(&self, id: String, props_json: String) -> f64 {
        let props: serde_json::Value =
            serde_json::from_str(&props_json).unwrap_or(serde_json::Value::Null);
        crate::motifs::resolve_capture_duration(
            &id,
            &crate::motifs::catalog::builtins(),
            || {
                self.motif_store
                    .get_motif(&id)
                    .into_iter()
                    .map(|m| m.manifest)
                    .collect()
            },
            &props,
        )
    }
}

// NOTE: `napi::bindgen_prelude::*` re-exports a `Result` alias whose error type
// is `napi::Error`. The plain-Rust dispatch surface below speaks
// `std::result::Result<_, String>`, so spell it out fully to dodge that alias.
impl Backend {
    /// Clone the Arc handle so background jobs can read the mirror without
    /// borrowing `Backend` across an await point.
    pub(crate) fn read_mirror_handle(&self) -> std::sync::Arc<std::sync::Mutex<Option<ReadMirror>>> {
        self.read_mirror.clone()
    }

    /// Project snapshot for READ-ONLY consumers (resources, detect_silences,
    /// transcribe_clip, the compute hybrids). Returns the TS read-mirror — the
    /// sole project source post-4b. A clear error if the mirror is unset: the TS
    /// host pushes the initial mirror at boot before any read can run (bring-up
    /// order), so an unset mirror is a wiring bug, never an actor fallback.
    pub(crate) async fn snapshot_for_read(&self) -> std::result::Result<std::sync::Arc<crate::state::Project>, String> {
        self.read_mirror
            .lock()
            .expect("read_mirror poisoned")
            .as_ref()
            .map(|m| m.project.clone())
            .ok_or_else(|| "read-mirror not set (TS host must push it before any read)".to_string())
    }

    /// The mirrored history view (project://history), or None when unset.
    pub(crate) fn mirror_history_view(&self) -> Option<serde_json::Value> {
        self.read_mirror.lock().expect("read_mirror poisoned").as_ref().map(|m| m.history_view.clone())
    }

    /// Plain (non-napi) constructor for tests: roots config + cache in an
    /// instance-unique temp dir and runs the identical store/tracing setup as
    /// the napi `new`. No `ThreadsafeFunction` / napi env required.
    ///
    /// Each call appends a process-wide monotonic counter to the temp-dir name
    /// (`weftcut-test-<pid>-<n>`) so two backends in one test binary — e.g. a
    /// save-in-A / open-in-B round-trip — never share a config + cache root.
    /// Convenience variant that accepts a typed `Arc<VecEventSink>` and retains
    /// a clone for the caller (used by tests that need to assert on emitted events).
    #[cfg(test)]
    pub fn new_for_test_with_sink(sink: Arc<crate::events::VecEventSink>) -> Self {
        Self::new_for_test(sink as Arc<dyn EventSink>)
    }

    #[cfg(test)]
    pub fn new_for_test(events: Arc<dyn EventSink>) -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir()
            .join(format!("weftcut-test-{}-{}", std::process::id(), n));
        let config_dir = base.join("config").to_string_lossy().to_string();
        let cache_dir = base.join("cache").to_string_lossy().to_string();
        build_backend(events, config_dir, cache_dir)
    }

    pub async fn dispatch(&self, cmd: &str, args: &str) -> std::result::Result<String, String> {
        // Phase 4b: only native / persistence-store / mirror-backed-read channels
        // reach here. Every project mutation, history op, project-summary read, and
        // project_open/save persistence op routes to the TS state actor (the sole
        // writer) in Electron main; their Rust fallback arms were deleted with the
        // actor. The kept set mirrors the router's 'rust' allowlist (PURE_NATIVE ∪
        // PERSISTENCE ∪ MIRROR_BACKED_READS); the hybrid compute halves are
        // dispatched via dedicated napi methods (probe_media / parse_subtitles /
        // compute_motif_rebind / …), not this match.
        match cmd {
            "ping" => Ok(serde_json::to_string(crate::commands::prefs::ping()).unwrap()),
            // ---- prefs / settings / recents / keybindings / logs / agent ----
            "app_settings_get" => ser(crate::commands::prefs::app_settings_get(self).await),
            "app_settings_set" => {
                let a: crate::commands::prefs::AppSettingsSetArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::prefs::app_settings_set(self, a.patch).await)
            }
            "view_state_get" => ser(crate::commands::prefs::view_state_get(self).await),
            "view_state_set" => {
                let a: crate::commands::prefs::ViewStateSetArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::prefs::view_state_set(self, a.state).await)
            }
            "export_settings_get" => ser(crate::commands::prefs::export_settings_get(self).await),
            "export_settings_set" => {
                let a: crate::commands::prefs::ExportSettingsSetArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::prefs::export_settings_set(self, a.settings).await)
            }
            "workspace_dir" => ser(crate::commands::prefs::workspace_dir(self).await),
            "recents_list" => ser(crate::commands::prefs::recents_list(self).await),
            "recents_remove" => {
                let a: crate::commands::prefs::RecentsRemoveArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::prefs::recents_remove(self, a.path).await)
            }
            "recents_get_reopen_on_launch" => ser(crate::commands::prefs::recents_get_reopen_on_launch(self).await),
            "recents_set_reopen_on_launch" => {
                let a: crate::commands::prefs::RecentsSetReopenOnLaunchArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::prefs::recents_set_reopen_on_launch(self, a.value).await)
            }
            "recents_most_recent" => ser(crate::commands::prefs::recents_most_recent(self).await),
            "recents_last_new_project_parent" => ser(crate::commands::prefs::recents_last_new_project_parent(self).await),
            "keybindings_get" => ser(crate::commands::prefs::keybindings_get(self).await),
            "keybindings_set" => {
                let a: crate::commands::prefs::KeybindingsSetArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::prefs::keybindings_set(self, a.action, a.keys).await)
            }
            "keybindings_reset_all" => ser(crate::commands::prefs::keybindings_reset_all(self).await),
            "keybindings_export" => {
                let a: crate::commands::prefs::KeybindingsExportArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::prefs::keybindings_export(self, a.dest).await)
            }
            "keybindings_import" => {
                let a: crate::commands::prefs::KeybindingsImportArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::prefs::keybindings_import(self, a.src).await)
            }
            "agent_session_get" => ser(crate::commands::prefs::agent_session_get(self).await),
            "log_list" => ser(crate::commands::prefs::log_list(self).await),
            "log_clear" => ser(crate::commands::prefs::log_clear(self).await),
            "log_emit" => {
                let a: crate::commands::prefs::LogEmitArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::prefs::log_emit(self, a.input).await)
            }
            "log_dir_path" => ser(crate::commands::prefs::log_dir_path(self).await),
            #[cfg(feature = "jobs")]
            "import_cancel" => {
                let a: crate::commands::MediaIdArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::import_cancel(self, a.media_id).await)
            }
            #[cfg(feature = "jobs")]
            "import_queue_list" => ser(crate::commands::media::import_queue_list(self).await),
            #[cfg(feature = "jobs")]
            "get_media_thumbnail" => {
                let a: crate::commands::MediaIdArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::get_media_thumbnail(self, a.media_id).await)
            }
            #[cfg(feature = "jobs")]
            "get_waveform_peaks" => {
                let a: crate::commands::MediaIdArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::get_waveform_peaks(self, a.media_id).await)
            }
            #[cfg(feature = "jobs")]
            "ensure_full_proxy" => {
                let a: crate::commands::MediaIdArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::ensure_full_proxy(self, a.media_id).await)
            }
            #[cfg(feature = "jobs")]
            "ensure_conform" => {
                let a: crate::commands::MediaIdArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::ensure_conform(self, a.media_id).await)
            }
            #[cfg(feature = "jobs")]
            "report_audio_meter" => {
                #[derive(serde::Deserialize)]
                struct A { report: crate::commands::media::AudioMeterReport }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::report_audio_meter(self, a.report).await)
            }
            #[cfg(feature = "export")]
            "export_project_audio_only" => {
                let a: crate::commands::ExportAudioOnlyArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::export::export_project_audio_only(self, a.output_path, a.audio, a.start_us, a.end_us).await)
            }
            #[cfg(feature = "export")]
            "mux_export" => {
                let a: crate::commands::MuxExportArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::export::mux_export(self, a.video_path, a.audio_path, a.output_path, a.transcode).await)
            }
            #[cfg(feature = "export")]
            "ensure_export_audio_conform" => {
                let a: crate::commands::ExportConformArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::export::ensure_export_audio_conform(self, a.start_us, a.end_us).await)
            }
            #[cfg(feature = "export")]
            "export_video_sink_start" => {
                #[derive(serde::Deserialize)]
                struct A {
                    args: crate::export::videosink::VideoSinkStartArgs,
                }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::export::videosink::export_video_sink_start(&self.video_sink, &self.hw_encoder, a.args).await)
            }
            #[cfg(feature = "export")]
            "export_video_sink_finish" => {
                ser(crate::export::videosink::export_video_sink_finish(&self.video_sink).await)
            }
            #[cfg(feature = "export")]
            "export_video_sink_cancel" => {
                ser(crate::export::videosink::export_video_sink_cancel(&self.video_sink).await)
            }
            #[cfg(feature = "cloud")]
            "settings_get_api_key_status" => {
                ser(crate::commands::cloud::settings_get_api_key_status(self).await)
            }
            #[cfg(feature = "cloud")]
            "settings_test_provider" => {
                let a: crate::commands::cloud::SettingsTestProviderArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::cloud::settings_test_provider(self, a.provider).await)
            }
            #[cfg(feature = "motifs")]
            "list_motifs" => ser(crate::commands::motifs::list_motifs(self).await),
            #[cfg(feature = "motifs")]
            "get_motif_source" => {
                #[derive(serde::Deserialize)] struct A { id: String }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::get_motif_source(self, a.id).await)
            }
            #[cfg(feature = "motifs")]
            "write_motif_draft" => {
                #[derive(serde::Deserialize)] struct A { args: crate::motifs::authoring_commands::WriteDraftArgs }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::write_motif_draft(self, a.args).await)
            }
            #[cfg(feature = "motifs")]
            "amend_motif_draft" => {
                #[derive(serde::Deserialize)] #[serde(rename_all = "camelCase")] struct A { draft_id: String, source: String }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::amend_motif_draft(self, a.draft_id, a.source).await)
            }
            #[cfg(feature = "motifs")]
            "create_edit_draft" => {
                #[derive(serde::Deserialize)] #[serde(rename_all = "camelCase")] struct A { source_id: String }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::create_edit_draft(self, a.source_id).await)
            }
            #[cfg(feature = "motifs")]
            "import_motif" => {
                #[derive(serde::Deserialize)] struct A { path: String }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::import_motif(self, a.path).await)
            }
            #[cfg(feature = "motifs")]
            "delete_motif" => {
                #[derive(serde::Deserialize)] struct A { id: String }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::delete_motif(self, a.id).await)
            }
            #[cfg(feature = "motifs")]
            "motif_staleness_report" => ser(crate::commands::motif_authoring::motif_staleness_report(self).await),
            other => Err(format!("unknown command: '{other}'")),
        }
    }
}

/// Serialize a typed command result into the dispatcher's JSON-string contract.
pub(crate) fn ser<T: Serialize>(r: std::result::Result<T, String>) -> std::result::Result<String, String> {
    r.and_then(|v| serde_json::to_string(&v).map_err(|e| e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::VecEventSink;

    /// Poll `sink.names()` until `name` appears or `timeout_ms` elapses.
    /// Returns `true` as soon as the event is seen, `false` on timeout.
    async fn wait_for_event(sink: &VecEventSink, name: &str, timeout_ms: u64) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_millis(timeout_ms) {
            if sink.names().iter().any(|n| n == name) {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        sink.names().iter().any(|n| n == name)
    }

    /// Push a blank project as the read-mirror so the mirror-backed read handlers
    /// (`get_*`, `ensure_*`, `motif_staleness_report`, `transcribe`/`detect`) have
    /// a project source — the TS host does this at boot in production.
    fn push_blank_mirror(b: &Backend) {
        let p = crate::state::Project::new_blank("test-mirror");
        b.set_project_mirror(serde_json::to_string(&p).unwrap(), "{}".into()).unwrap();
    }

    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn get_waveform_peaks_unknown_media_errors() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        push_blank_mirror(&b);
        let args = serde_json::json!({ "mediaId": uuid::Uuid::new_v4().to_string() }).to_string();
        let err = b.dispatch("get_waveform_peaks", &args).await.unwrap_err();
        assert!(err.contains("not found"), "unknown media → not found, got: {err}");
    }

    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn report_audio_meter_stores_snapshot() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let args = r#"{"report":{"rmsDb":-12.0,"peakDb":-3.0}}"#;
        let out = b.dispatch("report_audio_meter", args).await.unwrap();
        assert_eq!(out, "null", "report_audio_meter returns unit/null");
    }

    /// S2 prefs: `app_settings_set` must fire `app_settings:changed`.
    #[tokio::test]
    async fn app_settings_set_emits_changed() {
        let sink = VecEventSink::new();
        let b = Backend::new_for_test(Arc::new(sink.clone()));
        b.init().await.unwrap();
        let cur = b.dispatch("app_settings_get", "{}").await.unwrap();
        assert!(!cur.is_empty());
        // Empty patch — all fields optional, so `{}` deserializes fine.
        b.dispatch("app_settings_set", r#"{"patch":{}}"#)
            .await
            .expect("app_settings_set must succeed");
        assert!(
            sink.names().iter().any(|n| n == "app_settings:changed"),
            "app_settings:changed must be emitted; got: {:?}",
            sink.names()
        );
    }

    /// Blank project has no audio layers, so the export-audio gate returns an
    /// empty waiting list with no ffmpeg involvement — proves the arm is wired.
    #[cfg(feature = "export")]
    #[tokio::test]
    async fn ensure_export_audio_conform_blank_is_empty() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        push_blank_mirror(&b);
        let out = b
            .dispatch("ensure_export_audio_conform", r#"{"startUs":0,"endUs":1000000}"#)
            .await
            .unwrap();
        assert_eq!(out, "[]", "blank project has no audio layers to conform");
    }

    /// IPC-only sink (empty outputPath = no ffmpeg / byte-count only): start
    /// returns null (unit), then cancel clears the active sink.
    #[cfg(feature = "export")]
    #[tokio::test]
    async fn video_sink_ipc_start_then_cancel() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        let start_args = serde_json::json!({
            "args": {
                "width": 64, "height": 64,
                "fpsNum": 30, "fpsDen": 1, "codec": "hevc",
                "bitrate": 0, "cbr": false, "gop": 30,
                "software": false, "outputPath": ""
            }
        })
        .to_string();
        let reply = b.dispatch("export_video_sink_start", &start_args).await.unwrap();
        assert_eq!(reply, "null", "IPC start returns unit/null, got {reply}");
        let cancel = b.dispatch("export_video_sink_cancel", "{}").await.unwrap();
        assert_eq!(cancel, "null", "cancel returns unit/null");
    }

    #[cfg(feature = "mcp")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mcp_catalog_lists_ping_and_apply_subtitles() {
        // Phase 4b: Rust catalog is native/compute/hybrid only.
        // `add_track` is TS-served and must NOT appear here.
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let cat = b.mcp_catalog().await.unwrap();
        assert!(cat.contains("\"ping\""));
        assert!(cat.contains("\"apply_subtitles\""));
        assert!(!cat.contains("\"add_track\""), "add_track must not be in the Rust-native catalog (Phase 4b)");
        // every tool advertises an object inputSchema
        let v: serde_json::Value = serde_json::from_str(&cat).unwrap();
        for t in v["tools"].as_array().unwrap() {
            assert!(t["inputSchema"].is_object(), "tool {} has no inputSchema", t["name"]);
        }
    }

    #[cfg(feature = "mcp")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mcp_catalog_property_schemas_are_objects() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let cat: serde_json::Value = serde_json::from_str(&b.mcp_catalog().await.unwrap()).unwrap();
        // Every value under any `properties` map must be an object (the MCP SDK
        // rejects boolean property schemas, e.g. schemars' `true` for serde Value).
        fn check(v: &serde_json::Value, tool: &str) {
            if let Some(obj) = v.as_object() {
                if let Some(props) = obj.get("properties").and_then(|p| p.as_object()) {
                    for (k, sub) in props {
                        assert!(sub.is_object(), "tool '{tool}': property '{k}' schema is {sub}, not an object — MCP SDK rejects boolean schemas");
                    }
                }
                for sub in obj.values() { check(sub, tool); }
            }
        }
        for t in cat["tools"].as_array().unwrap() {
            check(&t["inputSchema"], t["name"].as_str().unwrap_or("?"));
        }
    }

    #[cfg(feature = "cloud")]
    #[tokio::test]
    async fn settings_status_reflects_cache() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        // Unconfigured: openai present in the list, configured=false.
        let out = b.dispatch("settings_get_api_key_status", "{}").await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let openai = v.as_array().unwrap().iter().find(|e| e["provider"] == "openai").unwrap();
        assert_eq!(openai["configured"], false);
        assert!(openai["label"].as_str().unwrap().contains("OpenAI"));
        // After a push: configured=true.
        b.set_cloud_key("openai".into(), "sk-x".into());
        let out = b.dispatch("settings_get_api_key_status", "{}").await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let openai = v.as_array().unwrap().iter().find(|e| e["provider"] == "openai").unwrap();
        assert_eq!(openai["configured"], true);
    }

    #[cfg(feature = "cloud")]
    #[tokio::test]
    async fn settings_test_provider_missing_key_is_clean_error() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        let err = b
            .dispatch("settings_test_provider", r#"{"provider":"openai"}"#)
            .await
            .unwrap_err();
        assert!(err.contains("Settings"), "missing-key error should hint Settings, got: {err}");
    }

    #[cfg(feature = "motifs")]
    #[test]
    fn motif_store_resolves_builtin_bytes() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        let bytes = crate::motifs::builtin::resolve_bytes(Some(&b.motif_store), "countdown", "index.html")
            .expect("countdown index resolves");
        assert!(std::str::from_utf8(&bytes).unwrap().contains("motif.define"));
    }

    #[cfg(feature = "mcp")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mcp_call_tool_unknown_is_not_found() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let reply: serde_json::Value =
            serde_json::from_str(&b.mcp_call_tool("no_such_tool".into(), "{}".into()).await.unwrap()).unwrap();
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["code"], "not_found");
    }

    #[tokio::test]
    async fn cloud_key_cache_set_and_clear() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        assert!(!b.cloud_keys.lock().unwrap().contains_key("openai"));
        b.set_cloud_key("openai".into(), "sk-abc".into());
        assert_eq!(
            b.cloud_keys.lock().unwrap().get("openai").map(String::as_str),
            Some("sk-abc"),
        );
        b.clear_cloud_key("openai".into());
        assert!(!b.cloud_keys.lock().unwrap().contains_key("openai"));
    }

    /// A `log_emit` dispatch after a workspace is installed (via `commit_workspace`,
    /// the TS-host persistence seam) must reach the EventSink as a `log:entry`
    /// event. The LogBus bridge is async (broadcast → sink), so we poll.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn logged_action_after_workspace_emits_log_entry() {
        let sink = VecEventSink::new();
        let b = Backend::new_for_test(Arc::new(sink.clone()));
        b.init().await.unwrap();
        // Install a workspace so the LogBus slot is live, then emit a log.
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("p.vproj");
        std::fs::create_dir_all(&proj).unwrap();
        b.commit_workspace(proj.to_string_lossy().to_string()).await.unwrap();
        // LogCategory::System serializes as {"kind":"System"} (adjacently-tagged, unit variant).
        // LogSource::User serializes as {"kind":"User"} (internally-tagged, unit variant).
        // LogLevel::Info serializes as "info" (rename_all = "lowercase").
        let entry = serde_json::json!({
            "input": {
                "level": "info",
                "category": { "kind": "System" },
                "source": { "kind": "User" },
                "message": "hi"
            }
        })
        .to_string();
        b.dispatch("log_emit", &entry).await.unwrap();
        // poll-until-timeout (broadcast bridge is async)
        assert!(
            wait_for_event(&sink, crate::logs::EVENT_LOG_ENTRY, 2000).await,
            "log:entry must reach the sink; saw {:?}",
            sink.names()
        );
    }

    #[cfg(feature = "motifs")]
    #[tokio::test]
    async fn staleness_report_arm_is_empty_on_blank_project() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        push_blank_mirror(&b);
        let json = b.dispatch("motif_staleness_report", "{}").await.unwrap();
        assert_eq!(json, "[]"); // no motif layers placed → empty report
    }

    #[cfg(feature = "motifs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_motifs_arm_returns_builtins() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        let json = b.invoke("list_motifs".into(), "{}".into()).await.unwrap();
        assert!(json.contains("countdown"));
        assert!(json.contains("lower-third"));
    }

    #[cfg(feature = "motifs")]
    #[tokio::test]
    async fn write_draft_arm_returns_id_and_emits_changed() {
        let sink = std::sync::Arc::new(crate::events::VecEventSink::default());
        let b = Backend::new_for_test_with_sink(sink.clone());
        b.init().await.unwrap();
        let manifest = r#"{"id":"x","name":"My Draft","version":1,"size":[200,80],"default_duration_s":2,"props_schema":{}}"#;
        let body = r#"<head></head><body><script>motif.define({setup(){}})</script></body>"#;
        let arg = format!(r#"{{"args":{{"manifest":{manifest},"html":{}}}}}"#, serde_json::to_string(body).unwrap());
        let id = b.dispatch("write_motif_draft", &arg).await.unwrap();
        assert!(!id.is_empty());
        assert!(sink.names().iter().any(|n| n == "motifs:changed"));
    }

    #[cfg(feature = "cloud")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transcribe_clip_without_key_is_clean_error() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        push_blank_mirror(&b);
        // Bogus layer id; the layer lookup fails on the blank mirror → ok:false.
        let reply: serde_json::Value = serde_json::from_str(
            &b.mcp_call_tool("transcribe_clip".into(), r#"{"layer_id":"00000000-0000-0000-0000-000000000000"}"#.into())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(reply["ok"], false);
    }

    /// `commit_workspace` re-points cache + workspace slot; `push_recent`
    /// records the entry in recents. Both are observable via kept dispatch arms.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn commit_workspace_sets_workspace_cache_and_recents() {
        use std::sync::Arc;
        let backend = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
        let dir = std::env::temp_dir().join(format!("weftcut-3cb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();

        backend.commit_workspace(path.clone()).await.unwrap();

        // workspace slot now reports the committed path.
        let ws_json = backend.dispatch("workspace_dir", "{}").await.unwrap();
        let ws_str: Option<String> = serde_json::from_str(&ws_json)
            .expect("workspace_dir must deserialize to Option<String>");
        let ws_path = std::path::PathBuf::from(ws_str.expect("workspace must be Some after commit_workspace"));
        assert_eq!(
            ws_path.canonicalize().unwrap_or(ws_path.clone()),
            dir.canonicalize().unwrap_or(dir.clone()),
            "workspace slot must point at the committed dir"
        );

        // cache.set_workspace creates <dir>/Cache synchronously.
        assert!(dir.join("Cache").exists(), "cache dir not created by commit_workspace");

        // push_recent then verify via recents_list.
        backend.push_recent(path.clone(), "Demo".to_string());
        let recents_json = backend.dispatch("recents_list", "{}").await.unwrap();
        let dir_name = dir.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        assert!(
            recents_json.contains(&dir_name),
            "recents_list did not include the pushed path (looking for {dir_name:?}): {recents_json}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Durable guard: the mirror-backed read handlers must read from the
    /// read-mirror (`snapshot_for_read`) and never the deleted Rust actor
    /// (`.project()?.snapshot()`), and `ensure_full_proxy` must route its
    /// derivative write through the `commit_media_derivatives` seam.
    /// A MECHANICAL source-scan — no Backend / tokio runtime.
    #[test]
    fn mirror_backed_reads_use_the_mirror_not_an_actor() {
        let root = env!("CARGO_MANIFEST_DIR");
        let media = std::fs::read_to_string(format!("{root}/src/commands/media.rs"))
            .expect("commands/media.rs must be readable");
        let export = std::fs::read_to_string(format!("{root}/src/commands/export.rs"))
            .expect("commands/export.rs must be readable");
        let motif = std::fs::read_to_string(format!("{root}/src/commands/motif_authoring.rs"))
            .expect("commands/motif_authoring.rs must be readable");

        // No file may contain the deleted stale-actor snapshot read.
        for (name, src) in [
            ("commands/media.rs", &media),
            ("commands/export.rs", &export),
            ("commands/motif_authoring.rs", &motif),
        ] {
            assert!(
                !src.contains(".project()?.snapshot()"),
                "{name}: stale-actor snapshot read `.project()?.snapshot()` is present — \
                 the Rust actor was deleted; re-point to `snapshot_for_read()`"
            );
        }

        // The mirror-backed read handlers must call `snapshot_for_read`.
        for (name, src) in [
            ("commands/media.rs", &media),
            ("commands/export.rs", &export),
            ("commands/motif_authoring.rs", &motif),
        ] {
            assert!(
                src.contains("snapshot_for_read"),
                "{name}: mirror-backed reads must call `snapshot_for_read`"
            );
        }

        // `ensure_full_proxy` routes its derivative write through the seam.
        let efp_start = media.find("fn ensure_full_proxy")
            .expect("ensure_full_proxy must exist in commands/media.rs");
        let efp_tail = &media[efp_start..];
        let efp_body = match efp_tail.find("\npub async fn ") {
            Some(next) => &efp_tail[..next],
            None => efp_tail,
        };
        assert!(
            efp_body.contains("commit_media_derivatives"),
            "ensure_full_proxy must call `commit_media_derivatives` (the TS-write seam)"
        );
    }
}
