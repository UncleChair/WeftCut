//! Background-copy import worker for `import_media`.
//!
//! Per `docs/workspace-redesign.md` Q6 the import flow is:
//!
//!   1. Tauri command `import_media` probes + hashes the source synchronously
//!      (fast), inserts a MediaItem with `path_abs = original source`, kicks
//!      derivative jobs (proxy / thumbnails / waveform — they're content-
//!      addressed by hash, so they don't care whether they read from the
//!      original or the workspace copy), and pushes a copy job to this
//!      queue.
//!   2. This worker pops the job, copies the original to
//!      `<workspace>/Media/<filename>` (hash-prefix collision handling
//!      shared in spirit with `io::migrate`), then calls
//!      `ProjectHandle::set_media_workspace_paths` to flip the MediaItem's
//!      `path_abs` to the workspace copy and populate `path_rel`.
//!   3. Tauri events surface progress to the UI:
//!      - `import:queue`   → full list, fires on every state change
//!      - `import:started` → media_id, fires when copy begins
//!      - `import:complete`→ media_id + path_rel, fires on success
//!      - `import:error`   → media_id + detail, fires on failure
//!
//! Single-worker FIFO matches `ExportQueue` — disk write bandwidth is the
//! bottleneck, parallel workers thrash. Cancellation between jobs is
//! supported (a pending job that hasn't started yet gets dropped and its
//! MediaItem removed); cancellation **mid-copy** is best-effort via a
//! shared atomic flag the chunked copy checks per buffer.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::{info, warn};

use crate::state::ids::MediaId;
use crate::state::{Actor, ProjectHandle};

const MEDIA_DIR: &str = "Media";
const COPY_BUFFER: usize = 1024 * 1024; // 1 MB

