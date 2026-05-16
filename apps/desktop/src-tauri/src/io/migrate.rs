//! Schema migration for `.vproj` projects.
//!
//! Today there's exactly one migration: **v1 → v2** (`docs/workspace-
//! redesign.md` Q9). v1 projects hold absolute paths into wherever the
//! user imported media from; v2 projects own copies of their media under
//! `<workspace>/Media/` and use workspace-relative `path_rel` as the
//! authoritative path.
//!
//! Per-media migration is best-effort: a `MediaItem` whose source file
//! is missing or unreadable stays in legacy mode (path_rel `None`, original
//! path_abs preserved) and the project continues to load. Phase C surfaces
//! these as "missing media" badges in the pool. This avoids a half-
//! migrated project locking the user out entirely.
//!
//! Before the first per-file copy lands, we write `Backups/pre-migration-
//! <ts>.json` so the user can roll back manually if something goes sideways.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::Utc;
use tracing::warn;

use crate::state::Project;
use crate::state::project::SCHEMA_VERSION;

use super::{BACKUPS_DIR, MEDIA_DIR, PROJECT_FILE};

#[derive(Debug, Default, Clone)]
pub struct MigrationReport {
    pub from_version: u32,
    pub to_version: u32,
    /// MediaItems successfully copied into `Media/`.
    pub migrated: usize,
    /// MediaItems whose source file wasn't readable; left in legacy state.
    pub missing_sources: usize,
    /// MediaItems whose destination already existed in `Media/`; reused
    /// in place (idempotent retry / hand-mounted assets).
    pub reused_existing: usize,
}

/// Run all needed migrations to bring `project` up to `SCHEMA_VERSION`.
/// Mutates `project` in place. Returns a report for logging / telemetry.
pub async fn run(workspace: &Path, project: &mut Project) -> Result<MigrationReport> {
    let from = project.schema_version;
    if from >= SCHEMA_VERSION {
        return Ok(MigrationReport {
            from_version: from,
            to_version: from,
            ..Default::default()
        });
    }

    write_pre_migration_backup(workspace)
        .context("write pre-migration backup")?;

    let mut report = MigrationReport {
        from_version: from,
        to_version: SCHEMA_VERSION,
        ..Default::default()
    };

    if from < 2 {
        v1_to_v2(workspace, project, &mut report)
            .await
            .context("v1 → v2 migration")?;
        project.schema_version = 2;
    }
    if project.schema_version < 3 {
        // v3 = group system. `Project.groups` defaults to empty via
        // `#[serde(default)]`; the `auto_pair_audio_on_import` setting
        // defaults to `true`. Nothing on the wire actually changes — this
        // is a pure version bump so the field-existence invariant in
        // `validate_groups` runs on previously-untouched projects too.
        project.schema_version = 3;
    }
    if project.schema_version < 4 {
        // v4 = A/B-roll redesign (`docs/ab-roll-redesign`). `Track.role`
        // defaults to `None` via `#[serde(default)]`, which is what we
        // want: legacy projects keep their unstamped tracks and render
        // best in Show-All mode. We deliberately do NOT auto-stamp the
        // first video/audio tracks as A/B — the user toggles to Show-All
        // manually (Q8 of the redesign locked "no migration").
        project.schema_version = 4;
    }
    if project.schema_version < 5 {
        // v5 = A/B-roll redesign v2 (AE-style). Reserved skeleton
        // shrinks from 4 → 2 tracks. Legacy v4 projects keep their
        // orphan AudioA/AudioB role-stamped tracks visible — no
        // auto-migration. The user chose not to handle legacy here.
        // Pure version bump.
        project.schema_version = 5;
    }

    Ok(report)
}

