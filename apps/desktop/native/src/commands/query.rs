//! Read-path commands — pure views onto the project actor's current snapshot.

use crate::commands::{build_project_summary, ProjectSummary};
use crate::napi_backend::Backend;

/// Build the full project IPC view from the actor's latest snapshot + history.
/// Reads only — never mutates, never errors past `backend not initialized`.
pub async fn project_summary(backend: &Backend) -> Result<ProjectSummary, String> {
    let handle = backend.project()?;
    let snap = handle.snapshot().await;
    let history = handle.history_status().await;
    Ok(build_project_summary(&snap, &history))
}
