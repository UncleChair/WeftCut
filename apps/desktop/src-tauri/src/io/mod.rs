//! Project save/load (`.vproj` folder), schema migrations, media probing.
//!
//! On-disk layout, versioning rules: `docs/data-model.md`
//! ("On-disk format: `.vproj` folder" and "Versioning").
//!
//! Phase 1 footprint: write/read `project.json` + `schema_version` files,
//! probe + hash imported media. Migrations, cache/history subdirs, proxy +
//! thumbnail + waveform generation come online as their phases land.

pub mod probe;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tracing::info;

use crate::state::{Project, project::SCHEMA_VERSION};

pub const PROJECT_FILE: &str = "project.json";
pub const SCHEMA_FILE: &str = "schema_version";

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
pub async fn load_from_dir(dir: &Path) -> Result<Project> {
    let path: PathBuf = dir.join(PROJECT_FILE);
    let json = tokio::task::spawn_blocking(move || -> Result<String> {
        fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))
    })
    .await
    .context("load_from_dir join")??;

    let project: Project = serde_json::from_str(&json).context("deserialize project")?;
    if project.schema_version > SCHEMA_VERSION {
        anyhow::bail!(
            "project was saved with schema_version {} but this build supports up to {}",
            project.schema_version,
            SCHEMA_VERSION
        );
    }
    // Future: run migration chain here when schema_version < SCHEMA_VERSION.
    info!(
        "project loaded ({} → {}, schema {})",
        dir.display(),
        project.metadata.name,
        project.schema_version
    );
    Ok(project)
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
    async fn rejects_future_schema_version() {
        let dir = TempDir::new().unwrap();
        let vproj = dir.path().join("future.vproj");

        let mut p = Project::new_blank("from-the-future");
        p.schema_version = SCHEMA_VERSION + 100;
        save_to_dir(&p, &vproj).await.unwrap();

        let err = load_from_dir(&vproj).await.expect_err("future schema");
        assert!(format!("{err:#}").contains("schema_version"));
    }
}
