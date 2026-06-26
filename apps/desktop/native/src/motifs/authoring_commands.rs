//! Core functions for the user-Motif authoring lifecycle: read a Motif's
//! source, write a draft, install (publish-new / update-in-place), delete.
//! UI-agnostic; the Stage-3 UI and the Stage-4 MCP tools both call these.

use serde::Deserialize;

use super::authoring::{assign_unique_id, compose_motif_html, validate_manifest};
use super::catalog::{builtins, parse_manifest_island, Manifest, BUILTIN_IDS};
use super::store::UserMotifStore;

/// App-wide event emitted whenever the user-Motif catalog changes (a draft is
/// written, installed, or deleted). The frontend listens and re-pulls
/// `list_motifs` → `setUserMotifs` so a placed draft keeps resolving + the
/// picker refreshes.
pub const MOTIFS_CHANGED_EVENT: &str = "motifs:changed";

/// `{ manifest, html }` of a Motif's source. Returned by `get_motif_source_core`.
#[derive(serde::Serialize)]
pub struct MotifSource {
    pub manifest: Manifest,
    pub html: String,
}

/// Read any built-in or user Motif's source (for the "edit" seed). Core of the
/// former `get_motif_source` command; no `State` so the dispatch arm + tests can call it.
pub fn get_motif_source_core(store: &UserMotifStore, id: &str) -> Result<MotifSource, String> {
    if let Some(m) = builtins().into_iter().find(|m| m.id() == id) {
        return Ok(MotifSource { manifest: m.manifest, html: m.html });
    }
    if let Some(m) = store.get_motif(id) {
        return Ok(MotifSource { manifest: m.manifest, html: m.html });
    }
    Err(format!("unknown motif id '{id}'"))
}

/// NOTE: napi/serde camelCases only the TOP-LEVEL command argument names; these
/// nested struct fields are deserialized by serde directly, so the frontend
/// sends them as-is (snake_case): `{ args: { draft_id, mode: { kind, target_id } } }`.
#[derive(Deserialize)]
pub struct WriteDraftArgs {
    pub manifest: Manifest,
    pub html: String,
}

/// Core of `write_motif_draft`: validate + mint a final-ready unique id (vs
/// published + existing drafts) — the id a draft is born with is the one it keeps
/// when published, so install-new needs no layer rebind — + compose +
/// write the draft. Identity is app-owned: the id is minted from the name and
/// `version` is forced to 1 (any id/version in `manifest` is ignored). When
/// `from` is `Some`, record it as the draft's Update target (`target` sidecar) so
/// a later `install_motif {Update}` republishes over it. No `EventSink` / no emit
/// — the command + the MCP tool wrap this and emit `motifs:changed` themselves.
pub fn write_motif_draft_core(
    store: &UserMotifStore,
    manifest: Manifest,
    html: &str,
    from: Option<&str>,
) -> Result<String, String> {
    let mut manifest = manifest;
    validate_manifest(&manifest).map_err(|e| e.to_string())?;
    let taken: Vec<String> = store
        .published_ids()
        .into_iter()
        .chain(store.list_draft_ids())
        .collect();
    let draft_id = assign_unique_id(&manifest.name, &taken);
    manifest.id = draft_id.clone();
    manifest.version = 1;
    let composed = compose_motif_html(&manifest, html);
    store.write_draft(&draft_id, &composed).map_err(|e| e.to_string())?;
    if let Some(target) = from {
        store.write_draft_target(&draft_id, target).map_err(|e| e.to_string())?;
    }
    Ok(draft_id)
}

/// Core of `amend_motif_draft`: parse the manifest island out of an edited
/// full-source document, force the draft's stable identity (id + draft version 1
/// — id/version are app-assigned, never author-controlled), re-validate, and
/// overwrite the SAME draft on disk. No `EventSink` here so it's unit-testable.
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

