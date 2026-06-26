//! Prefs/settings/recents/keybindings/logs/agent commands — re-signed
//! from `commands_legacy.rs`. Bodies are copied verbatim; only the signature
//! changes (the napi `Backend` carries the managed state) and the managed-state
//! side effects are re-pointed at the matching `Backend` fields.

use std::path::PathBuf;

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

// ---- Recents ------------------------------------------------------------

pub async fn recents_list(
    backend: &Backend,
) -> Result<Vec<crate::recents::RecentEntry>, String> {
    backend.recents.list().map_err(|e| format!("{e:#}"))
}

pub async fn recents_remove(backend: &Backend, path: String) -> Result<(), String> {
    backend
        .recents
        .remove(&PathBuf::from(path))
        .map_err(|e| format!("{e:#}"))
}

pub async fn recents_get_reopen_on_launch(backend: &Backend) -> Result<bool, String> {
    backend.recents.reopen_on_launch().map_err(|e| format!("{e:#}"))
}

pub async fn recents_set_reopen_on_launch(backend: &Backend, value: bool) -> Result<(), String> {
    backend
        .recents
        .set_reopen_on_launch(value)
        .map_err(|e| format!("{e:#}"))
}

/// Returns the most recent workspace, if any. Used by the startup screen
/// on boot: when `reopen_on_launch` is enabled, the UI calls this and
/// immediately fires `project_open` on the result.
pub async fn recents_most_recent(
    backend: &Backend,
) -> Result<Option<crate::recents::RecentEntry>, String> {
    backend.recents.most_recent().map_err(|e| format!("{e:#}"))
}

/// Parent folder of the last project the user created via "+ New project".
/// `null` on first launch — the UI falls back to OS Documents.
pub async fn recents_last_new_project_parent(
    backend: &Backend,
) -> Result<Option<String>, String> {
    backend
        .recents
        .last_new_project_parent()
        .map(|opt| opt.map(|p| p.to_string_lossy().to_string()))
        .map_err(|e| format!("{e:#}"))
}

// ---- Keybindings --------------------------------------------------------

pub async fn keybindings_get(
    backend: &Backend,
) -> Result<crate::keybindings::KeybindingsMap, String> {
    backend.keybindings.get().map_err(|e| format!("{e:#}"))
}

pub async fn keybindings_set(
    backend: &Backend,
    action: String,
    keys: Vec<String>,
) -> Result<(), String> {
    backend.keybindings.set(action, keys).map_err(|e| format!("{e:#}"))
}

pub async fn keybindings_reset_all(backend: &Backend) -> Result<(), String> {
    backend.keybindings.reset_all().map_err(|e| format!("{e:#}"))
}

pub async fn keybindings_export(backend: &Backend, dest: String) -> Result<(), String> {
    backend
        .keybindings
        .export_to(PathBuf::from(dest))
        .map_err(|e| format!("{e:#}"))
}

pub async fn keybindings_import(
    backend: &Backend,
    src: String,
) -> Result<crate::keybindings::KeybindingsMap, String> {
    backend
        .keybindings
        .import_from(&PathBuf::from(src))
        .map_err(|e| format!("{e:#}"))
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

/// `recents_remove` — `{ path: String }`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentsRemoveArgs {
    pub path: String,
}

/// `recents_set_reopen_on_launch` — `{ value: bool }`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentsSetReopenOnLaunchArgs {
    pub value: bool,
}

/// `keybindings_set` — `{ action: String, keys: Vec<String> }`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsSetArgs {
    pub action: String,
    pub keys: Vec<String>,
}

/// `keybindings_export` — `{ dest: String }`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsExportArgs {
    pub dest: String,
}

/// `keybindings_import` — `{ src: String }`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsImportArgs {
    pub src: String,
}

/// `log_emit` — `{ input: LogEntryInput }`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEmitArgs {
    pub input: crate::logs::LogEntryInput,
}