/// Copy each MediaItem's source file into `<workspace>/Media/`, set
/// `path_rel`, and rewrite `path_abs` to the new location.
async fn v1_to_v2(
    workspace: &Path,
    project: &mut Project,
    report: &mut MigrationReport,
) -> Result<()> {
    let media_dir = workspace.join(MEDIA_DIR);
    let workspace = workspace.to_path_buf();

    // Drain the work onto a blocking task — file copies for big media can
    // run for many seconds and we don't want to stall the async runtime.
    // We collect the to-do list outside the closure so we can re-insert
    // the migrated items back into the imbl HashMap (which lives in the
    // main project).
    let to_migrate: Vec<(crate::state::ids::MediaId, crate::state::media::MediaItem)> = project
        .media_pool
        .iter()
        .filter(|(_, item)| item.path_rel.is_none())
        .map(|(id, item)| (*id, item.clone()))
        .collect();

    let (updates, copy_report) = tokio::task::spawn_blocking(move || -> Result<_> {
        fs::create_dir_all(&media_dir)
            .with_context(|| format!("create {}", media_dir.display()))?;

        let mut updates = Vec::with_capacity(to_migrate.len());
        let mut migrated = 0usize;
        let mut missing_sources = 0usize;
        let mut reused_existing = 0usize;

        for (id, item) in to_migrate {
            if !item.path_abs.is_file() {
                missing_sources += 1;
                warn!(
                    "migration: source missing for media {}: {}",
                    id,
                    item.path_abs.display()
                );
                continue;
            }

            let dest_rel = pick_dest_filename(&media_dir, &item.path_abs, &item.file_hash_blake3);
            let dest = media_dir.join(&dest_rel);

            if dest.exists() {
                // Idempotent: dest already populated (prior partial
                // migration, or user pre-staged it). Trust the existing
                // file and just update the references.
                reused_existing += 1;
            } else {
                fs::copy(&item.path_abs, &dest)
                    .with_context(|| {
                        format!("copy {} -> {}", item.path_abs.display(), dest.display())
                    })?;
                migrated += 1;
            }

            let mut updated = item.clone();
            updated.path_abs = workspace.join(MEDIA_DIR).join(&dest_rel);
            updated.path_rel = Some(PathBuf::from(MEDIA_DIR).join(&dest_rel));
            updates.push((id, updated));
        }

        Ok((
            updates,
            (migrated, missing_sources, reused_existing),
        ))
    })
    .await
    .context("v1→v2 join")??;

    for (id, item) in updates {
        project.media_pool.insert(id, item);
    }

    let (migrated, missing_sources, reused_existing) = copy_report;
    report.migrated += migrated;
    report.missing_sources += missing_sources;
    report.reused_existing += reused_existing;
    Ok(())
}

/// Pick a destination filename in `media_dir`. Prefers the source file's
/// original basename; on collision (different file with same name), prefix
/// with the first 8 hex chars of the blake3 content hash. blake3 is
/// content-addressed so two distinct files cannot legitimately collide
/// after the prefix.
fn pick_dest_filename(media_dir: &Path, source: &Path, hash: &str) -> PathBuf {
    let base = source
        .file_name()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("media"));

    if !media_dir.join(&base).exists() {
        return base;
    }

    // Collision. Prefix with hash to disambiguate.
    let prefix = &hash[..hash.len().min(8)];
    let base_str = base.to_string_lossy();
    PathBuf::from(format!("{prefix}-{base_str}"))
}