/// Core of `create_edit_draft`: seed a NEW working draft from `source_id`'s
/// source (built-in or installed), assign a unique working id, and — for an
/// INSTALLED source — record it as the draft's Update target (built-ins can't be
/// updated in place, so a built-in fork records no target → install offers only
/// New). No `EventSink` so it's unit-testable.
pub fn create_edit_draft_core(
    store: &UserMotifStore,
    builtins: &[crate::motifs::catalog::Motif],
    source_id: &str,
) -> Result<String, String> {
    let is_builtin = BUILTIN_IDS.contains(&source_id);
    let source = builtins.iter().find(|m| m.id() == source_id).cloned()
        .or_else(|| store.get_motif(source_id))
        .ok_or_else(|| format!("unknown source motif '{source_id}'"))?;

    let taken: Vec<String> = store.published_ids().into_iter()
        .chain(store.list_draft_ids()).collect();
    let draft_id = assign_unique_id(&source.manifest.name, &taken);

    let mut manifest = source.manifest;
    manifest.id = draft_id.clone();
    manifest.version = 1;
    let html = compose_motif_html(&manifest, &source.html);
    store.write_draft(&draft_id, &html).map_err(|e| e.to_string())?;
    if !is_builtin {
        store.write_draft_target(&draft_id, source_id).map_err(|e| e.to_string())?;
    }
    Ok(draft_id)
}

/// Core of `import_motif`: parse + validate the manifest island from an external
/// `.html` source, mint a FRESH unique draft id (ignoring any id/version the file
/// claims — identity is app-owned), and write it as a from-scratch draft (no
/// target sidecar → it installs as a new Motif, never Update-over-something). No
/// `EventSink` so it's unit-testable.
pub fn import_motif_from_source(store: &UserMotifStore, source: &str) -> Result<String, String> {
    let mut manifest = parse_manifest_island(source).map_err(|e| e.to_string())?;
    let taken: Vec<String> = store
        .published_ids()
        .into_iter()
        .chain(store.list_draft_ids())
        .collect();
    let draft_id = assign_unique_id(&manifest.name, &taken);
    manifest.id = draft_id.clone();
    manifest.version = 1;
    validate_manifest(&manifest).map_err(|e| e.to_string())?;
    let html = compose_motif_html(&manifest, source);
    store.write_draft(&draft_id, &html).map_err(|e| e.to_string())?;
    Ok(draft_id)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InstallMode {
    New,
    Update { target_id: String },
}

/// NOTE: napi/serde camelCases only the TOP-LEVEL command argument names; these
/// nested struct fields are deserialized by serde directly, so the frontend
/// sends them as-is (snake_case): `{ args: { draft_id, mode: { kind, target_id } } }`.
#[derive(Deserialize)]
pub struct InstallArgs {
    pub draft_id: String,
    pub mode: InstallMode,
}

/// Publish the draft (store side) + (Update mode) build the rebind updates from
/// `snap`'s motif layers; returns `(published_id, updates)`. New mode → empty
/// updates. The SINGLE source of the install draft-publish + Update-rebind-build
/// logic — does NOT write the actor (the caller applies the rebind). The caller
/// supplies the snapshot: `install_motif_core` passes the live actor snapshot
/// (renderer + MCP flag-off); the napi hybrid passes the read-mirror snapshot.
/// No `EventSink` / no emit — the command + the MCP tool wrap this and emit
/// `motifs:changed` themselves.
pub async fn install_motif_compute(
    store: &UserMotifStore,
    snap: &std::sync::Arc<crate::state::Project>,
    args: &InstallArgs,
) -> Result<(String, Vec<crate::state::MotifRebindEntry>), String> {
    let draft = store
        .get_draft(&args.draft_id)
        .ok_or_else(|| format!("unknown draft '{}'", args.draft_id))?;
    // Re-validate at the install gate (defense in depth — the draft file on
    // disk could have been hand-edited since write).
    validate_manifest(&draft.manifest).map_err(|e| e.to_string())?;

    // Track whether this install is an in-place Update: only an Update retargets
    // + migrates existing project layers (New keeps a stable id → no rebind).
    let mut is_update = false;
    let (final_id, version) = match &args.mode {
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
                .get_motif(target_id)
                .ok_or_else(|| format!("update target '{target_id}' is not an installed Motif"))?;
            is_update = true;
            // Bump version so the (version-keyed) frame cache invalidates -> all
            // placed layers re-render with the new look (live/mutable).
            (target_id.clone(), prev.manifest.version.saturating_add(1))
        }
    };

    let mut manifest = draft.manifest;
    manifest.id = final_id.clone();
    manifest.version = version;
    let html = compose_motif_html(&manifest, &draft.html);
    // Rewrite the draft's island to the final id + bumped version, THEN move it
    // into the published slot. Order matters: if install_draft fails, the only
    // dirty state is the DRAFT — the published store is never left inconsistent,
    // and a retry re-derives the same final_id and re-runs both steps safely.
    store.write_draft(&args.draft_id, &html).map_err(|e| e.to_string())?;
    store
        .install_draft(&args.draft_id, &final_id)
        .map_err(|e| e.to_string())?;

    // For an in-place Update, retarget current-project layers from the working
    // draft (and any already on the target) onto the now-published target, and
    // lenient-migrate their props to the target's NEW schema. The layers come
    // from `snap` — project LAYERS (motif_id/version/props) are independent of
    // the store publish above, so the caller may snapshot before or after.
    let updates = if is_update {
        let target_manifest = store
            .get_motif(&final_id)
            .ok_or_else(|| format!("installed target '{final_id}' not readable"))?
            .manifest;
        let layers: Vec<(crate::state::ids::LayerId, String, serde_json::Value)> = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .filter_map(|l| match &l.params {
                crate::state::LayerParams::Motif(p) => Some((
                    l.id,
                    p.motif_id.clone(),
                    serde_json::Value::Object(
                        p.props.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                    ),
                )),
                _ => None,
            })
            .collect();
        build_rebind_updates(&layers, &args.draft_id, &target_manifest)
    } else {
        vec![]
    };
    Ok((final_id, updates))
}

