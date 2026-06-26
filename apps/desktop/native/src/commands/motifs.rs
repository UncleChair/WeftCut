//! State commands for placing + listing Motifs (`add_motif` / `list_motifs`).
//! The lifecycle authoring commands live in `commands::motif_authoring`; both
//! reuse the `motifs::` cores so the MCP + renderer surfaces can't drift.

use crate::motifs::catalog;
use crate::napi_backend::Backend;

// `add_motif` (+ its `AddMotifArgs` and `resolve_motif_t_end_us` end-time helper)
// was the renderer fallback that wrote the Rust actor; under the always-on TS
// host `add_motif` is a pure TS mutation (Phase 4a-ii), so it's gone (Phase 4b).
// `list_motifs` (a PURE_NATIVE catalog read) stays.

/// Serialize a manifest + its raw `html` into the picker payload shape (a
/// superset of the MCP `list_motifs`: every manifest field plus `html` for the
/// client-side preview). One helper so built-in and user Motifs emit the same
/// shape. `status` is `"builtin"`, `"installed"`, or `"draft"`.
fn motif_to_payload(
    manifest: &crate::motifs::catalog::Manifest,
    html: String,
    status: &str,
) -> Result<serde_json::Value, String> {
    // Source-derived cache identity: blake3 of manifest+html (see docs/motifs.md,
    // "Raster cache and escalation").
    // Surfaced so the TS frame cache re-captures when a draft's source changes
    // (its `version` stays 1, so version alone can't bust the key).
    let content_hash = crate::motifs::catalog::Motif {
        manifest: manifest.clone(),
        html: html.clone(),
    }
    .content_hash();
    let mut v = serde_json::to_value(manifest).map_err(|e| format!("manifest serialize: {e}"))?;
    let obj = v
        .as_object_mut()
        .ok_or_else(|| "manifest is not a JSON object".to_string())?;
    obj.insert("html".to_string(), serde_json::Value::String(html));
    obj.insert("status".to_string(), serde_json::Value::String(status.to_string()));
    obj.insert("content_hash".to_string(), serde_json::Value::String(content_hash));
    Ok(v)
}

/// Sync core of `list_motifs`. Extracted so tests can call it without a
/// `Backend` wrapper. Skips entries that fail `motif_to_payload` (parse error /
/// bad on-disk state) rather than aborting the whole list — picker resilience.
pub(crate) fn list_motifs_inner(
    store: &crate::motifs::store::UserMotifStore,
) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    for t in catalog::builtins() {
        if let Ok(e) = motif_to_payload(&t.manifest, t.html, "builtin") {
            out.push(e);
        }
    }
    for manifest in store.list_manifests() {
        // list_manifests already confirmed index.html parsed; this re-reads it
        // for the picker payload. unwrap_or_default guards a TOCTOU (file
        // vanished / non-UTF-8 since the scan): the picker shows a blank card
        // rather than failing the whole list.
        let html = store.read_html(&manifest.id).unwrap_or_default();
        if let Ok(e) = motif_to_payload(&manifest, html, "installed") {
            out.push(e);
        }
    }
    // Drafts last, and only if their id isn't already published/built-in — so
    // `id` is a unique key in the result even if an abnormal on-disk state has a
    // draft shadowing a published id (published wins, matching read_file).
    let seen: std::collections::HashSet<String> = out
        .iter()
        .filter_map(|v| v.get("id").and_then(|s| s.as_str()).map(str::to_string))
        .collect();
    for draft in store.list_drafts() {
        let draft_id = draft.id().to_string();
        if seen.contains(&draft_id) {
            continue;
        }
        let Ok(mut entry) = motif_to_payload(&draft.manifest, draft.html, "draft") else {
            continue;
        };
        if let Some(target) = store.read_draft_target(&draft_id) {
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("target_id".to_string(), serde_json::Value::String(target));
            }
        }
        out.push(entry);
    }
    out
}

/// The UI catalog: a superset of the MCP `list_motifs` payload — every
/// manifest field plus the raw `html` document so the picker can render live
/// previews client-side.
pub async fn list_motifs(b: &Backend) -> Result<Vec<serde_json::Value>, String> {
    Ok(list_motifs_inner(&b.motif_store))
}
