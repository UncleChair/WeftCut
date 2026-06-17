//! S3 media commands — import lifecycle + derivative queries. Re-homed from the
//! Tauri `commands.rs` onto the napi `Backend`. Gated behind `jobs`.

use std::path::PathBuf;

use chrono::Utc;

use crate::io;
use crate::jobs::import::ImportEntry;
use crate::napi_backend::Backend;
use crate::state::{self, Actor, MediaItem, MediaKind};

/// Probe + hash a source file, insert a `MediaItem`, fan out derivative jobs,
/// and queue the background workspace copy. Returns the media id.
pub async fn import_media(backend: &Backend, path: String) -> Result<String, String> {
    let handle = backend.project()?;
    let cache = backend.cache.clone();
    let source_buf = PathBuf::from(&path);
    let media_id = uuid::Uuid::new_v4();
    let workspace_root = backend.workspace.current();
    let has_workspace = workspace_root.is_some();

    let item = tokio::task::spawn_blocking({
        let source_buf = source_buf.clone();
        move || -> Result<MediaItem, String> {
            let (file_size, file_mtime, file_hash_blake3) = if has_workspace {
                let (size, mtime) = io::probe::stat_file(&source_buf).map_err(|e| format!("{e:#}"))?;
                (size, mtime, format!("pending-{media_id}"))
            } else {
                let facts = io::probe::hash_and_stat(&source_buf).map_err(|e| format!("{e:#}"))?;
                (facts.size, facts.mtime_secs, facts.blake3_hex)
            };
            let metadata = io::probe::probe_metadata(&source_buf);
            let kind: MediaKind = io::probe::detect_kind(&source_buf, &metadata);
            let label = source_buf.file_name().map(|n| n.to_string_lossy().to_string());
            Ok(MediaItem {
                id: media_id,
                label,
                path_abs: source_buf,
                path_rel: None,
                kind,
                metadata,
                proxy_path: None,
                proxy_format_version: 0,
                quick_proxy_path: None,
                proxy_bypassed: false,
                export_uses_original: false,
                waveform_path: None,
                conform_path: None,
                thumbnails_dir: None,
                file_hash_blake3,
                file_size,
                file_mtime,
                imported_at: Utc::now(),
            })
        }
    })
    .await
    .map_err(|e| format!("import join: {e}"))??;

    let media_id = item.id;
    let item_for_jobs = item.clone();
    let id = handle
        .add_media_item(Actor::User, item)
        .await
        .map_err(|e| e.to_string())?;

    crate::jobs::enqueue_for_media(backend.events.clone(), cache.clone(), handle.clone(), item_for_jobs);

    if let Some(ws) = workspace_root {
        backend
            .import_queue
            .enqueue(handle.clone(), cache.clone(), media_id, source_buf, ws);
    } else {
        tracing::warn!(
            "import_media: no workspace set; MediaItem stays referencing the original source."
        );
    }

    Ok(id.to_string())
}

pub async fn import_cancel(backend: &Backend, media_id: String) -> Result<bool, String> {
    let id = uuid::Uuid::parse_str(&media_id).map_err(|e| format!("media_id: {e}"))?;
    Ok(backend.import_queue.cancel(id))
}

pub async fn import_queue_list(backend: &Backend) -> Result<Vec<ImportEntry>, String> {
    Ok(backend.import_queue.list())
}
