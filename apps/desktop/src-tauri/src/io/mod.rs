//! Project save/load (`.vproj` folder), schema migrations, media probing.
//!
//! On-disk layout, versioning rules: `docs/data-model.md`
//! ("On-disk format: `.vproj` folder" and "Versioning").
//!
//! Phase 1 footprint: write/read `project.json` + `schema_version` files,
//! probe + hash imported media. Migrations, cache/history subdirs, proxy +
//! thumbnail + waveform generation come online as their phases land.

pub mod autosave;
pub mod migrate;
pub mod probe;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tracing::{info, warn};

use crate::state::{Project, project::SCHEMA_VERSION};

pub const PROJECT_FILE: &str = "project.json";
pub const SCHEMA_FILE: &str = "schema_version";
pub const MEDIA_DIR: &str = "Media";
pub const BACKUPS_DIR: &str = "Backups";

/// Save a project to a `.vproj` directory. Creates the directory if missing.
pub async fn save_to_dir(project: &Project, dir: &Path) -> Result<()> {
    let json = serde_json::to_string_pretty(project).context("serialize project")?;
    let dir: PathBuf = dir.to_path_buf();
    let schema = SCHEMA_VERSION.to_string();

    tokio::task::spawn_blocking(move || -> Result<()> {
        fs::create_dir_all(&dir).with_context(|| format!("create project dir {}", dir.display()))?;
        fs::write(dir.join(PROJECT_FILE), json)
            .with_context(|| format!("write {}", dir.join(PROJECT_FILE).display()))?;
        fs::write(dir.join(SCHEMA_FILE), schema)
            .with_context(|| format!("write {}", dir.join(SCHEMA_FILE).display()))?;
        info!("project saved to {}", dir.display());
        Ok(())
    })
    .await
    .context("save_to_dir join")?
}

/// Load a project from a `.vproj` directory.
///
/// Per workspace-redesign Q2/A.2, `path_rel` is the on-disk authority for
/// imported media. On load, every `MediaItem` whose `path_rel` is populated
/// has its in-memory `path_abs` recomputed as `dir.join(path_rel)` — this
/// reconciles the absolute path with the current workspace location
/// (handles "user moved the workspace folder between sessions"). Items
/// whose `path_rel` is still `None` (legacy projects, pre-migration) keep
/// their serialized `path_abs` until Phase A.4's migration fills `path_rel`.
pub async fn load_from_dir(dir: &Path) -> Result<Project> {
    let path: PathBuf = dir.join(PROJECT_FILE);
    let json = tokio::task::spawn_blocking(move || -> Result<String> {
        fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))
    })
    .await
    .context("load_from_dir join")??;

    let mut project: Project = serde_json::from_str(&json).context("deserialize project")?;
    if project.schema_version > SCHEMA_VERSION {
        anyhow::bail!(
            "project was saved with schema_version {} but this build supports up to {}",
            project.schema_version,
            SCHEMA_VERSION
        );
    }

    // Auto-migrate older schemas. Per workspace-redesign Q9 we write a
    // pre-migration backup first, then run the migration to bring media
    // into `<workspace>/Media/` + populate `path_rel`. If migration fails
    // partway, the backup file is the recovery anchor.
    if project.schema_version < SCHEMA_VERSION {
        let report = migrate::run(dir, &mut project)
            .await
            .with_context(|| format!("migrate {}", dir.display()))?;
        info!(
            "migrated {} from schema {} to {}: {} migrated, {} missing, {} reused",
            dir.display(),
            report.from_version,
            report.to_version,
            report.migrated,
            report.missing_sources,
            report.reused_existing,
        );
        // Persist the migrated project state so subsequent loads skip
        // the migration path (and the new path_abs / path_rel pairs are
        // canonical on disk).
        save_to_dir(&project, dir).await.context("re-save after migration")?;
    }

    // Reconcile media `path_abs` against the workspace location. The
    // serialized `path_abs` is whatever was correct at save time; if the
    // workspace folder moved (different machine, renamed parent dir), the
    // serialized absolute path is now stale. The `path_rel` anchor is
    // workspace-relative and survives moves intact.
    let updated: Vec<(crate::state::ids::MediaId, crate::state::media::MediaItem)> = project
        .media_pool
        .iter()
        .filter_map(|(id, item)| {
            item.path_rel.as_ref().map(|rel| {
                let mut next = item.clone();
                next.path_abs = dir.join(rel);
                (*id, next)
            })
        })
        .collect();
    for (id, item) in updated {
        project.media_pool.insert(id, item);
    }

    // `docs/preview-scrub.md` S.2 — invalidate proxies whose format
    // version predates the current encoder shape. Clears `proxy_path`
    // (and best-effort deletes the cached mp4) so subsequent open-time
    // job enqueueing picks them up for re-encoding. The
    // `proxy_format_version` stays as-recorded; the job's success patch
    // will bump it to the current version once regeneration completes.
    invalidate_stale_proxies(&mut project).await;

    info!(
        "project loaded ({} → {}, schema {})",
        dir.display(),
        project.metadata.name,
        project.schema_version
    );
    Ok(project)
}