/// Copy `<workspace>/project.json` to `<workspace>/Backups/pre-migration-
/// <ts>.json`. If `project.json` doesn't exist yet (shouldn't happen, but
/// defensive — the caller is mid-load), log and skip.
fn write_pre_migration_backup(workspace: &Path) -> Result<()> {
    let src = workspace.join(PROJECT_FILE);
    if !src.exists() {
        warn!(
            "pre-migration backup skipped: {} does not exist",
            src.display()
        );
        return Ok(());
    }
    let backups = workspace.join(BACKUPS_DIR);
    fs::create_dir_all(&backups)
        .with_context(|| format!("create {}", backups.display()))?;
    let ts = Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let dest = backups.join(format!("pre-migration-{ts}.json"));
    fs::copy(&src, &dest)
        .with_context(|| format!("copy {} -> {}", src.display(), dest.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
    use chrono::Utc;
    use tempfile::TempDir;

    fn legacy_item(path_abs: &Path) -> MediaItem {
        MediaItem {
            id: uuid::Uuid::now_v7(),
            label: None,
            path_abs: path_abs.to_path_buf(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata::default(),
            proxy_path: None,

            proxy_format_version: 0,
            waveform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "deadbeefdeadbeefdeadbeefdeadbeef".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn v1_to_v2_copies_media_and_sets_path_rel() {
        let ws_dir = TempDir::new().unwrap();
        let ws = ws_dir.path().join("doc.vproj");
        fs::create_dir_all(&ws).unwrap();

        // External source file. Pretend this lives wherever the user
        // imported from in the v1 days.
        let ext = TempDir::new().unwrap();
        let src = ext.path().join("interview.mp4");
        fs::write(&src, b"video bytes").unwrap();

        let mut project = Project::new_blank("legacy");
        project.schema_version = 1;
        let item = legacy_item(&src);
        let id = item.id;
        project.media_pool.insert(id, item);

        // Seed a project.json so the pre-migration backup has a source.
        super::super::save_to_dir(&project, &ws).await.unwrap();

        let report = run(&ws, &mut project).await.unwrap();
        assert_eq!(report.from_version, 1);
        assert_eq!(report.to_version, 5);
        assert_eq!(report.migrated, 1);
        assert_eq!(report.missing_sources, 0);

        let migrated = project.media_pool.get(&id).unwrap();
        assert_eq!(migrated.path_rel.as_ref().unwrap(), Path::new("Media/interview.mp4"));
        assert!(ws.join("Media").join("interview.mp4").is_file());
        assert!(ws.join("Backups").read_dir().unwrap().count() >= 1);
        assert_eq!(project.schema_version, 5);
    }

    #[tokio::test]
    async fn v1_to_v2_leaves_missing_sources_as_legacy() {
        let ws_dir = TempDir::new().unwrap();
        let ws = ws_dir.path().join("doc.vproj");
        fs::create_dir_all(&ws).unwrap();

        let mut project = Project::new_blank("legacy");
        project.schema_version = 1;
        let item = legacy_item(Path::new("/nonexistent/missing.mp4"));
        let id = item.id;
        project.media_pool.insert(id, item);
        super::super::save_to_dir(&project, &ws).await.unwrap();

        let report = run(&ws, &mut project).await.unwrap();
        assert_eq!(report.migrated, 0);
        assert_eq!(report.missing_sources, 1);

        // Item stays in legacy mode; the editor can still load.
        let still_legacy = project.media_pool.get(&id).unwrap();
        assert!(still_legacy.path_rel.is_none());
        assert_eq!(still_legacy.path_abs, Path::new("/nonexistent/missing.mp4"));
        assert_eq!(project.schema_version, 5);
    }

    #[tokio::test]
    async fn collision_gets_hash_prefix() {
        let ws_dir = TempDir::new().unwrap();
        let ws = ws_dir.path().join("doc.vproj");
        fs::create_dir_all(&ws).unwrap();

        let ext1 = TempDir::new().unwrap();
        let ext2 = TempDir::new().unwrap();
        let src1 = ext1.path().join("clip.mp4");
        let src2 = ext2.path().join("clip.mp4");
        fs::write(&src1, b"one").unwrap();
        fs::write(&src2, b"two").unwrap();

        let mut project = Project::new_blank("collide");
        project.schema_version = 1;
        let mut item1 = legacy_item(&src1);
        item1.file_hash_blake3 = "abcd1234abcd1234abcd1234abcd1234".into();
        let mut item2 = legacy_item(&src2);
        item2.file_hash_blake3 = "ffff5678ffff5678ffff5678ffff5678".into();
        let id1 = item1.id;
        let id2 = item2.id;
        project.media_pool.insert(id1, item1);
        project.media_pool.insert(id2, item2);
        super::super::save_to_dir(&project, &ws).await.unwrap();

        run(&ws, &mut project).await.unwrap();

        let rel1 = project.media_pool.get(&id1).unwrap().path_rel.clone().unwrap();
        let rel2 = project.media_pool.get(&id2).unwrap().path_rel.clone().unwrap();
        assert_ne!(rel1, rel2, "collided filenames must resolve to distinct paths");
        // One of them keeps the bare name, the other gets the hash prefix.
        let names: Vec<String> = [&rel1, &rel2]
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"clip.mp4".to_string()));
        assert!(names.iter().any(|n| n.contains("-clip.mp4")));
    }

    #[tokio::test]
    async fn v2_to_v4_is_pure_version_bump() {
        // A v2 project loads with `groups = []` and `Track.role = None`
        // via `#[serde(default)]`. The migration stamps `schema_version
        // = 4` and changes nothing else on the wire: no media moves, no
        // new tracks, no role auto-stamping. Reserved-track promotion
        // is `Project::new_blank`'s job, not the migrator's (Q8 of the
        // A/B-roll redesign locked "no auto-migration for legacy").
        let ws_dir = TempDir::new().unwrap();
        let ws = ws_dir.path().join("doc.vproj");
        fs::create_dir_all(&ws).unwrap();

        let mut project = Project::new_blank("v2-doc");
        project.schema_version = 2;
        // Strip the role stamps so this looks like a real v2 project
        // (which couldn't have had them — the field didn't exist yet).
        for t in project.tracks.iter_mut() {
            t.role = None;
        }
        super::super::save_to_dir(&project, &ws).await.unwrap();

        let report = run(&ws, &mut project).await.unwrap();
        assert_eq!(report.from_version, 2);
        assert_eq!(report.to_version, 5);
        assert_eq!(report.migrated, 0);
        assert_eq!(report.missing_sources, 0);
        assert_eq!(project.schema_version, 5);
        assert!(project.groups.is_empty());
        assert!(project.settings.auto_pair_audio_on_import);
        // Legacy tracks stay unstamped — no auto-promote.
        for t in project.tracks.iter() {
            assert!(t.role.is_none(), "legacy track must stay unstamped");
        }
    }

    #[tokio::test]
    async fn current_schema_project_is_noop() {
        let ws_dir = TempDir::new().unwrap();
        let ws = ws_dir.path().join("doc.vproj");
        fs::create_dir_all(&ws).unwrap();
        let mut project = Project::new_blank("v5-doc");
        super::super::save_to_dir(&project, &ws).await.unwrap();
        let report = run(&ws, &mut project).await.unwrap();
        assert_eq!(report.from_version, 5);
        assert_eq!(report.to_version, 5);
        assert_eq!(project.schema_version, 5);
    }
}
