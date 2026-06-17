//! Prefs/settings/recents/keybindings/logs/agent commands — re-signed
//! from `commands_legacy.rs`. Bodies are copied verbatim; only the signature
//! changes (Backend replaces Tauri State + AppHandle) and the managed-state
//! side effects are re-pointed at the matching `Backend` fields.

use std::path::PathBuf;

use crate::napi_backend::Backend;
use crate::state::{Actor, CommandError, ProjectSettings, ProjectSettingsPatch};

// ---- ping ---------------------------------------------------------------

pub fn ping() -> &'static str {
    "pong"
}

// ---- Project settings ---------------------------------------------------

pub async fn get_project_settings(backend: &Backend) -> Result<ProjectSettings, String> {
    let handle = backend.project()?;
    Ok(handle.snapshot().await.settings.clone())
}

/// Preference-shaped (not editing-shaped): applied to every history
/// snapshot and not recorded, so undo never flips a settings toggle.
pub async fn update_project_settings(
    backend: &Backend,
    patch: ProjectSettingsPatch,
) -> Result<(), String> {
    let handle = backend.project()?;
    handle
        .update_project_settings(Actor::User, patch)
        .await
        .map_err(|e: CommandError| e.to_string())
}

// ---- App-level settings -------------------------------------------------

pub async fn app_settings_get(
    backend: &Backend,
) -> Result<crate::app_settings::AppSettings, String> {
    Ok(backend.app_settings.get())
}

pub async fn app_settings_set(
    backend: &Backend,
    patch: crate::app_settings::AppSettingsPatch,
) -> Result<crate::app_settings::AppSettings, String> {
    let after = backend.app_settings.apply(patch).map_err(|e| format!("{e:#}"))?;
    backend.events.emit(
        "app_settings:changed",
        serde_json::to_value(&after).unwrap_or(serde_json::Value::Null),
    );
    Ok(after)
}

// ---- View state (per-workspace) -----------------------------------------

pub async fn view_state_get(
    backend: &Backend,
) -> Result<crate::view_state::ViewState, String> {
    let Some(ws) = backend.workspace.current() else {
        return Ok(crate::view_state::ViewState::default());
    };
    Ok(crate::view_state::load(&ws))
}

pub async fn view_state_set(
    backend: &Backend,
    state: crate::view_state::ViewState,
) -> Result<(), String> {
    let Some(ws) = backend.workspace.current() else {
        // Pre-workspace: silently drop. Once the user does a Save As,
        // the next debounced write will land in the new workspace.
        return Ok(());
    };
    crate::view_state::save(&ws, &state).map_err(|e| format!("{e:#}"))
}

// ---- Export settings (per-workspace) ------------------------------------

pub async fn export_settings_get(
    backend: &Backend,
) -> Result<Option<serde_json::Value>, String> {
    let Some(ws) = backend.workspace.current() else {
        return Ok(None);
    };
    Ok(crate::export_settings_store::load(&ws))
}

pub async fn export_settings_set(
    backend: &Backend,
    settings: serde_json::Value,
) -> Result<(), String> {
    let Some(ws) = backend.workspace.current() else {
        // Pre-workspace (blank-on-boot): silently drop, like view_state_set.
        return Ok(());
    };
    crate::export_settings_store::save(&ws, &settings).map_err(|e| format!("{e:#}"))
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

/// User-side "Exit to editor" handler. Always allowed — even with a
/// lock or in-flight ops. Releases the revert lock so the user can
/// immediately undo/restore once back in editor mode.
pub async fn agent_session_end(backend: &Backend) -> Result<(), String> {
    let prior = crate::agent_session::end_and_emit(&*backend.events, &backend.agent_session);
    // Release any agent-taken revert lock so the human's editor-mode
    // Undo / Restore buttons re-enable on the next paint.
    let handle = backend.project()?;
    handle.unlock_history().await;
    if let Some(s) = prior {
        // System-attributed entry so the record panel — already
        // closed by the time this lands — and the full LogConsole
        // both surface the transition.
        backend.log_slot.emit(crate::logs::LogEntryInput {
            level: crate::logs::LogLevel::Info,
            category: crate::logs::LogCategory::System,
            source: crate::logs::LogSource::System,
            message: format!(
                "User exited agent mode (session client={} reason={})",
                s.client, s.reason,
            ),
            ..Default::default()
        });
    }
    Ok(())
}

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

/// `app_settings_set` — `{ patch: AppSettingsPatch }` (camelCase; matches
/// the TS `invoke("app_settings_set", { patch })` call site in `ipc/index.ts`).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsSetArgs {
    pub patch: crate::app_settings::AppSettingsPatch,
}

/// `update_project_settings` — `{ patch: ProjectSettingsPatch }`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectSettingsArgs {
    pub patch: crate::state::ProjectSettingsPatch,
}

/// `view_state_set` — `{ state: ViewState }`. No TS wrapper found that
/// would use a different key, so "state" matches the legacy param name.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewStateSetArgs {
    pub state: crate::view_state::ViewState,
}

/// `export_settings_set` — `{ settings: Value }`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettingsSetArgs {
    pub settings: serde_json::Value,
}

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
