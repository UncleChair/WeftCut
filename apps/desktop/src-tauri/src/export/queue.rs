//! Render queue. Serial FIFO of `(Project snapshot, output path, preset)`
//! tuples processed by a single tokio task. The queue is in-memory only —
//! if the app is closed mid-queue, queued jobs are lost. That's fine for v1;
//! a recoverable on-disk queue is post-v1 polish.
//!
//! Cancellation: removing an item that hasn't started yet is the supported
//! path (item drops out before being picked up). Cancelling an in-flight
//! render means killing the ffmpeg child — exposed as `cancel_active`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::{Mutex, mpsc};
use tracing::warn;
use uuid::Uuid;

use super::preset::ExportPreset;
use crate::state::Project;

pub type QueueId = Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExportQueueItem {
    pub id: QueueId,
    pub output_path: String,
    pub preset: ExportPreset,
    pub status: ExportQueueStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ExportQueueStatus {
    Pending,
    Running,
    Completed,
    Failed { detail: String },
    Cancelled,
}

#[derive(Clone)]
pub struct ExportQueue {
    inner: Arc<Mutex<QueueInner>>,
    tx: mpsc::Sender<QueueId>,
}

struct QueueInner {
    items: Vec<QueuedJob>,
    /// Set during run; cleared on completion. Used by `cancel_active`.
    active: Option<QueueId>,
    active_killer: Option<oneshot::Sender<()>>,
}

struct QueuedJob {
    id: QueueId,
    project: Arc<Project>,
    output_path: String,
    preset: ExportPreset,
    status: ExportQueueStatus,
}

use tokio::sync::oneshot;

impl ExportQueue {
    pub fn new(app: AppHandle) -> Self {
        let (tx, mut rx) = mpsc::channel::<QueueId>(64);
        let inner = Arc::new(Mutex::new(QueueInner {
            items: Vec::new(),
            active: None,
            active_killer: None,
        }));
        let worker_inner = inner.clone();
        let worker_app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(_id) = rx.recv().await {
                // Drain pending jobs in FIFO order. The mpsc kick is just a
                // wake-up signal; the actual order is the Vec.
                loop {
                    let next = {
                        let mut g = worker_inner.lock().await;
                        g.items
                            .iter()
                            .position(|j| matches!(j.status, ExportQueueStatus::Pending))
                            .map(|idx| {
                                let j = &mut g.items[idx];
                                j.status = ExportQueueStatus::Running;
                                let snapshot = j.project.clone();
                                let id = j.id;
                                let output = j.output_path.clone();
                                let preset = j.preset;
                                let (kill_tx, kill_rx) = oneshot::channel();
                                g.active = Some(id);
                                g.active_killer = Some(kill_tx);
                                (id, snapshot, output, preset, kill_rx)
                            })
                    };
                    let Some((id, snapshot, output, preset, kill_rx)) = next else {
                        break;
                    };
                    emit_queue(&worker_app, &worker_inner).await;

                    let app_clone = worker_app.clone();
                    let result = run_one(
                        app_clone,
                        snapshot,
                        std::path::PathBuf::from(&output),
                        preset,
                        kill_rx,
                    )
                    .await;

                    {
                        let mut g = worker_inner.lock().await;
                        if let Some(j) = g.items.iter_mut().find(|j| j.id == id) {
                            j.status = match result {
                                Ok(JobOutcome::Completed) => ExportQueueStatus::Completed,
                                Ok(JobOutcome::Cancelled) => ExportQueueStatus::Cancelled,
                                Err(e) => ExportQueueStatus::Failed {
                                    detail: format!("{e:#}"),
                                },
                            };
                        }
                        g.active = None;
                        g.active_killer = None;
                    }
                    emit_queue(&worker_app, &worker_inner).await;
                }
            }
        });
        ExportQueue { inner, tx }
    }

    pub async fn enqueue(
        &self,
        project: Arc<Project>,
        output_path: String,
        preset: ExportPreset,
    ) -> QueueId {
        let id = Uuid::now_v7();
        {
            let mut g = self.inner.lock().await;
            g.items.push(QueuedJob {
                id,
                project,
                output_path,
                preset,
                status: ExportQueueStatus::Pending,
            });
        }
        // Wake the worker; ignore send failures (worker dropped means no
        // queue is processing anyway).
        let _ = self.tx.send(id).await;
        id
    }

    pub async fn list(&self) -> Vec<ExportQueueItem> {
        let g = self.inner.lock().await;
        g.items
            .iter()
            .map(|j| ExportQueueItem {
                id: j.id,
                output_path: j.output_path.clone(),
                preset: j.preset,
                status: j.status.clone(),
            })
            .collect()
    }

    /// Remove an item from the queue. If the item is still Pending, it's
    /// just dropped. If it's Running, we send the kill signal so the
    /// in-flight ffmpeg child is terminated.
    pub async fn remove(&self, id: QueueId) -> Result<(), String> {
        let mut g = self.inner.lock().await;
        let Some(idx) = g.items.iter().position(|j| j.id == id) else {
            return Err(format!("queue item {id} not found"));
        };
        match g.items[idx].status {
            ExportQueueStatus::Pending => {
                g.items.remove(idx);
            }
            ExportQueueStatus::Running => {
                if let Some(killer) = g.active_killer.take() {
                    let _ = killer.send(());
                }
                g.items[idx].status = ExportQueueStatus::Cancelled;
            }
            _ => {
                // Already terminal; leave it as a record but don't delete.
                // Caller can call `clear_finished` to prune.
            }
        }
        Ok(())
    }

    pub async fn clear_finished(&self) {
        let mut g = self.inner.lock().await;
        g.items.retain(|j| {
            matches!(
                j.status,
                ExportQueueStatus::Pending | ExportQueueStatus::Running
            )
        });
    }
}

async fn emit_queue(app: &AppHandle, inner: &Arc<Mutex<QueueInner>>) {
    use tauri::Emitter;
    let g = inner.lock().await;
    let items: Vec<ExportQueueItem> = g
        .items
        .iter()
        .map(|j| ExportQueueItem {
            id: j.id,
            output_path: j.output_path.clone(),
            preset: j.preset,
            status: j.status.clone(),
        })
        .collect();
    drop(g);
    let _ = app.emit(super::EVENT_QUEUE, items);
}

enum JobOutcome {
    Completed,
    Cancelled,
}

async fn run_one(
    app: AppHandle,
    project: Arc<Project>,
    output: std::path::PathBuf,
    preset: ExportPreset,
    mut kill_rx: oneshot::Receiver<()>,
) -> anyhow::Result<JobOutcome> {
    let project_ref = (*project).clone();
    let render = super::run_render(app.clone(), &project_ref, &output, preset);
    tokio::select! {
        biased;
        _ = &mut kill_rx => {
            warn!("export cancelled by user: {}", output.display());
            // The render future will be dropped; tokio::process::Command was
            // built with kill_on_drop(true), which kills the ffmpeg child.
            Ok(JobOutcome::Cancelled)
        }
        result = render => {
            result.map(|_| JobOutcome::Completed)
        }
    }
}
