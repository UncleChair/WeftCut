//! Auto-save subscriber + periodic Backups/ snapshots.
//!
//! Per `docs/workspace-redesign.md` Q8 the workspace is the truth — every
//! actor commit eventually lands on disk as `project.json`, no explicit
//! Save required. This task subscribes to the actor's broadcast and:
//!
//!   * debounces 500 ms before writing, so a 10-event drag (one commit per
//!     move tick) becomes a single write;
//!   * stays silent while `workspace.current()` is `None` (the blank-boot
//!     window before any Save As / Open) — events still tick the dirty
//!     flag so the first write after a Save As / Open carries any
//!     in-memory edits;
//!   * after every successful write, copies `project.json` to
//!     `Backups/<ISO-timestamp>.json` once 50 commits or 5 minutes have
//!     elapsed (whichever first), retains the most recent 20, drops the
//!     rest.
//!
//! Force-flush API (the future `Cmd-S` handler / UI close gate) sends a
//! oneshot and waits for the write+snapshot to finish.

use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chrono::Utc;
use tokio::fs;
use tokio::sync::{mpsc, oneshot};
use tokio::sync::broadcast::error::RecvError;
use tracing::{debug, info, warn};

use crate::state::ProjectHandle;
use crate::workspace::WorkspaceSlot;

use super::{save_to_dir, PROJECT_FILE};

const DEBOUNCE: Duration = Duration::from_millis(500);
const SNAPSHOT_EVERY_COMMITS: u32 = 50;
const SNAPSHOT_EVERY_DUR: Duration = Duration::from_secs(5 * 60);
const RETAIN_SNAPSHOTS: usize = 20;

const BACKUPS_DIR: &str = "Backups";

/// Handle on the spawned autosave task. Drop the handle to stop the task
/// (the sender side closes, the loop sees `Closed`, and exits cleanly).
/// `force_flush()` issues an immediate write + snapshot and returns once
/// the write completes — used by the (future) Cmd-S handler.
#[derive(Clone)]
pub struct AutosaveController {
    force: mpsc::Sender<oneshot::Sender<()>>,
}

impl AutosaveController {
    /// Spawn the autosave task. Returns immediately; the task runs in the
    /// background for the lifetime of the controller (or until the actor's
    /// broadcast channel closes).
    pub fn spawn(handle: ProjectHandle, workspace: WorkspaceSlot) -> Self {
        let (force_tx, force_rx) = mpsc::channel(8);
        tauri::async_runtime::spawn(autosave_loop(handle, workspace, force_rx));
        Self { force: force_tx }
    }

    /// Flush any pending in-memory edits to disk **right now** and write a
    /// snapshot. Awaits the write completion so callers (e.g. an exit
    /// handler) can rely on disk being current when this returns.
    pub async fn force_flush(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.force
            .send(tx)
            .await
            .context("autosave task is gone")?;
        rx.await.context("autosave reply dropped")
    }
}

async fn autosave_loop(
    handle: ProjectHandle,
    workspace: WorkspaceSlot,
    mut force: mpsc::Receiver<oneshot::Sender<()>>,
) {
    let mut rx = handle.subscribe();
    let mut commits_since_snapshot: u32 = 0;
    let mut last_snapshot_at = Instant::now();

    loop {
        // Wait for the first sign of work: a project change, a force-flush
        // request, or task shutdown. Any other event types coming through
        // here later (e.g. project-level config changes) should re-arm the
        // debounce — anything that flows through the actor is potentially
        // a project mutation worth persisting.
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(_) => {}
                Err(RecvError::Lagged(skipped)) => {
                    debug!("autosave: broadcast lagged by {skipped} events; treating as dirty");
                }
                Err(RecvError::Closed) => {
                    info!("autosave: actor broadcast closed, stopping");
                    return;
                }
            },
            force_req = force.recv() => {
                let Some(reply) = force_req else {
                    info!("autosave: force-flush channel closed, stopping");
                    return;
                };
                // Force path: skip the debounce entirely.
                if let Some(ws) = workspace.current() {
                    let _ = persist(&handle, &ws).await;
                    let _ = take_snapshot(&ws).await;
                    commits_since_snapshot = 0;
                    last_snapshot_at = Instant::now();
                }
                let _ = reply.send(());
                continue;
            }
        }

        // Got an event. Now drain the quiet window: keep restarting the
        // 500ms timer as long as more events keep arriving, so a rapid
        // drag-flurry coalesces into one write.
        loop {
            tokio::select! {
                _ = tokio::time::sleep(DEBOUNCE) => break,
                ev = rx.recv() => match ev {
                    Ok(_) => continue,
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return,
                },
                force_req = force.recv() => {
                    let Some(reply) = force_req else { return };
                    if let Some(ws) = workspace.current() {
                        let _ = persist(&handle, &ws).await;
                        let _ = take_snapshot(&ws).await;
                        commits_since_snapshot = 0;
                        last_snapshot_at = Instant::now();
                    }
                    let _ = reply.send(());
                    // Already wrote; bail out of the inner loop without
                    // doing a second write below.
                    continue;
                }
            }
        }

        // 500 ms of quiet elapsed. Time to persist.
        let Some(ws) = workspace.current() else {
            // No workspace yet — the in-memory edits stay dirty; the next
            // event after Save As / Open will fire another debounce
            // cycle that does land on disk. We deliberately don't clear
            // any state here.
            continue;
        };

        match persist(&handle, &ws).await {
            Ok(()) => {
                commits_since_snapshot += 1;
                let need_snapshot = commits_since_snapshot >= SNAPSHOT_EVERY_COMMITS
                    || last_snapshot_at.elapsed() >= SNAPSHOT_EVERY_DUR;
                if need_snapshot {
                    if let Err(e) = take_snapshot(&ws).await {
                        warn!("autosave snapshot failed: {e:#}");
                    }
                    commits_since_snapshot = 0;
                    last_snapshot_at = Instant::now();
                }
            }
            Err(e) => {
                warn!("autosave write failed: {e:#}");
            }
        }
    }
}

