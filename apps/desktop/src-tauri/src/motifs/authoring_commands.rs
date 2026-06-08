//! Tauri commands for the user-Motif authoring lifecycle: read a Motif's
//! source, write a draft, install (publish-new / update-in-place), delete.
//! UI-agnostic; the Stage-3 UI and the Stage-4 MCP tools both call these.

use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};

use super::authoring::{assign_unique_id, compose_motif_html, validate_manifest};
use super::catalog::{builtins, parse_manifest_island, Manifest, BUILTIN_IDS};
use super::store::UserMotifStore;

/// App-wide event emitted whenever the user-Motif catalog changes (a draft is
/// written, installed, or deleted). The frontend listens and re-pulls
/// `list_motifs` → `setUserMotifs` so a placed draft keeps resolving + the
/// picker refreshes.
pub const MOTIFS_CHANGED_EVENT: &str = "motifs:changed";

fn emit_motifs_changed(app: &AppHandle) {
    // Best-effort: a failed emit shouldn't fail the lifecycle op.
    let _ = app.emit(MOTIFS_CHANGED_EVENT, ());
}

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
    app: AppHandle,
    store: State<'_, UserMotifStore>,
    args: WriteDraftArgs,
) -> Result<String, String> {
    validate_manifest(&args.manifest).map_err(|e| e.to_string())?;
    // NOTE: every call mints a NEW draft id; the iterative edit UI reuses an
    // existing draft_id via `amend_motif_draft` (below) so refining a draft
    // doesn't litter <root>/drafts/ with abandoned dirs. The 3b-2 auto-save path
    // should still debounce or drop the motifs:changed emit on intermediate writes
    // (it fires a full list_motifs re-pull) — emit really only matters on install/delete.
    // Final-ready id: unique vs BOTH published and existing drafts, so the id
    // never changes on install (Model B → no layer rebind).
    let taken: Vec<String> = store
        .published_ids()
        .into_iter()
        .chain(store.list_draft_ids())
        .collect();
    let draft_id = assign_unique_id(&args.manifest.name, &taken);
    let mut manifest = args.manifest;
    manifest.id = draft_id.clone();
    let html = compose_motif_html(&manifest, &args.html);
    store.write_draft(&draft_id, &html).map_err(|e| e.to_string())?;
    emit_motifs_changed(&app);
    Ok(draft_id)
}

/// Core of `amend_motif_draft`: parse the manifest island out of an edited
/// full-source document, force the draft's stable identity (id + draft version 1
/// — id/version are app-assigned, never author-controlled), re-validate, and
/// overwrite the SAME draft on disk. No `AppHandle` here so it's unit-testable.
pub fn amend_draft_html(
    store: &UserMotifStore,
    draft_id: &str,
    source: &str,
) -> Result<(), String> {
    // Amend never CREATES — the draft must already exist (that's write_motif_draft's job).
    if store.get_draft(draft_id).is_none() {
        return Err(format!("unknown draft '{draft_id}'"));
    }
    let mut manifest = parse_manifest_island(source).map_err(|e| e.to_string())?;
    // Identity is app-owned: ignore any id/version the edited island claims.
    manifest.id = draft_id.to_string();
    manifest.version = 1;
    validate_manifest(&manifest).map_err(|e| e.to_string())?;
    // compose strips the (edited) island + re-injects a canonical one from
    // `manifest`; the body is preserved verbatim and round-trips.
    let html = compose_motif_html(&manifest, source);
    store.write_draft(draft_id, &html).map_err(|e| e.to_string())
}

/// Overwrite an existing draft from its full edited source (the in-app source
/// panel calls this). Distinct from `write_motif_draft`, which MINTS a new id;
/// amend keeps the id stable so a placed draft layer keeps resolving while you
/// edit. Emits `motifs:changed` so the catalog resyncs (new content_hash) and
/// the preview re-captures.
#[tauri::command]
pub async fn amend_motif_draft(
    app: AppHandle,
    store: State<'_, UserMotifStore>,
    draft_id: String,
    source: String,
) -> Result<(), String> {
    amend_draft_html(&store, &draft_id, &source)?;
    emit_motifs_changed(&app);
    Ok(())
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
    app: AppHandle,
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
            // The draft id was made final-ready at write time; keep it so placed
            // layers need no rebind. Guard the rare race where a published Motif
            // took the id since the draft was written.
            let id = draft.manifest.id.clone();
            if store.published_ids().iter().any(|p| p == &id) {
                return Err(format!(
                    "a Motif '{id}' is already installed; rename the draft before installing"
                ));
            }
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
    emit_motifs_changed(&app);
    Ok(final_id)
}

