//! Persistence commands — save / save-as / open / new-workspace. The napi
//! `Backend` carries the managed state these mutate.
//!
//! These are the heaviest commands in the surface: a workspace change installs
//! (rotates) the per-workspace `LogBus`, re-points the cache at
//! `<workspace>/Cache/`, pushes the recents entry, and resets any in-flight
//! agent session.

use std::path::PathBuf;

use crate::io;
use crate::napi_backend::Backend;
use crate::state::{self, Actor, CommandError};
use crate::state::time::Rational;

/// Force-flush autosave to disk for the current workspace. Safe to call
/// unconditionally — if no workspace is set yet (the unreachable blank-boot
/// window, in practice), `force_flush` is a no-op that just resolves.
pub async fn project_save(backend: &Backend) -> Result<(), String> {
    backend.autosave()?.force_flush().await.map_err(|e| format!("{e:#}"))
}

pub async fn project_save_as(backend: &Backend, path: String) -> Result<(), String> {
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let path = PathBuf::from(path);
    io::save_to_dir(&snap, &path)
        .await
        .map_err(|e| format!("{e:#}"))?;
    // Every save-as/open re-points the cache at `<workspace>/Cache/`: from here
    // on, proxies/thumbnails/waveforms/preview renders land inside the
    // workspace folder, not the OS app-cache. See docs/data-model.md.
    backend
        .cache
        .set_workspace(&path)
        .map_err(|e| format!("cache set_workspace: {e:#}"))?;
    backend.workspace.set(path.clone());
    // Workspace change resets any in-flight agent session — view mode
    // doesn't survive across project switches.
    let _ = crate::agent_session::end_and_emit(&*backend.events, &backend.agent_session);
    // Install (or rotate) the LogBus for this workspace. Replaces any
    // prior bus; the old writer task drains + exits on mpsc-close.
    backend
        .log_slot
        .install(crate::logs::LogBus::spawn(&path, backend.events.clone()));
    backend.recents.push(path, snap.metadata.name.clone());
    Ok(())
}

pub async fn project_open(backend: &Backend, path: String) -> Result<(), String> {
    let handle = backend.project()?;
    let path = PathBuf::from(path);
    // Pre-checks so we can produce typed sentinels for the two common
    // failure modes. Without these the raw anyhow chain bubbles up an
    // OS-localized `read <path>/project.json: <NLS-translated 'file not
    // found' message> (os error 2)` which the user can't make sense of.
    // The frontend matches the sentinels and renders localized messages;
    // other errors flow through unchanged so the detail is still visible
    // for unexpected failures. Order matters: a recents entry whose whole
    // folder was moved or deleted must read "folder is gone" (and get
    // dropped from the list), not "isn't a WeftCut project".
    if !path.exists() {
        return Err("PROJECT_FOLDER_MISSING".to_string());
    }
    if !path.join(io::PROJECT_FILE).exists() {
        return Err("NOT_PROJECT_FOLDER".to_string());
    }
    let project = io::load_from_dir(&path)
        .await
        .map_err(|e| format!("{e:#}"))?;
    // Re-point cache + workspace before broadcasting the state swap, so any
    // consumers that react to `project:changed` and immediately ask for
    // derivative paths or resolved media paths see the workspace, not the
    // boot fallback.
    backend
        .cache
        .set_workspace(&path)
        .map_err(|e| format!("cache set_workspace: {e:#}"))?;
    backend.workspace.set(path.clone());
    let _ = crate::agent_session::end_and_emit(&*backend.events, &backend.agent_session);
    // Install (or rotate) the LogBus rooted at this workspace's Logs/.
    backend
        .log_slot
        .install(crate::logs::LogBus::spawn(&path, backend.events.clone()));
    let display_name = project.metadata.name.clone();
    handle
        .replace_state(Actor::User, project)
        .await
        .map_err(|e: CommandError| e.to_string())?;
    backend.recents.push(path, display_name);

    // Re-fan-out background derivative jobs for every media item, to regenerate
    // proxies / thumbnails / waveforms missing or stale after `load_from_dir`.
    #[cfg(feature = "jobs")]
    {
        let snap = handle.snapshot().await;
        for item in snap.media_pool.values() {
            crate::jobs::enqueue_for_media(
                backend.events.clone(),
                backend.cache.clone(),
                handle.clone(),
                item.clone(),
            );
        }
    }

    Ok(())
}

/// Create a brand-new workspace at `<parent_folder>/<name>/` with the given
/// composition preset, replace the actor's state with a fresh blank
/// project, and write it to disk. Used by the startup screen's "+ New
/// project" form. This is the canonical way to start a new project. See
/// docs/data-model.md ("On-disk format: workspace folder").
#[allow(clippy::too_many_arguments)]
pub async fn project_new_workspace(
    backend: &Backend,
    parent_folder: String,
    name: String,
    width: u32,
    height: u32,
    fps_num: u32,
    fps_den: u32,
) -> Result<String, String> {
    let handle = backend.project()?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("project name is required".into());
    }
    if width == 0 || height == 0 || fps_num == 0 || fps_den == 0 {
        return Err("invalid canvas preset".into());
    }
    let parent_path = PathBuf::from(&parent_folder);
    let target = parent_path.join(trimmed);
    if target.exists() {
        // Either it's an old workspace we'd clobber, or just a folder the
        // user already picked. Refuse — startup screen flows route the
        // user to "Open" if the folder is a valid `.vproj`.
        return Err(format!("folder already exists: {}", target.display()));
    }

    let mut project = state::Project::new_blank(trimmed);
    project.composition.width = width;
    project.composition.height = height;
    project.composition.fps = Rational::new(fps_num, fps_den);

    io::save_to_dir(&project, &target)
        .await
        .map_err(|e| format!("save new workspace: {e:#}"))?;
    backend
        .cache
        .set_workspace(&target)
        .map_err(|e| format!("cache set_workspace: {e:#}"))?;
    backend.workspace.set(target.clone());
    let _ = crate::agent_session::end_and_emit(&*backend.events, &backend.agent_session);
    backend
        .log_slot
        .install(crate::logs::LogBus::spawn(&target, backend.events.clone()));

    let display_name = project.metadata.name.clone();
    handle
        .replace_state(Actor::User, project)
        .await
        .map_err(|e: CommandError| e.to_string())?;
    backend.recents.push(target.clone(), display_name);
    // Remember the parent folder so the next "+ New project" form opens
    // pre-filled at the same location. Best-effort; failures are logged
    // inside the setter but don't surface here.
    backend.recents.set_last_new_project_parent(parent_path);
    Ok(target.to_string_lossy().to_string())
}
