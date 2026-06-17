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
    pub(crate) workspace: WorkspaceSlot,
    pub(crate) agent_session: AgentSessionSlot,
    pub(crate) log_slot: LogBusSlot,
    pub(crate) config_dir: String,
    pub(crate) cache_dir: String,
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
        workspace: WorkspaceSlot::new(),
        agent_session: AgentSessionSlot::new(),
        log_slot,
        config_dir,
        cache_dir,
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
        let bridge_handle = handle.clone();
        let events = self.events.clone();
        let log_slot = self.log_slot.clone();
        tokio::spawn(async move {
            use tokio::sync::broadcast::error::RecvError;
            let mut rx = bridge_handle.subscribe();
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

        Ok(())
    }

    #[napi]
    pub async fn invoke(&self, cmd: String, args_json: String) -> napi::Result<String> {
        self.dispatch(&cmd, &args_json).await.map_err(Error::from_reason)
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
        // small delay for the broadcast bridge task to run
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(sink.names().iter().any(|n| n == "project:changed"));
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
}