pub mod events {
    pub const QUEUE: &str = "import:queue";
    pub const STARTED: &str = "import:started";
    pub const COMPLETE: &str = "import:complete";
    pub const ERROR: &str = "import:error";
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind")]
pub enum ImportStatus {
    Pending,
    Copying,
    Completed,
    Failed { detail: String },
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
pub struct ImportEntry {
    pub media_id: String,
    pub source: String,
    pub destination_rel: Option<String>,
    pub status: ImportStatus,
}

/// Tauri-managed queue. Cloneable handle (Arc-shared inner) so the worker
/// and the UI command surface both hold the same backing list.
#[derive(Clone)]
pub struct ImportQueue {
    inner: Arc<Mutex<ImportQueueInner>>,
    app: AppHandle,
}

struct ImportQueueInner {
    pending: VecDeque<PendingImport>,
    running: Option<RunningImport>,
    history: Vec<ImportEntry>,
    worker_alive: bool,
}

struct PendingImport {
    media_id: MediaId,
    source: PathBuf,
    workspace_root: PathBuf,
    handle: ProjectHandle,
}

struct RunningImport {
    media_id: MediaId,
    source: PathBuf,
    cancel: Arc<AtomicBool>,
}

impl ImportQueue {
    pub fn new(app: AppHandle) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ImportQueueInner {
                pending: VecDeque::new(),
                running: None,
                history: Vec::new(),
                worker_alive: false,
            })),
            app,
        }
    }

    /// Push a copy job. Spawns the worker on first enqueue; subsequent
    /// enqueues just append.
    pub fn enqueue(
        &self,
        handle: ProjectHandle,
        media_id: MediaId,
        source: PathBuf,
        workspace_root: PathBuf,
    ) {
        let need_worker = {
            let mut guard = self.inner.lock().expect("import queue poisoned");
            guard.pending.push_back(PendingImport {
                media_id,
                source: source.clone(),
                workspace_root,
                handle,
            });
            guard.history.push(ImportEntry {
                media_id: media_id.to_string(),
                source: source.to_string_lossy().to_string(),
                destination_rel: None,
                status: ImportStatus::Pending,
            });
            let spawn = !guard.worker_alive;
            if spawn {
                guard.worker_alive = true;
            }
            spawn
        };
        self.emit_queue();
        if need_worker {
            let me = self.clone();
            tauri::async_runtime::spawn(async move { me.worker_loop().await });
        }
    }

    /// Cancel a pending or running import by media_id. Returns true if a
    /// job was actually cancelled. A pending job is removed from the
    /// queue; a running job has its cancel flag set — the chunked copy
    /// checks it between buffers and aborts.
    pub fn cancel(&self, media_id: MediaId) -> bool {
        let mut guard = self.inner.lock().expect("import queue poisoned");
        // Pending case: just drop it.
        if let Some(pos) = guard
            .pending
            .iter()
            .position(|j| j.media_id == media_id)
        {
            guard.pending.remove(pos);
            for entry in guard.history.iter_mut() {
                if entry.media_id == media_id.to_string()
                    && matches!(entry.status, ImportStatus::Pending)
                {
                    entry.status = ImportStatus::Cancelled;
                }
            }
            drop(guard);
            self.emit_queue();
            return true;
        }
        // Running case: signal cancel.
        if let Some(run) = guard.running.as_ref() {
            if run.media_id == media_id {
                run.cancel.store(true, Ordering::Relaxed);
                return true;
            }
        }
        false
    }

    /// Snapshot the queue + recent history for the UI.
    pub fn list(&self) -> Vec<ImportEntry> {
        self.inner
            .lock()
            .expect("import queue poisoned")
            .history
            .clone()
    }

    fn emit_queue(&self) {
        let snapshot = self.list();
        if let Err(e) = self.app.emit(events::QUEUE, snapshot) {
            warn!("emit {}: {e}", events::QUEUE);
        }
    }

    async fn worker_loop(self) {
        loop {
            let next = {
                let mut guard = self.inner.lock().expect("import queue poisoned");
                let next = guard.pending.pop_front();
                if next.is_none() {
                    guard.worker_alive = false;
                    return;
                }
                next.unwrap()
            };

            let media_id = next.media_id;
            let cancel = Arc::new(AtomicBool::new(false));
            {
                let mut guard = self.inner.lock().expect("import queue poisoned");
                guard.running = Some(RunningImport {
                    media_id,
                    source: next.source.clone(),
                    cancel: cancel.clone(),
                });
                if let Some(entry) = guard
                    .history
                    .iter_mut()
                    .rev()
                    .find(|e| e.media_id == media_id.to_string())
                {
                    entry.status = ImportStatus::Copying;
                }
            }
            if let Err(e) = self
                .app
                .emit(events::STARTED, serde_json::json!({ "mediaId": media_id.to_string() }))
            {
                warn!("emit import:started: {e}");
            }
            self.emit_queue();

            let outcome = copy_to_workspace(
                &next.source,
                &next.workspace_root,
                cancel.clone(),
            )
            .await;

            match outcome {
                Ok(Some(dest_rel)) => {
                    let dest_abs = next.workspace_root.join(&dest_rel);
                    if let Err(e) = next
                        .handle
                        .set_media_workspace_paths(
                            Actor::User,
                            media_id,
                            dest_abs.clone(),
                            dest_rel.clone(),
                        )
                        .await
                    {
                        warn!("import: actor update failed: {e}");
                        self.finalize(media_id, ImportStatus::Failed {
                            detail: e.to_string(),
                        });
                        let _ = self.app.emit(
                            events::ERROR,
                            serde_json::json!({
                                "mediaId": media_id.to_string(),
                                "detail": e.to_string(),
                            }),
                        );
                    } else {
                        info!(
                            "import: {} -> {}",
                            next.source.display(),
                            dest_rel.display()
                        );
                        self.finalize_with_dest(
                            media_id,
                            ImportStatus::Completed,
                            Some(dest_rel.to_string_lossy().to_string()),
                        );
                        let _ = self.app.emit(
                            events::COMPLETE,
                            serde_json::json!({
                                "mediaId": media_id.to_string(),
                                "pathRel": dest_rel.to_string_lossy(),
                            }),
                        );
                    }
                }
                Ok(None) => {
                    // Cancelled mid-copy.
                    self.finalize(media_id, ImportStatus::Cancelled);
                }
                Err(e) => {
                    warn!("import: copy failed: {e:#}");
                    self.finalize(media_id, ImportStatus::Failed {
                        detail: format!("{e:#}"),
                    });
                    let _ = self.app.emit(
                        events::ERROR,
                        serde_json::json!({
                            "mediaId": media_id.to_string(),
                            "detail": format!("{e:#}"),
                        }),
                    );
                }
            }
        }
    }

    fn finalize(&self, media_id: MediaId, status: ImportStatus) {
        self.finalize_with_dest(media_id, status, None);
    }

    fn finalize_with_dest(
        &self,
        media_id: MediaId,
        status: ImportStatus,
        dest_rel: Option<String>,
    ) {
        {
            let mut guard = self.inner.lock().expect("import queue poisoned");
            guard.running = None;
            if let Some(entry) = guard
                .history
                .iter_mut()
                .rev()
                .find(|e| e.media_id == media_id.to_string())
            {
                entry.status = status;
                if dest_rel.is_some() {
                    entry.destination_rel = dest_rel;
                }
            }
        }
        self.emit_queue();
    }
}

/// Pick a destination filename in `<workspace>/Media/`. Prefers the source
/// basename; if that name is already taken on disk, prefix with the first
/// 8 hex chars of the source's blake3 hash to disambiguate. Mirrors
/// `io::migrate::pick_dest_filename` — eventual factor-out is fine.
fn pick_dest_filename(media_dir: &Path, source: &Path, hash_hint: Option<&str>) -> PathBuf {
    let base = source
        .file_name()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("media"));
    if !media_dir.join(&base).exists() {
        return base;
    }
    let prefix = hash_hint
        .map(|h| h[..h.len().min(8)].to_string())
        .unwrap_or_else(|| format!("{:08x}", rand_u32()));
    let base_str = base.to_string_lossy();
    PathBuf::from(format!("{prefix}-{base_str}"))
}