/// Delete a published user Motif. Built-ins are rejected.
#[tauri::command]
pub async fn delete_motif(
    app: AppHandle,
    store: State<'_, UserMotifStore>,
    id: String,
) -> Result<(), String> {
    if BUILTIN_IDS.contains(&id.as_str()) {
        return Err(format!("cannot delete the built-in Motif '{id}'"));
    }
    store.delete_user_motif(&id).map_err(|e| e.to_string())?;
    emit_motifs_changed(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::store::UserMotifStore;
    use super::super::catalog::Manifest;
    use super::super::authoring::{assign_unique_id, compose_motif_html};
    use std::collections::BTreeMap;

    fn m(name: &str) -> Manifest {
        Manifest { id: "ignored".into(), name: name.into(), version: 1, size: [100, 100],
            default_duration_s: 1.0, max_duration_s: None, max_duration_prop: None,
            content_duration_s: None, fonts: vec![], props_schema: BTreeMap::new() }
    }

    #[test]
    fn draft_id_is_final_ready_unique_vs_published_and_drafts() {
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let mut foo = m("Foo"); foo.id = "foo".into();
        store.write_draft("foo", &compose_motif_html(&foo,
            "<head></head><body><script>motif.define({setup(){}})</script></body>")).unwrap();
        store.install_draft("foo", "foo").unwrap();
        let taken: Vec<String> = store.published_ids().into_iter().chain(store.list_draft_ids()).collect();
        let id = assign_unique_id("Foo", &taken);
        assert_ne!(id, "foo");
        assert_eq!(id, "foo-2");
    }

    #[test]
    fn motifs_changed_event_name_is_stable() {
        assert_eq!(super::MOTIFS_CHANGED_EVENT, "motifs:changed");
    }

    /// The InstallMode tag grammar the frontend will send must deserialize.
    #[test]
    fn install_mode_deserializes() {
        let new: InstallMode = serde_json::from_str(r#"{"kind":"new"}"#).unwrap();
        assert!(matches!(new, InstallMode::New));
        let upd: InstallMode =
            serde_json::from_str(r#"{"kind":"update","target_id":"foo"}"#).unwrap();
        assert!(matches!(upd, InstallMode::Update { target_id } if target_id == "foo"));
    }

    #[test]
    fn amend_overwrites_same_draft_id_and_forces_id() {
        use super::super::store::UserMotifStore;
        use super::super::authoring::compose_motif_html;
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let mut man = m("Draft One"); man.id = "d1".into();
        store.write_draft("d1", &compose_motif_html(&man,
            "<head></head><body>one<script>motif.define({setup(){}})</script></body>")).unwrap();
        let edited = compose_motif_html(&{ let mut x = m("Renamed"); x.id = "hacker".into(); x },
            "<head></head><body>TWO<script>motif.define({setup(){}})</script></body>");
        super::amend_draft_html(&store, "d1", &edited).unwrap();
        assert_eq!(store.list_draft_ids(), vec!["d1".to_string()]); // no new draft minted
        let got = store.get_draft("d1").unwrap();
        assert_eq!(got.manifest.id, "d1");   // id forced back to draft id
        assert!(got.html.contains("TWO"));   // new body persisted
    }

    #[test]
    fn amend_rejects_unknown_draft_and_invalid_manifest() {
        use super::super::store::UserMotifStore;
        use super::super::authoring::compose_motif_html;
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let src = compose_motif_html(&m("X"), "<head></head><body>x</body>");
        assert!(super::amend_draft_html(&store, "nope", &src).is_err());
        let mut man = m("D"); man.id = "d1".into();
        store.write_draft("d1", &compose_motif_html(&man, "<head></head><body>x</body>")).unwrap();
        let mut bad = m("D"); bad.size = [0, 0];
        let bad_src = compose_motif_html(&bad, "<head></head><body>x</body>");
        assert!(super::amend_draft_html(&store, "d1", &bad_src).is_err());
    }
}
