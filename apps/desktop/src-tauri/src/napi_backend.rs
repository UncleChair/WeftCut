//! `Backend` — the napi entry point. Holds the actor handle + managed stores,
//! exposes a single `invoke` dispatcher and an `init` that spawns the actor and
//! the actor→UI event bridge.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

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

    /// Plain (non-napi) constructor for tests: roots config + cache in a
    /// process-unique temp dir and runs the identical store/tracing setup as
    /// the napi `new`. No `ThreadsafeFunction` / napi env required.
    #[cfg(test)]
    pub fn new_for_test(events: Arc<dyn EventSink>) -> Self {
        let base = std::env::temp_dir().join(format!("weftcut-test-{}", std::process::id()));
        let config_dir = base.join("config").to_string_lossy().to_string();
        let cache_dir = base.join("cache").to_string_lossy().to_string();
        build_backend(events, config_dir, cache_dir)
    }

    pub async fn dispatch(&self, cmd: &str, _args: &str) -> std::result::Result<String, String> {
        match cmd {
            "ping" => Ok(serde_json::to_string("pong").unwrap()),
            "project_summary" => ser(crate::commands::query::project_summary(self).await),
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
}