fn rand_u32() -> u32 {
    // Coarse non-cryptographic randomness as a last-resort collision
    // breaker for the no-hash code path. Time-based — unique enough across
    // realistic imports.
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
}

/// Copy `source` into `<workspace>/Media/<basename>` via a `.tmp + rename`
/// atomic step, checking the cancel flag every chunk. Returns:
///   - `Ok(Some(dest_rel))` on a successful copy + rename
///   - `Ok(None)` if the operation was cancelled before completion
///   - `Err(_)` on any I/O failure
async fn copy_to_workspace(
    source: &Path,
    workspace_root: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<Option<PathBuf>> {
    if !source.is_file() {
        anyhow::bail!("source not found: {}", source.display());
    }
    let media_dir = workspace_root.join(MEDIA_DIR);
    tokio::fs::create_dir_all(&media_dir)
        .await
        .with_context(|| format!("create {}", media_dir.display()))?;

    let dest_rel_basename = pick_dest_filename(&media_dir, source, None);
    let dest_abs = media_dir.join(&dest_rel_basename);
    let tmp = dest_abs.with_extension(format!(
        "{}.tmp",
        dest_abs
            .extension()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    ));

    let mut src_file = tokio::fs::File::open(source)
        .await
        .with_context(|| format!("open {}", source.display()))?;
    let mut dst_file = tokio::fs::File::create(&tmp)
        .await
        .with_context(|| format!("create {}", tmp.display()))?;
    let mut buf = vec![0u8; COPY_BUFFER];

    loop {
        if cancel.load(Ordering::Relaxed) {
            drop(dst_file);
            let _ = tokio::fs::remove_file(&tmp).await;
            return Ok(None);
        }
        let n = src_file
            .read(&mut buf)
            .await
            .with_context(|| format!("read {}", source.display()))?;
        if n == 0 {
            break;
        }
        dst_file
            .write_all(&buf[..n])
            .await
            .with_context(|| format!("write {}", tmp.display()))?;
    }
    dst_file
        .flush()
        .await
        .with_context(|| format!("flush {}", tmp.display()))?;
    drop(dst_file);

    tokio::fs::rename(&tmp, &dest_abs)
        .await
        .with_context(|| format!("promote {} -> {}", tmp.display(), dest_abs.display()))?;

    Ok(Some(PathBuf::from(MEDIA_DIR).join(&dest_rel_basename)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn pick_dest_filename_basic() {
        let tmp = TempDir::new().unwrap();
        let media_dir = tmp.path();
        let picked = pick_dest_filename(
            media_dir,
            Path::new("/external/some/clip.mp4"),
            Some("deadbeef00112233"),
        );
        assert_eq!(picked, PathBuf::from("clip.mp4"));
    }

    #[test]
    fn pick_dest_filename_collision_prefixes_with_hash() {
        let tmp = TempDir::new().unwrap();
        let media_dir = tmp.path();
        std::fs::write(media_dir.join("clip.mp4"), b"existing").unwrap();
        let picked = pick_dest_filename(
            media_dir,
            Path::new("/another/place/clip.mp4"),
            Some("deadbeef00112233"),
        );
        assert_eq!(
            picked.file_name().unwrap().to_string_lossy(),
            "deadbeef-clip.mp4"
        );
    }

    #[tokio::test]
    async fn copy_to_workspace_writes_into_media_dir() {
        let ws = TempDir::new().unwrap();
        let ext = TempDir::new().unwrap();
        let src = ext.path().join("video.mp4");
        std::fs::write(&src, b"hello video").unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let result = copy_to_workspace(&src, ws.path(), cancel).await.unwrap();
        let rel = result.expect("copy completed");
        assert_eq!(rel, PathBuf::from("Media/video.mp4"));
        let landed = ws.path().join(&rel);
        assert_eq!(std::fs::read(&landed).unwrap(), b"hello video");
    }

    #[tokio::test]
    async fn copy_to_workspace_respects_cancel() {
        let ws = TempDir::new().unwrap();
        let ext = TempDir::new().unwrap();
        let src = ext.path().join("video.mp4");
        // Big enough that the inner loop runs > 1 iteration and has time to
        // see the cancel flag — 5MB > 1MB buffer.
        std::fs::write(&src, vec![0u8; 5 * 1024 * 1024]).unwrap();

        let cancel = Arc::new(AtomicBool::new(true));
        let result = copy_to_workspace(&src, ws.path(), cancel).await.unwrap();
        assert!(result.is_none(), "expected cancelled outcome");
        // The .tmp shouldn't survive cancellation.
        let media_dir = ws.path().join(MEDIA_DIR);
        if media_dir.is_dir() {
            let stragglers: Vec<_> = std::fs::read_dir(&media_dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
                .collect();
            assert!(stragglers.is_empty(), "leaked tmp files: {stragglers:?}");
        }
    }
}
