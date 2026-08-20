//! Prefs/settings/logs/agent commands. Owns: ping, workspace_dir, agent_session_get,
//! log_list/clear/emit/dir_path. Config stores (keybindings, recents, app_settings,
//! view_state, export_settings) are TS-owned; the Rust compute paths live
//! in `commands/media.rs` and `commands/export.rs`.

use crate::napi_backend::Backend;

// ---- ping ---------------------------------------------------------------

pub fn ping() -> &'static str {
    "pong"
}

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

// ---- Logs ---------------------------------------------------------------

pub async fn log_list(backend: &Backend) -> Result<Vec<crate::logs::LogEntry>, String> {
    Ok(backend
        .log_slot
        .current()
        .map(|b| b.list())
        .unwrap_or_default())
}

pub async fn log_clear(backend: &Backend) -> Result<(), String> {
    if let Some(bus) = backend.log_slot.current() {
        bus.clear();
        // The marker becomes the cleared ring's first row: an empty console
        // must be distinguishable from "nothing has happened", and the JSONL
        // (which `clear` never truncates) keeps when history was cut short
        // deliberately.
        bus.emit(crate::logs::LogEntryInput {
            level: crate::logs::LogLevel::Info,
            category: crate::logs::LogCategory::System,
            source: crate::logs::LogSource::User,
            message: "Log cleared".into(),
            i18n_key: Some("log.cleared".into()),
            ..Default::default()
        });
    }
    Ok(())
}

pub async fn log_emit(backend: &Backend, input: crate::logs::LogEntryInput) -> Result<(), String> {
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
