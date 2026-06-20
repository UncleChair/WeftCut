//! Schema migration: the schema-version gate.
//!
//! Pre-release: when the schema version moves we don't bother carrying
//! forward old `.vproj` folders. `run()` accepts anything at the
//! current `SCHEMA_VERSION` and rejects everything below it with a
//! clear error. Higher versions are rejected upstream in
//! `load_from_dir` (we only know how to load what this build was
//! compiled for).

use std::path::Path;

use anyhow::Result;

use crate::state::Project;
use crate::state::project::SCHEMA_VERSION;

/// Verify that `project.schema_version` matches the build's
/// `SCHEMA_VERSION`. Returns Ok on match, Err with a guidance message
/// otherwise. Called once per load from `io::load_from_dir`.
pub async fn run(_workspace: &Path, project: &Project) -> Result<()> {
    if project.schema_version == SCHEMA_VERSION {
        return Ok(());
    }
    // < SCHEMA_VERSION: pre-release, no migration path. The user has
    // to re-import into a fresh workspace; their old .vproj folder is
    // unsalvageable through this code path.
    if project.schema_version < SCHEMA_VERSION {
        anyhow::bail!(
            "project schema v{} is below the supported minimum v{}. \
             Pre-release builds don't migrate older `.vproj` folders forward — \
             re-create the project in a fresh workspace.",
            project.schema_version,
            SCHEMA_VERSION,
        );
    }
    // > SCHEMA_VERSION should never reach here (load_from_dir guards),
    // but defensively bail rather than silently mis-loading.
    anyhow::bail!(
        "project schema v{} is newer than this build (v{}). \
         Update the app.",
        project.schema_version,
        SCHEMA_VERSION,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[tokio::test]
    async fn current_schema_passes() {
        let project = Project::new_blank("current");
        let ws = TempDir::new().unwrap();
        run(ws.path(), &project).await.expect("current schema");
    }

    #[tokio::test]
    async fn older_schema_is_rejected_with_guidance() {
        let mut project = Project::new_blank("legacy");
        project.schema_version = SCHEMA_VERSION - 1;
        let ws = TempDir::new().unwrap();
        let err = run(ws.path(), &project)
            .await
            .expect_err("legacy schema must error");
        let msg = format!("{err:#}");
        // The guidance text mentions both the user's version and the
        // build's target so a support thread can copy/paste it.
        assert!(msg.contains(&format!("v{}", SCHEMA_VERSION - 1)));
        assert!(msg.contains(&format!("v{SCHEMA_VERSION}")));
        assert!(msg.to_lowercase().contains("fresh workspace"));
    }

    #[tokio::test]
    async fn newer_schema_is_rejected() {
        let mut project = Project::new_blank("future");
        project.schema_version = SCHEMA_VERSION + 5;
        let ws = TempDir::new().unwrap();
        let err = run(ws.path(), &project)
            .await
            .expect_err("future schema must error");
        let msg = format!("{err:#}");
        assert!(msg.contains("newer than this build"));
    }

    // Sanity: workspace path is unused by the new run() but kept in
    // the signature for forward compat (a future migration might need
    // it again). This test pins that contract.
    #[tokio::test]
    async fn workspace_path_is_currently_ignored() {
        let project = Project::new_blank("anywhere");
        let bogus = PathBuf::from("Z:/does/not/exist");
        run(&bogus, &project).await.expect("noop on current schema");
    }
}
