//! Prefs/settings/logs/agent commands — re-signed from `commands_legacy.rs`.
//! Bodies are copied verbatim; only the signature changes (the napi `Backend`
//! carries the managed state) and the managed-state side effects are re-pointed
//! at the matching `Backend` fields.
//! Keybindings moved to TS (src/main/keybindings.ts; native/src/keybindings.rs deleted).
//! Recents moved to TS (src/main/recents.ts; native/src/recents.rs deleted).

use crate::napi_backend::Backend;

// ---- ping ---------------------------------------------------------------

pub fn ping() -> &'static str {
    "pong"
}

// Project-settings get/update + agent_session_end were renderer-fallback
// wrappers over the deleted Rust actor; under the always-on TS host the
// renderer routes `get_project_settings`/`update_project_settings`/
// `agent_session_end` to the TS actor, so these are gone (Phase 4b).

// ---- Workspace dir -------------------------------------------------------

/// Absolute path of the current workspace (= project) directory, or null when
/// no project is open (blank-on-boot, pre-Save-As). The export dialog uses it
/// to default the output location to `<workspace>/output`.
pub async fn workspace_dir(backend: &Backend) -> Result<Option<String>, String> {
    Ok(backend
        .workspace
        .current()
        .map(|p| p.to_string_lossy().into_owned()))
}

// ---- Agent session -------------------------------------------------------

pub async fn agent_session_get(
    backend: &Backend,
) -> Result<Option<crate::agent_session::AgentSession>, String> {
    Ok(backend.agent_session.current())
}

// `agent_session_end` (the user-side "Exit to editor" handler) routed through
// the deleted actor's `unlock_history`; the TS host now owns the
// `agentSessionEnd` seam (endSlot + unlockHistory), so it's gone (Phase 4b).

// ---- Logs ---------------------------------------------------------------

pub async fn log_list(
    backend: &Backend,
) -> Result<Vec<crate::logs::LogEntry>, String> {
    Ok(backend.log_slot.current().map(|b| b.list()).unwrap_or_default())
}

pub async fn log_clear(backend: &Backend) -> Result<(), String> {
    if let Some(bus) = backend.log_slot.current() {
        bus.clear();
    }
    Ok(())
}

pub async fn log_emit(
    backend: &Backend,
    input: crate::logs::LogEntryInput,
) -> Result<(), String> {
    backend.log_slot.emit(input);
    Ok(())
}

/// Absolute path to the current workspace's `Logs/` directory, or
/// `None` pre-workspace. The frontend's "Open log folder" action
/// passes this string to `shell.open(...)` so the OS file manager
/// reveals it.
pub async fn log_dir_path(backend: &Backend) -> Result<Option<String>, String> {
    Ok(backend
        .workspace
        .current()
        .map(|p| p.join("Logs").to_string_lossy().to_string()))
}

// ---- Args structs -------------------------------------------------------

/// `log_emit` — `{ input: LogEntryInput }`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEmitArgs {
    pub input: crate::logs::LogEntryInput,
}