/// Walk the media pool and clear `proxy_path` on every entry whose
/// `proxy_format_version` is below the current encoder version. The old
/// cached file is removed best-effort so disk doesn't accumulate stale
/// proxies; failure to delete is logged-only (the path is already
/// unreferenced, so a leak is bounded and the next user-triggered
/// "clear cache" sweeps it).
async fn invalidate_stale_proxies(project: &mut crate::state::Project) {
    use crate::jobs::proxy::PROXY_FORMAT_VERSION;
    let stale: Vec<crate::state::ids::MediaId> = project
        .media_pool
        .iter()
        .filter_map(|(id, item)| {
            let has_proxy = item.proxy_path.is_some();
            let stale = item.proxy_format_version < PROXY_FORMAT_VERSION;
            (has_proxy && stale).then_some(*id)
        })
        .collect();
    for id in stale {
        if let Some(item) = project.media_pool.get_mut(&id) {
            if let Some(path) = item.proxy_path.take() {
                if let Err(e) = tokio::fs::remove_file(&path).await {
                    warn!(
                        "stale proxy delete failed for {} (non-fatal): {e}",
                        path.display()
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn round_trip_blank_project() {
        let dir = TempDir::new().unwrap();
        let vproj = dir.path().join("rt.vproj");

        let original = Project::new_blank("round-trip");
        let original_id = original.project_id;
        save_to_dir(&original, &vproj).await.expect("save");

        assert!(vproj.join(PROJECT_FILE).exists());
        assert!(vproj.join(SCHEMA_FILE).exists());

        let loaded = load_from_dir(&vproj).await.expect("load");
        assert_eq!(loaded.project_id, original_id);
        assert_eq!(loaded.metadata.name, "round-trip");
    }

    #[tokio::test]
    async fn load_reconciles_path_abs_from_path_rel() {
        use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
        use chrono::Utc;
        use std::path::PathBuf;

        let saved_at = TempDir::new().unwrap();
        let vproj = saved_at.path().join("doc.vproj");

        let mut project = Project::new_blank("reconcile");
        let item = MediaItem {
            id: uuid::Uuid::now_v7(),
            label: Some("clip".into()),
            // path_abs at save time — pointing into the original workspace.
            path_abs: vproj.join("Media").join("clip.mp4"),
            // path_rel is the anchor that survives a workspace move.
            path_rel: Some(PathBuf::from("Media/clip.mp4")),
            kind: MediaKind::Video,
            metadata: MediaMetadata::default(),
            proxy_path: None,

            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "deadbeef".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: chrono::Utc::now(),
        };
        let id = item.id;
        project.media_pool.insert(id, item);
        save_to_dir(&project, &vproj).await.unwrap();

        // Simulate the user moving the workspace folder elsewhere.
        let moved = TempDir::new().unwrap();
        let moved_vproj = moved.path().join("renamed.vproj");
        fs::create_dir_all(&moved_vproj).unwrap();
        fs::copy(
            vproj.join(PROJECT_FILE),
            moved_vproj.join(PROJECT_FILE),
        )
        .unwrap();
        fs::copy(
            vproj.join(SCHEMA_FILE),
            moved_vproj.join(SCHEMA_FILE),
        )
        .unwrap();

        let loaded = load_from_dir(&moved_vproj).await.unwrap();
        let loaded_item = loaded.media_pool.get(&id).unwrap();
        // path_abs got rewritten to point inside the NEW workspace location.
        assert_eq!(
            loaded_item.path_abs,
            moved_vproj.join("Media").join("clip.mp4"),
        );
        // path_rel is unchanged — it's the workspace-relative anchor.
        assert_eq!(
            loaded_item.path_rel.as_ref().unwrap(),
            &PathBuf::from("Media/clip.mp4"),
        );
    }

    #[tokio::test]
    async fn load_leaves_path_abs_alone_when_path_rel_is_none() {
        use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
        use chrono::Utc;
        use std::path::PathBuf;

        let dir = TempDir::new().unwrap();
        let vproj = dir.path().join("legacy.vproj");

        let mut project = Project::new_blank("legacy");
        let legacy_abs = PathBuf::from("/external/source/video.mp4");
        let item = MediaItem {
            id: uuid::Uuid::now_v7(),
            label: None,
            path_abs: legacy_abs.clone(),
            path_rel: None, // legacy: pre-workspace-redesign import
            kind: MediaKind::Video,
            metadata: MediaMetadata::default(),
            proxy_path: None,

            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "abc".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: chrono::Utc::now(),
        };
        let id = item.id;
        project.media_pool.insert(id, item);
        save_to_dir(&project, &vproj).await.unwrap();

        let loaded = load_from_dir(&vproj).await.unwrap();
        // Legacy item: path_abs preserved verbatim. Phase A.4 migration is
        // what flips it into the workspace format.
        assert_eq!(loaded.media_pool.get(&id).unwrap().path_abs, legacy_abs);
    }

    #[tokio::test]
    async fn rejects_future_schema_version() {
        let dir = TempDir::new().unwrap();
        let vproj = dir.path().join("future.vproj");

        let mut p = Project::new_blank("from-the-future");
        p.schema_version = SCHEMA_VERSION + 100;
        save_to_dir(&p, &vproj).await.unwrap();

        let err = load_from_dir(&vproj).await.expect_err("future schema");
        assert!(format!("{err:#}").contains("schema_version"));
    }

    /// `docs/preview-scrub.md` S.2 — proxies whose recorded
    /// `proxy_format_version` predates the encoder's current version
    /// must be cleared on load so the post-load job-enqueue pass picks
    /// them up. The cached file is best-effort deleted; we just verify
    /// the in-memory path is None.
    #[tokio::test]
    async fn stale_proxy_format_invalidated_on_load() {
        use crate::jobs::proxy::PROXY_FORMAT_VERSION;
        use crate::state::media::{MediaItem, MediaKind, MediaMetadata};

        let dir = TempDir::new().unwrap();
        let vproj = dir.path().join("with-stale-proxy.vproj");
        fs::create_dir_all(&vproj).unwrap();

        let mut project = Project::new_blank("stale-proxy");
        let stale_proxy = dir.path().join("stale.mp4");
        tokio::fs::write(&stale_proxy, b"old proxy bytes").await.unwrap();

        let item_id = uuid::Uuid::now_v7();
        let item = MediaItem {
            id: item_id,
            label: None,
            path_abs: dir.path().join("clip.mp4"),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata::default(),
            proxy_path: Some(stale_proxy.clone()),
            // Marked as the OLD format version — invalidation must
            // clear `proxy_path` regardless of whether the file exists.
            proxy_format_version: PROXY_FORMAT_VERSION.saturating_sub(1),
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "stale".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: chrono::Utc::now(),
        };
        project.media_pool.insert(item_id, item);
        save_to_dir(&project, &vproj).await.unwrap();

        let loaded = load_from_dir(&vproj).await.unwrap();
        let it = loaded.media_pool.get(&item_id).unwrap();
        assert!(it.proxy_path.is_none(), "stale proxy_path should be cleared");
        // Best-effort delete: the cached file should be gone.
        assert!(!stale_proxy.exists(), "stale proxy file should be deleted");
    }

    #[tokio::test]
    async fn fresh_proxy_format_preserved_on_load() {
        use crate::jobs::proxy::PROXY_FORMAT_VERSION;
        use crate::state::media::{MediaItem, MediaKind, MediaMetadata};

        let dir = TempDir::new().unwrap();
        let vproj = dir.path().join("with-fresh-proxy.vproj");
        fs::create_dir_all(&vproj).unwrap();

        let mut project = Project::new_blank("fresh-proxy");
        let proxy_path = dir.path().join("fresh.mp4");
        tokio::fs::write(&proxy_path, b"fresh proxy bytes").await.unwrap();

        let item_id = uuid::Uuid::now_v7();
        let item = MediaItem {
            id: item_id,
            label: None,
            path_abs: dir.path().join("clip.mp4"),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata::default(),
            proxy_path: Some(proxy_path.clone()),
            proxy_format_version: PROXY_FORMAT_VERSION, // current
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "fresh".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: chrono::Utc::now(),
        };
        project.media_pool.insert(item_id, item);
        save_to_dir(&project, &vproj).await.unwrap();

        let loaded = load_from_dir(&vproj).await.unwrap();
        let it = loaded.media_pool.get(&item_id).unwrap();
        assert_eq!(
            it.proxy_path.as_deref(),
            Some(proxy_path.as_path()),
            "fresh proxy_path should survive load"
        );
        assert!(proxy_path.exists(), "fresh proxy file should not be deleted");
    }
}