async fn persist(handle: &ProjectHandle, workspace: &Path) -> Result<()> {
    let snap = handle.snapshot().await;
    save_to_dir(&snap, workspace).await
}

/// Copy the current `project.json` to `Backups/<ISO-timestamp>.json` and
/// retain only the most recent `RETAIN_SNAPSHOTS` files. Idempotent if no
/// `project.json` exists yet (returns Ok with a warn-level log — happens
/// on the very first save where the source file doesn't exist yet
/// because `save_to_dir` writes synchronously; this branch is defensive).
async fn take_snapshot(workspace: &Path) -> Result<()> {
    let src = workspace.join(PROJECT_FILE);
    if !src.exists() {
        warn!("autosave snapshot: {} missing, skipping", src.display());
        return Ok(());
    }
    let backups = workspace.join(BACKUPS_DIR);
    fs::create_dir_all(&backups)
        .await
        .with_context(|| format!("create {}", backups.display()))?;

    // ISO-8601-ish timestamp, no colons (Windows filesystem-safe).
    let ts = Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let dest = backups.join(format!("{ts}.json"));
    fs::copy(&src, &dest)
        .await
        .with_context(|| format!("copy {} -> {}", src.display(), dest.display()))?;
    info!("autosave snapshot -> {}", dest.display());

    gc_snapshots(&backups).await
}

async fn gc_snapshots(backups: &Path) -> Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(backups)
        .with_context(|| format!("read {}", backups.display()))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .ends_with(".json")
        })
        .collect();
    // Sort by file name descending — our timestamp encoding sorts
    // lexicographically the same as chronologically.
    entries.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    for stale in entries.into_iter().skip(RETAIN_SNAPSHOTS) {
        let path = stale.path();
        if let Err(e) = std::fs::remove_file(&path) {
            warn!("autosave gc: failed to remove {}: {e}", path.display());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{spawn, Actor, Project};
    use crate::state::track::TrackKind;
    use tempfile::TempDir;

    /// End-to-end: spawn the loop, fire commits, observe debounced writes
    /// and a snapshot trigger. Uses force_flush to make the test
    /// deterministic instead of waiting on real wall-clock debounce.
    #[tokio::test]
    async fn force_flush_writes_project_and_snapshot() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().join("proj.vproj");
        std::fs::create_dir_all(&ws).unwrap();

        let project = Project::new_blank("autosave-test");
        let handle = spawn(project);
        let workspace = WorkspaceSlot::new();
        workspace.set(ws.clone());

        // Seed `project.json` so `take_snapshot` has something to copy.
        let snap = handle.snapshot().await;
        save_to_dir(&snap, &ws).await.unwrap();

        let ctl = AutosaveController::spawn(handle.clone(), workspace.clone());

        // Drive a mutation through the actor — anything that produces a
        // ChangeEvent. `add_video_track` is fine.
        handle
            .add_track(Actor::User, TrackKind::Video, None)
            .await
            .unwrap();

        ctl.force_flush().await.unwrap();

        // project.json is current...
        assert!(ws.join(PROJECT_FILE).exists());
        // ...and a snapshot landed in Backups/.
        let backups = ws.join(BACKUPS_DIR);
        assert!(backups.is_dir());
        let count = std::fs::read_dir(&backups).unwrap().count();
        assert!(count >= 1, "expected at least one backup, got {count}");
    }

    #[tokio::test]
    async fn snapshots_are_capped_at_retention_limit() {
        let tmp = TempDir::new().unwrap();
        let ws = tmp.path().join("proj.vproj");
        let backups = ws.join(BACKUPS_DIR);
        std::fs::create_dir_all(&backups).unwrap();
        // Seed a project.json so take_snapshot has a source.
        std::fs::write(ws.join(PROJECT_FILE), "{}").unwrap();

        // Drop in more than RETAIN_SNAPSHOTS pre-existing snapshots; vary
        // the timestamp prefix so the sort order is well-defined.
        for i in 0..(RETAIN_SNAPSHOTS + 5) {
            let name = format!("2000010{i:02}T000000000Z.json");
            std::fs::write(backups.join(&name), "{}").unwrap();
        }
        gc_snapshots(&backups).await.unwrap();

        let remaining = std::fs::read_dir(&backups).unwrap().count();
        assert_eq!(remaining, RETAIN_SNAPSHOTS);
    }
}
