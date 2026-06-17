//! `Backend` — the napi entry point. Holds the actor handle + managed stores,
//! exposes a single `invoke` dispatcher and an `init` that spawns the actor and
//! the actor→UI event bridge.

use std::sync::{Arc, OnceLock};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use serde::Serialize;

use crate::events::{EventSink, TsfnEventSink};
use crate::state::{self, ProjectHandle};

#[napi]
pub struct Backend {
    events: Arc<dyn EventSink>,
    project: OnceLock<ProjectHandle>,
    config_dir: String,
    cache_dir: String,
    // Stores/slots added as their command groups land (Tasks 3-7):
    // recents, keybindings, app_settings, cache, workspace, agent_session,
    // log_slot, autosave.
}

#[napi]
impl Backend {
    #[napi(constructor)]
    pub fn new(app_config_dir: String, app_cache_dir: String, on_event: ThreadsafeFunction<String>) -> Self {
        let events: Arc<dyn EventSink> = Arc::new(TsfnEventSink::new(on_event));
        Backend {
            events,
            project: OnceLock::new(),
            config_dir: app_config_dir,
            cache_dir: app_cache_dir,
        }
    }

    /// Spawn the actor + bridge. Must be awaited once before any `invoke`.
    /// Runs inside napi's tokio runtime, so `tokio::spawn` has a runtime.
    #[napi]
    pub async fn init(&self) -> napi::Result<()> {
        let handle = state::spawn(state::Project::new_blank("untitled"));
        self.project.set(handle).map_err(|_| Error::from_reason("init called twice"))?;
        // The project:changed bridge is wired in Task 3 once query/summary exists.
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
    fn project(&self) -> std::result::Result<&ProjectHandle, String> {
        self.project.get().ok_or_else(|| "backend not initialized".to_string())
    }

    pub async fn dispatch(&self, cmd: &str, _args: &str) -> std::result::Result<String, String> {
        match cmd {
            "ping" => Ok(serde_json::to_string("pong").unwrap()),
            other => Err(format!("unavailable: '{other}' is wired in a later stage (S3/S4/S5)")),
        }
    }
}

/// Serialize a typed command result into the dispatcher's JSON-string contract.
pub(crate) fn ser<T: Serialize>(r: std::result::Result<T, String>) -> std::result::Result<String, String> {
    r.and_then(|v| serde_json::to_string(&v).map_err(|e| e.to_string()))
}
