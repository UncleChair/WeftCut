//! Tauri commands for the user-Motif authoring lifecycle: read a Motif's
//! source, write a draft, install (publish-new / update-in-place), delete.
//! UI-agnostic; the Stage-3 UI and the Stage-4 MCP tools both call these.

use serde::Deserialize;
use tauri::State;

use super::authoring::{assign_unique_id, compose_motif_html, validate_manifest};
use super::catalog::{builtins, Manifest, BUILTIN_IDS};
use super::store::UserMotifStore;

/// `{ manifest, html }` of a Motif's source. Returned by `get_motif_source`.
#[derive(serde::Serialize)]
pub struct MotifSource {
    pub manifest: Manifest,
    pub html: String,
}

/// Read any built-in or user Motif's source (for the "edit" seed).
#[tauri::command]
pub async fn get_motif_source(
    store: State<'_, UserMotifStore>,
    id: String,
) -> Result<MotifSource, String> {
    if let Some(m) = builtins().into_iter().find(|m| m.id() == id) {
        return Ok(MotifSource { manifest: m.manifest, html: m.html });
    }
    if let Some(m) = store.get_motif(&id) {
        return Ok(MotifSource { manifest: m.manifest, html: m.html });
    }
    Err(format!("unknown motif id '{id}'"))
}

/// NOTE: Tauri camelCases only the TOP-LEVEL command argument names; these
/// nested struct fields are deserialized by serde directly, so the frontend
/// sends them as-is (snake_case): `{ args: { draft_id, mode: { kind, target_id } } }`.
/// (A camelCase rename can be added in Stage 3 alongside the UI if preferred.)
#[derive(Deserialize)]
pub struct WriteDraftArgs {
    pub manifest: Manifest,
    pub html: String,
}

/// Validate + compose + write a draft. Returns the assigned draft id.
#[tauri::command]
pub async fn write_motif_draft(
    store: State<'_, UserMotifStore>,
    args: WriteDraftArgs,
) -> Result<String, String> {
    validate_manifest(&args.manifest).map_err(|e| e.to_string())?;
    // TODO(stage 3): every call mints a NEW draft id; an iterative edit UI will
    // want an amend path (reuse an existing draft_id) so refining a draft doesn't
    // litter <root>/drafts/ with abandoned dirs.
    let draft_id = assign_unique_id(&args.manifest.name, &store.list_draft_ids());
    let mut manifest = args.manifest;
    manifest.id = draft_id.clone();
    let html = compose_motif_html(&manifest, &args.html);
    store.write_draft(&draft_id, &html).map_err(|e| e.to_string())?;
    Ok(draft_id)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstallMode {
    New,
    Update { target_id: String },
}

/// NOTE: Tauri camelCases only the TOP-LEVEL command argument names; these
/// nested struct fields are deserialized by serde directly, so the frontend
/// sends them as-is (snake_case): `{ args: { draft_id, mode: { kind, target_id } } }`.
/// (A camelCase rename can be added in Stage 3 alongside the UI if preferred.)
#[derive(Deserialize)]
pub struct InstallArgs {
    pub draft_id: String,
    pub mode: InstallMode,
}

/// Promote a draft to a published user Motif. Returns the published id.
#[tauri::command]
pub async fn install_motif(
    store: State<'_, UserMotifStore>,
    args: InstallArgs,
) -> Result<String, String> {
    let draft = store
        .get_draft(&args.draft_id)
        .ok_or_else(|| format!("unknown draft '{}'", args.draft_id))?;
    // Re-validate at the install gate (defense in depth — the draft file on
    // disk could have been hand-edited since write).
    validate_manifest(&draft.manifest).map_err(|e| e.to_string())?;

    let (final_id, version) = match args.mode {
        InstallMode::New => {
            let id = assign_unique_id(&draft.manifest.name, &store.published_ids());
            (id, 1)
        }
        InstallMode::Update { target_id } => {
            if BUILTIN_IDS.contains(&target_id.as_str()) {
                return Err(format!("cannot overwrite the built-in Motif '{target_id}'"));
            }
            let prev = store
                .get_motif(&target_id)
                .ok_or_else(|| format!("update target '{target_id}' is not an installed Motif"))?;
            // Bump version so the (version-keyed) frame cache invalidates -> all
            // placed layers re-render with the new look (live/mutable).
            (target_id, prev.manifest.version.saturating_add(1))
        }
    };

    let mut manifest = draft.manifest;
    manifest.id = final_id.clone();
    manifest.version = version;
    let html = compose_motif_html(&manifest, &draft.html);
    // Rewrite the draft's island to the final id + bumped version, THEN move it
    // into the published slot. Order matters: if install_draft fails, the only
    // dirty state is the DRAFT (its island momentarily names final_id while its
    // dir is still draft_id) — the published store is never left inconsistent,
    // and a retry re-derives the same final_id and re-runs both steps safely.
    store.write_draft(&args.draft_id, &html).map_err(|e| e.to_string())?;
    store
        .install_draft(&args.draft_id, &final_id)
        .map_err(|e| e.to_string())?;
    Ok(final_id)
}

/// Delete a published user Motif. Built-ins are rejected.
#[tauri::command]
pub async fn delete_motif(
    store: State<'_, UserMotifStore>,
    id: String,
) -> Result<(), String> {
    if BUILTIN_IDS.contains(&id.as_str()) {
        return Err(format!("cannot delete the built-in Motif '{id}'"));
    }
    store.delete_user_motif(&id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The InstallMode tag grammar the frontend will send must deserialize.
    #[test]
    fn install_mode_deserializes() {
        let new: InstallMode = serde_json::from_str(r#"{"kind":"new"}"#).unwrap();
        assert!(matches!(new, InstallMode::New));
        let upd: InstallMode =
            serde_json::from_str(r#"{"kind":"update","target_id":"foo"}"#).unwrap();
        assert!(matches!(upd, InstallMode::Update { target_id } if target_id == "foo"));
    }
}
