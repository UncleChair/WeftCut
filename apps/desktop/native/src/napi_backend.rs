//! `Backend` — the napi entry point. Holds the actor handle + managed stores,
//! exposes a single `invoke` dispatcher and an `init` that spawns the actor and
//! the actor→UI event bridge.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde::Serialize;

use crate::agent_session::AgentSessionSlot;
use crate::app_settings::AppSettingsStore;
use crate::cache::CacheLayout;
use crate::events::{EventSink, TsfnEventSink};
use crate::io::autosave::AutosaveController;
use crate::keybindings::KeybindingsStore;
use crate::logs::{self, LogBusSlot};
use crate::recents::RecentsStore;
use crate::state::{self, ProjectHandle};
use crate::workspace::WorkspaceSlot;

#[napi]
pub struct Backend {
    pub(crate) events: Arc<dyn EventSink>,
    project: OnceLock<ProjectHandle>,
    autosave: OnceLock<AutosaveController>,
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
    #[cfg(feature = "jobs")]
    let import_queue = crate::jobs::import::ImportQueue::new(events.clone(), log_slot.clone());
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
        project: OnceLock::new(),
        autosave: OnceLock::new(),
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

    /// Spawn the actor + bridge. Must be awaited once before any `invoke`.
    /// Runs inside napi's tokio runtime, so `tokio::spawn` has a runtime.
    #[napi]
    pub async fn init(&self) -> napi::Result<()> {
        let handle = state::spawn(state::Project::new_blank("untitled"));
        self.project.set(handle.clone()).map_err(|_| Error::from_reason("init called twice"))?;

        // Bridge actor ChangeEvents to the `project:changed` UI event. Without
        // this, agent/MCP-driven mutations land in state but the UI panels stay
        // frozen until the user interacts. The payload is a tiny summary — the
        // UI just re-fetches `project_summary` on any signal. Each event also
        // feeds the status-log bus (no-op until a workspace installs a bus).
        //
        // Subscribe BEFORE spawning so that any broadcast sent after init()
        // returns is buffered for this receiver — not dropped to zero receivers.
        let mut rx = handle.subscribe();
        let events = self.events.clone();
        let log_slot = self.log_slot.clone();
        tokio::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let (actor_kind, client) = match &event.actor {
                            state::Actor::User => ("user", None),
                            state::Actor::Agent { client } => ("agent", Some(client.clone())),
                        };
                        events.emit(
                            "project:changed",
                            serde_json::json!({
                                "op_id": event.op_id.to_string(),
                                "actor_kind": actor_kind,
                                "client": client,
                                "summary": event.summary,
                                "timestamp": event.timestamp.to_rfc3339(),
                                "affected_count": event.affected.len(),
                            }),
                        );

                        #[cfg(feature = "mcp")]
                        {
                            let summary = crate::mcp::ChangeEventSummary::from(&event);
                            if let Ok(v) = serde_json::to_value(&summary) {
                                events.emit("mcp:change", v);
                            }
                        }

                        let source = match &event.actor {
                            state::Actor::User => logs::LogSource::User,
                            state::Actor::Agent { client } => logs::LogSource::Agent {
                                client: client.clone(),
                            },
                        };
                        log_slot.emit(logs::LogEntryInput {
                            level: logs::LogLevel::Info,
                            category: logs::LogCategory::Project,
                            source,
                            message: event.summary.clone(),
                            op_id: Some(event.op_id),
                            ..Default::default()
                        });
                    }
                    Err(RecvError::Lagged(n)) => {
                        tracing::warn!("ui-event bridge: lagged {n} events; emitting refresh signal");
                        events.emit("project:changed", serde_json::json!({ "lagged": n }));
                    }
                    Err(RecvError::Closed) => break,
                }
            }
        });

        // Auto-save subscriber. Listens to actor events, debounces, writes
        // `project.json` whenever a workspace is set. Dormant pre-workspace.
        let autosave = AutosaveController::spawn(handle, self.workspace.clone());
        let _ = self.autosave.set(autosave);

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
    pub(crate) fn project(&self) -> std::result::Result<&ProjectHandle, String> {
        self.project.get().ok_or_else(|| "backend not initialized".to_string())
    }

    /// The autosave controller installed by `init`. `project_save` force-flushes
    /// through it; pre-`init` it's absent (the unreachable blank-boot window).
    pub(crate) fn autosave(&self) -> std::result::Result<&AutosaveController, String> {
        self.autosave.get().ok_or_else(|| "backend not initialized".to_string())
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
        match cmd {
            "ping" => Ok(serde_json::to_string(crate::commands::prefs::ping()).unwrap()),
            "project_summary" => ser(crate::commands::query::project_summary(self).await),
            "add_track" => ser(crate::commands::mutations::add_track(self).await),
            "separate_audio_to_new_track" => {
                let a: crate::commands::SeparateAudioToNewTrackArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::separate_audio_to_new_track(self, a.layer_id).await)
            }
            "add_demo_color_layer" => ser(crate::commands::mutations::add_demo_color_layer(self).await),
            "add_color_layer" => {
                let a: crate::commands::AddColorLayerArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::add_color_layer(self, a.track_id, a.color, a.width, a.height, a.t_start_us, a.duration_us).await)
            }
            "add_media_layer" => {
                let a: crate::commands::AddMediaLayerArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::add_media_layer(self, a.track_id, a.media_id, a.t_start_us).await)
            }
            "add_text_layer" => {
                let a: crate::commands::AddTextLayerArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::add_text_layer(self, a.track_id, a.content, a.t_start_us, a.duration_us).await)
            }
            "add_demo_text_layer" => ser(crate::commands::mutations::add_demo_text_layer(self).await),
            "add_subtitles_layer" => {
                let a: crate::commands::AddSubtitlesLayerArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::add_subtitles_layer(self, a.media_id, a.t_start_us, a.duration_us).await)
            }
            "update_layer" => {
                let a: crate::commands::UpdateLayerArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::update_layer(self, a.layer_id, a.patch).await)
            }
            "update_layer_params" => {
                let a: crate::commands::UpdateLayerParamsArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::update_layer_params(self, a.layer_id, a.patch).await)
            }
            "update_layer_param_track" => {
                let a: crate::commands::UpdateLayerParamTrackArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::update_layer_param_track(self, a.layer_id, a.param_key, a.track).await)
            }
            "update_layer_param_tracks" => {
                let a: crate::commands::UpdateLayerParamTracksArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::update_layer_param_tracks(self, a.layer_id, a.entries).await)
            }
            "move_layer" => {
                let a: crate::commands::MoveLayerArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::move_layer(self, a.layer_id, a.new_track_id, a.new_t_start_us, a.escape_group).await)
            }
            "trim_layer" => {
                let a: crate::commands::TrimLayerArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::trim_layer(self, a.layer_id, a.edge, a.new_t_us, a.escape_group).await)
            }
            "split_layer_grouped" => {
                let a: crate::commands::SplitLayerGroupedArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::split_layer_grouped(self, a.layer_id, a.at_t_us, a.escape_group).await)
            }
            "groups_create" => {
                let a: crate::commands::GroupsCreateArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::groups_create(self, a.layer_ids, a.label, a.reassign).await)
            }
            "groups_dissolve" => {
                let a: crate::commands::GroupsDissolveArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::groups_dissolve(self, a.group_id).await)
            }
            "duplicate_layer" => {
                let a: crate::commands::DuplicateLayerArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::duplicate_layer(self, a.layer_id, a.t_offset_us).await)
            }
            "delete_layer" => {
                let a: crate::commands::DeleteLayerArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::delete_layer(self, a.layer_id).await)
            }
            "set_composition" => {
                let a: crate::commands::SetCompositionArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::set_composition(self, a.patch).await)
            }
            "fit_composition_to_layers" => ser(crate::commands::mutations::fit_composition_to_layers(self).await),
            "add_marker" => {
                let a: crate::commands::AddMarkerArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::add_marker(self, a.t_us, a.end_t_us, a.label, a.color).await)
            }
            "update_track_flags" => {
                let a: crate::commands::UpdateTrackFlagsArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::update_track_flags(self, a.track_id, a.patch).await)
            }
            "set_role_gain" => {
                let a: crate::commands::SetRoleGainArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::set_role_gain(self, a.role, a.gain_db).await)
            }
            "update_role_flags" => {
                let a: crate::commands::UpdateRoleFlagsArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::mutations::update_role_flags(self, a.role, a.patch).await)
            }
            "project_undo" => ser(crate::commands::history::project_undo(self).await),
            "project_redo" => ser(crate::commands::history::project_redo(self).await),
            "project_restore_checkpoint" => {
                let a: crate::commands::RestoreCheckpointArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::history::project_restore_checkpoint(self, a.checkpoint_id).await)
            }
            #[cfg(debug_assertions)]
            "debug_lock_history" => {
                let a: crate::commands::DebugLockHistoryArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::history::debug_lock_history(self, a.reason).await)
            }
            #[cfg(debug_assertions)]
            "debug_unlock_history" => ser(crate::commands::history::debug_unlock_history(self).await),
            "project_save" => ser(crate::commands::persistence::project_save(self).await),
            "project_save_as" => {
                let a: crate::commands::PathArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::persistence::project_save_as(self, a.path).await)
            }
            "project_open" => {
                let a: crate::commands::PathArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::persistence::project_open(self, a.path).await)
            }
            "project_new_workspace" => {
                let a: crate::commands::NewWorkspaceArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::persistence::project_new_workspace(self, a.parent_folder, a.name, a.width, a.height, a.fps_num, a.fps_den).await)
            }
            #[cfg(debug_assertions)]
            "debug_simulate_agent_session" => {
                let a: crate::commands::DebugSimulateAgentSessionArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::history::debug_simulate_agent_session(self, a.reason).await)
            }
            // ---- prefs / settings / recents / keybindings / logs / agent ----
            "get_project_settings" => ser(crate::commands::prefs::get_project_settings(self).await),
            "update_project_settings" => {
                let a: crate::commands::prefs::UpdateProjectSettingsArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::prefs::update_project_settings(self, a.patch).await)
            }
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
            "agent_session_end" => ser(crate::commands::prefs::agent_session_end(self).await),
            "log_list" => ser(crate::commands::prefs::log_list(self).await),
            "log_clear" => ser(crate::commands::prefs::log_clear(self).await),
            "log_emit" => {
                let a: crate::commands::prefs::LogEmitArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::prefs::log_emit(self, a.input).await)
            }
            "log_dir_path" => ser(crate::commands::prefs::log_dir_path(self).await),
            #[cfg(feature = "jobs")]
            "import_media" => {
                let a: crate::commands::PathArgs = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::media::import_media(self, a.path).await)
            }
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
            "add_motif" => {
                let a: crate::commands::motifs::AddMotifArgs =
                    serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motifs::add_motif(self, a).await)
            }
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
            "install_motif" => {
                #[derive(serde::Deserialize)] struct A { args: crate::motifs::authoring_commands::InstallArgs }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::install_motif(self, a.args).await)
            }
            #[cfg(feature = "motifs")]
            "delete_motif" => {
                #[derive(serde::Deserialize)] struct A { id: String }
                let a: A = serde_json::from_str(args).map_err(|e| e.to_string())?;
                ser(crate::commands::motif_authoring::delete_motif(self, a.id).await)
            }
            #[cfg(feature = "motifs")]
            "motif_staleness_report" => ser(crate::commands::motif_authoring::motif_staleness_report(self).await),
            #[cfg(feature = "motifs")]
            "acknowledge_motif_staleness" => ser(crate::commands::motif_authoring::acknowledge_motif_staleness(self).await),
            other => Err(format!("unavailable: '{other}' is wired in a later stage (S3/S4/S5)")),
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
    /// Polls every 5 ms so the test exits early on fast machines and only
    /// reaches the ceiling on genuine failure.
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

    #[tokio::test]
    async fn project_summary_on_blank_project() {
        let sink = VecEventSink::new();
        let b = Backend::new_for_test(Arc::new(sink.clone()));
        b.init().await.unwrap();
        let json = b.dispatch("project_summary", "{}").await.unwrap();
        assert!(json.contains("\"track_count\""));
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_after_add_track_restores_baseline() {
        let sink = VecEventSink::new();
        let b = Backend::new_for_test(Arc::new(sink));
        b.init().await.unwrap();
        // Capture baseline track count (blank project = 2 reserved A/B-roll tracks).
        let before_json = b.dispatch("project_summary", "{}").await.unwrap();
        let before: serde_json::Value = serde_json::from_str(&before_json).unwrap();
        let baseline = before["track_count"].as_u64().expect("track_count must be present") as usize;
        // Add one track → baseline + 1.
        b.dispatch("add_track", "{}").await.unwrap();
        let after_json = b.dispatch("project_summary", "{}").await.unwrap();
        let after: serde_json::Value = serde_json::from_str(&after_json).unwrap();
        assert_eq!(after["track_count"].as_u64().unwrap() as usize, baseline + 1);
        // Undo → back to baseline.
        b.dispatch("project_undo", "{}").await.unwrap();
        let undone_json = b.dispatch("project_summary", "{}").await.unwrap();
        let undone: serde_json::Value = serde_json::from_str(&undone_json).unwrap();
        assert_eq!(undone["track_count"].as_u64().unwrap() as usize, baseline);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_track_then_summary_grows_and_emits() {
        let sink = VecEventSink::new();
        let b = Backend::new_for_test(Arc::new(sink.clone()));
        b.init().await.unwrap();
        let track_id_json = b.dispatch("add_track", "{}").await.unwrap();
        assert!(!track_id_json.is_empty());
        // poll until the broadcast bridge task fires (or 2 s timeout on genuine failure)
        assert!(wait_for_event(&sink, "project:changed", 2000).await);
        let summary = b.dispatch("project_summary", "{}").await.unwrap();
        // blank project has 2 reserved tracks (A roll + B roll); add_track appends a 3rd
        assert!(summary.contains("\"track_count\":3") || summary.contains("\"track_count\": 3"));
    }

    /// S2 persistence round-trip: backend A adds a track and `save_as` to a
    /// `.vproj` dir; a FRESH backend B `open`s it and must observe the same
    /// post-add track count. Multi-thread flavor so the actor→UI bridge +
    /// LogBus writer tasks can run on a worker while we await dispatches.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn save_as_then_open_round_trips_and_logs() {
        let dir = std::env::temp_dir()
            .join(format!("weftcut-s2-{}-{}", std::process::id(), "roundtrip"));
        std::fs::remove_dir_all(&dir).ok();
        let proj = dir.join("proj.vproj");

        // Backend A: add a track, capture the count, then save-as.
        let sink = VecEventSink::new();
        let b = Backend::new_for_test(Arc::new(sink.clone()));
        b.init().await.unwrap();
        b.dispatch("add_track", "{}").await.unwrap();
        let a_summary = b.dispatch("project_summary", "{}").await.unwrap();
        let a: serde_json::Value = serde_json::from_str(&a_summary).unwrap();
        let a_count = a["track_count"].as_u64().expect("track_count present");
        b.dispatch(
            "project_save_as",
            &format!("{{\"path\":{:?}}}", proj.to_string_lossy()),
        )
        .await
        .unwrap();

        // A fresh backend B opens it and must match A's post-add count.
        let b2 = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b2.init().await.unwrap();
        b2.dispatch(
            "project_open",
            &format!("{{\"path\":{:?}}}", proj.to_string_lossy()),
        )
        .await
        .unwrap();
        let summary = b2.dispatch("project_summary", "{}").await.unwrap();
        let s: serde_json::Value = serde_json::from_str(&summary).unwrap();
        assert_eq!(
            s["track_count"].as_u64().expect("track_count present"),
            a_count,
            "opened project must have the same track count as the saved one",
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A 1×1 PNG (67 bytes) — imports as MediaKind::Image, so no ffmpeg job runs.
    #[cfg(feature = "jobs")]
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
        0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
        0x42, 0x60, 0x82,
    ];

    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn import_media_adds_to_pool_and_returns_id() {
        let sink = crate::events::VecEventSink::new();
        let b = Backend::new_for_test(std::sync::Arc::new(sink.clone()));
        b.init().await.unwrap();

        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("pixel.png");
        std::fs::write(&png, TINY_PNG).unwrap();

        let args = serde_json::json!({ "path": png.to_string_lossy() }).to_string();
        let id_json = b.dispatch("import_media", &args).await.unwrap();
        let media_id: String = serde_json::from_str(&id_json).unwrap();
        assert!(!media_id.is_empty(), "import_media returns a media id");

        let summary = b.dispatch("project_summary", "{}").await.unwrap();
        assert!(summary.contains(&media_id), "the new media id appears in project_summary");
    }

    #[cfg(feature = "jobs")]
    #[tokio::test]
    async fn get_waveform_peaks_unknown_media_errors() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
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
    /// An empty patch `{}` is a valid `AppSettingsPatch` (all fields optional)
    /// and is enough to exercise the emit path.
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
    async fn mcp_catalog_lists_ping_and_add_track() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let cat = b.mcp_catalog().await.unwrap();
        assert!(cat.contains("\"ping\""));
        assert!(cat.contains("\"add_track\""));
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

    #[cfg(feature = "mcp")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mcp_call_tool_add_track_grows_summary() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let before: serde_json::Value =
            serde_json::from_str(&b.dispatch("project_summary", "{}").await.unwrap()).unwrap();
        let baseline = before["track_count"].as_u64().unwrap();
        let reply: serde_json::Value =
            serde_json::from_str(&b.mcp_call_tool("add_track".into(), "{}".into()).await.unwrap()).unwrap();
        assert_eq!(reply["ok"], true, "got {reply}");
        let after: serde_json::Value =
            serde_json::from_str(&b.dispatch("project_summary", "{}").await.unwrap()).unwrap();
        assert_eq!(after["track_count"].as_u64().unwrap(), baseline + 1);
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

    /// S2 deferred cleanup: a `log_emit` dispatch after a workspace is installed
    /// must reach the EventSink as a `log:entry` event. The LogBus bridge is
    /// async (broadcast → sink), so we poll until the event appears.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn logged_action_after_workspace_emits_log_entry() {
        let sink = VecEventSink::new();
        let b = Backend::new_for_test(Arc::new(sink.clone()));
        b.init().await.unwrap();
        // Install a workspace (save_as) so the LogBus slot is live, then emit a log.
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("p.vproj");
        b.dispatch(
            "project_save_as",
            &serde_json::json!({ "path": proj.to_string_lossy() }).to_string(),
        )
        .await
        .unwrap();
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
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_motif_arm_places_a_layer() {
        let b = Backend::new_for_test(Arc::new(VecEventSink::new()));
        b.init().await.unwrap();
        let out = b
            .invoke("add_motif".into(), r#"{"motifId":"countdown","tStartUs":0}"#.into())
            .await
            .unwrap();
        assert!(!out.is_empty()); // returns the new layer id
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
        // Bogus layer id, but the no-provider check fires before layer lookup
        // resolves to a transcribe — either way the reply is ok:false.
        let reply: serde_json::Value = serde_json::from_str(
            &b.mcp_call_tool("transcribe_clip".into(), r#"{"layer_id":"00000000-0000-0000-0000-000000000000"}"#.into())
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(reply["ok"], false);
    }
}