/// Core of `install_motif`: publish the draft + (Update mode) retarget +
/// lenient-migrate current-project layers via `rebind_motif`. Returns the
/// published id. Delegates the publish + rebind-build to `install_motif_compute`
/// (the single source) and applies the rebind to the actor. No `EventSink` / no
/// emit — the command + the MCP tool wrap this and emit `motifs:changed`.
pub async fn install_motif_core(
    store: &UserMotifStore,
    handle: &crate::state::ProjectHandle,
    args: &InstallArgs,
) -> Result<String, String> {
    let snap = handle.snapshot().await;
    let (final_id, updates) = install_motif_compute(store, &snap, args).await?;
    if !updates.is_empty() {
        handle
            .rebind_motif(crate::state::Actor::User, updates)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(final_id)
}

/// Build per-layer rebind updates for an Update: every layer whose `motif_id`
/// is the working draft id OR the target id ends up on the target id, at the new
/// version, with props lenient-migrated to the new schema (drop unknown keys,
/// fill new defaults, fall back invalid values). `layers` = the
/// `(layer_id, motif_id, props_json)` triples extracted from the snapshot. Pure
/// (no actor / no I/O) so it's unit-testable in isolation.
pub fn build_rebind_updates(
    layers: &[(crate::state::ids::LayerId, String, serde_json::Value)],
    working_id: &str,
    target: &crate::motifs::catalog::Manifest,
) -> Vec<crate::state::MotifRebindEntry> {
    let probe = crate::motifs::catalog::Motif { manifest: target.clone(), html: String::new() };
    layers
        .iter()
        .filter(|(_, mid, _)| mid == working_id || mid == &target.id)
        .map(|(layer_id, _, props_json)| {
            // Lenient migration: drop keys not in the new schema, fill new
            // defaults, fall back any value that fails its spec. The only Err
            // mode is the final serialize (can't fail for default-filled
            // values); on the off-chance it does, fall back to all-defaults.
            let canonical = probe.canonicalize_props_lenient(props_json).unwrap_or_default();
            let parsed: serde_json::Value =
                serde_json::from_str(&canonical).unwrap_or_else(|_| serde_json::json!({}));
            let props: imbl::HashMap<String, serde_json::Value> = parsed
                .as_object()
                .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default();
            crate::state::MotifRebindEntry {
                layer_id: *layer_id,
                motif_id: target.id.clone(),
                motif_version: target.version,
                props,
            }
        })
        .collect()
}

/// Delete a published user Motif (built-ins rejected). Core of the former
/// `delete_motif` command; no `State`/no emit.
pub fn delete_motif_core(store: &UserMotifStore, id: &str) -> Result<(), String> {
    if BUILTIN_IDS.contains(&id) {
        return Err(format!("cannot delete the built-in Motif '{id}'"));
    }
    store.delete_user_motif(id).map_err(|e| e.to_string())
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
    fn create_edit_draft_seeds_unique_id_and_records_target_for_installed() {
        use super::super::store::UserMotifStore;
        use super::super::authoring::compose_motif_html;
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let mut man = m("Foo"); man.id = "foo".into();
        store.write_draft("foo", &compose_motif_html(&man,
            "<head></head><body>FOO<script>motif.define({setup(){}})</script></body>")).unwrap();
        store.install_draft("foo", "foo").unwrap();

        let draft_id = super::create_edit_draft_core(&store, &[], "foo").unwrap();
        assert_ne!(draft_id, "foo");
        let d = store.get_draft(&draft_id).unwrap();
        assert!(d.html.contains("FOO"));
        assert_eq!(d.manifest.id, draft_id);
        assert_eq!(store.read_draft_target(&draft_id).as_deref(), Some("foo"));
    }

    #[test]
    fn create_edit_draft_from_builtin_records_no_target() {
        use super::super::store::UserMotifStore;
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        let builtins = super::super::catalog::builtins();
        let draft_id = super::create_edit_draft_core(&store, &builtins, "countdown").unwrap();
        assert!(store.get_draft(&draft_id).is_some());
        assert_eq!(store.read_draft_target(&draft_id), None);
        assert!(super::create_edit_draft_core(&store, &builtins, "nope").is_err());
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

    #[test]
    fn build_rebind_updates_retargets_draft_and_migrates_target_layers() {
        use crate::motifs::catalog::PropSpec;
        use crate::state::ids::{new_id, LayerId};
        let mut man = m("Foo");
        man.id = "foo".into();
        man.version = 2;
        man.props_schema
            .insert("title".into(), PropSpec::String { default: "Hi".into(), max_length: None, multiline: None });
        let la: LayerId = new_id();
        let lb: LayerId = new_id();
        let layers = vec![
            (la, "wip".to_string(), serde_json::json!({"old": 1})),
            (lb, "foo".to_string(), serde_json::json!({"old": 2})),
        ];
        let updates = super::build_rebind_updates(&layers, "wip", &man);
        assert_eq!(updates.len(), 2);
        for u in &updates {
            assert_eq!(u.motif_id, "foo");
            assert_eq!(u.motif_version, 2);
            assert!(!u.props.contains_key("old")); // dropped (lenient)
            assert_eq!(u.props.get("title").and_then(|v| v.as_str()), Some("Hi")); // filled default
        }
    }

    #[test]
    fn import_motif_from_source_mints_unique_draft_and_ignores_claimed_id() {
        use super::super::store::UserMotifStore;
        use super::super::authoring::compose_motif_html;
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        // A composed file whose island claims a built-in id — import must ignore it
        // and mint a fresh unique id.
        let mut man = m("Imported"); man.id = "countdown".into();
        let source = compose_motif_html(&man,
            "<head></head><body>IMPORTED<script>motif.define({setup(){}})</script></body>");
        let draft_id = super::import_motif_from_source(&store, &source).unwrap();
        assert_ne!(draft_id, "countdown");
        let d = store.get_draft(&draft_id).unwrap();
        assert_eq!(d.manifest.id, draft_id);   // island rewritten to the minted id
        assert!(d.html.contains("IMPORTED"));  // body preserved
        assert_eq!(store.read_draft_target(&draft_id), None); // imported draft has no Update target
    }

    #[test]
    fn import_motif_from_source_rejects_missing_or_invalid_island() {
        use super::super::store::UserMotifStore;
        use super::super::authoring::compose_motif_html;
        let tmp = tempfile::tempdir().unwrap();
        let store = UserMotifStore::new(tmp.path().to_path_buf());
        assert!(super::import_motif_from_source(&store, "<html><body>no island</body></html>").is_err());
        let mut bad = m("Bad"); bad.size = [0, 0];
        let src = compose_motif_html(&bad, "<head></head><body>x</body>");
        assert!(super::import_motif_from_source(&store, &src).is_err());
    }
}
