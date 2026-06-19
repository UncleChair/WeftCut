//! History commands — undo / redo / restore-checkpoint, re-signed from
//! `commands_legacy.rs`. Bodies are copied verbatim; only the signature
//! changes (the napi `Backend` carries the managed state).

use uuid::Uuid;
#[cfg(debug_assertions)]
use chrono::Utc;

use crate::napi_backend::Backend;
use crate::state::{Actor, CommandError};

/// Step one operation back in the undo stack.
pub async fn project_undo(backend: &Backend) -> Result<(), String> {
    let handle = backend.project()?;
    handle
        .undo(Actor::User)
        .await
        .map_err(|e: CommandError| e.to_string())
}

/// Step one operation forward in the redo stack.
pub async fn project_redo(backend: &Backend) -> Result<(), String> {
    let handle = backend.project()?;
    handle
        .redo(Actor::User)
        .await
        .map_err(|e: CommandError| e.to_string())
}

/// User-side checkpoint restore. Emits a structured Restore LogEntry
/// so the record panel can prune the rolled-back agent actions from view.
pub async fn project_restore_checkpoint(
    backend: &Backend,
    checkpoint_id: String,
) -> Result<(), String> {
    let handle = backend.project()?;
    let id = Uuid::parse_str(&checkpoint_id)
        .map_err(|e| format!("checkpoint_id not a UUID: {e}"))?;
    // Look up the label BEFORE restoring — the actor's restore call
    // returns `()`, and we want the label for the Restore LogEntry's
    // `details` payload.
    let label = handle
        .list_checkpoints()
        .await
        .into_iter()
        .find(|c| c.id == id)
        .map(|c| c.label);
    handle
        .restore_checkpoint(Actor::User, id)
        .await
        .map_err(|e: CommandError| e.to_string())?;
    backend.log_slot.emit(crate::logs::LogEntryInput {
        level: crate::logs::LogLevel::Info,
        category: crate::logs::LogCategory::Project,
        source: crate::logs::LogSource::User,
        message: match &label {
            Some(l) => format!("Restored to checkpoint: {l}"),
            None => format!("Restored to checkpoint: {id}"),
        },
        details: Some(serde_json::json!({
            "kind": "Restore",
            "checkpoint_id": id.to_string(),
            "label": label,
        })),
        ..Default::default()
    });
    Ok(())
}

/// Dev-only: take the revert lock so the badge + disabled-Restore
/// behavior can be exercised without a real agent.
#[cfg(debug_assertions)]
pub async fn debug_lock_history(backend: &Backend, reason: String) -> Result<(), String> {
    let handle = backend.project()?;
    handle.lock_history(reason).await;
    Ok(())
}

/// Dev-only: release the revert lock.
#[cfg(debug_assertions)]
pub async fn debug_unlock_history(backend: &Backend) -> Result<(), String> {
    let handle = backend.project()?;
    handle.unlock_history().await;
    Ok(())
}

/// Dev-only: simulate an agent session start (create a checkpoint +
/// begin the session slot + emit `agent_session:changed`).
#[cfg(debug_assertions)]
pub async fn debug_simulate_agent_session(
    backend: &Backend,
    reason: String,
) -> Result<String, String> {
    let handle = backend.project()?;
    let reason = reason.trim();
    if reason.is_empty() {
        return Err("reason must be non-empty".into());
    }
    let label = format!("Pre-agent: {reason}");
    let checkpoint_id = handle
        .checkpoint(Actor::User, label.clone())
        .await;
    backend.log_slot.emit(crate::logs::LogEntryInput {
        level: crate::logs::LogLevel::Info,
        category: crate::logs::LogCategory::Project,
        source: crate::logs::LogSource::Agent { client: "debug-sim".into() },
        message: format!("Checkpoint: {label}"),
        details: Some(serde_json::json!({
            "kind": "Checkpoint",
            "id": checkpoint_id.to_string(),
            "label": label,
        })),
        ..Default::default()
    });
    let session = crate::agent_session::AgentSession {
        client: "debug-sim".into(),
        reason: reason.to_string(),
        started_at: Utc::now(),
    };
    crate::agent_session::begin_and_emit(&*backend.events, &backend.agent_session, session);
    Ok(checkpoint_id.to_string())
}
