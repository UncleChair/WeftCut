//! State commands for placing + listing Motifs (`add_motif` / `list_motifs`).
//! The lifecycle authoring commands live in `commands::motif_authoring`; both
//! reuse the `motifs::` cores so the MCP + renderer surfaces can't drift.

use crate::motifs::catalog;
use crate::napi_backend::Backend;
use crate::state::{Actor, CommandError, LayerParams, MotifParams, Transform, animated::Animated, time::TimeUs};
use uuid::Uuid;

/// Compute the layer's end time for `add_motif`. When the caller omits
/// `t_end_us` we extend by the motif's `default_duration_s`; otherwise we
/// pass the value through unchanged so the caller controls duration.
/// `saturating_add` guards the i64 overflow on absurd inputs.
///
/// `max_duration_us` is the motif's `max_duration_s` cap (in µs) or
/// `None` when unbounded. When present, the resolved length is clamped to
/// the cap so an explicit over-long `t_end_us` can't place the layer longer
/// than the manifest allows — mirrors the trim-time clamp in the actor.
pub(crate) fn resolve_motif_t_end_us(
    t_start_us: i64,
    t_end_us: Option<i64>,
    default_duration_s: f64,
    max_duration_us: Option<i64>,
) -> i64 {
    let end = match t_end_us {
        Some(end) => end,
        None => {
            let duration_us = (default_duration_s * 1_000_000.0) as i64;
            t_start_us.saturating_add(duration_us)
        }
    };
    match max_duration_us {
        Some(cap) if end - t_start_us > cap => t_start_us.saturating_add(cap),
        _ => end,
    }
}

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

/// Args for `add_motif` — the renderer sends camelCase top-level fields.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddMotifArgs {
    pub motif_id: String,
    pub t_start_us: TimeUs,
    pub t_end_us: Option<TimeUs>,
    pub track_id: Option<String>,
    pub props: Option<serde_json::Value>,
}

/// UI counterpart to the MCP `add_motif` tool. Mirrors the behavior 1:1
/// (canonicalize props through the catalog module,
/// default `t_end_us` from manifest duration; when `track_id` is
/// omitted, always spawn a fresh "Overlay" track so consecutive
/// inserts never collide with each other on the same track). Only
/// the actor identity differs — `Actor::User` here vs.
/// `Actor::Agent { client: "mcp" }` there.
pub async fn add_motif(b: &Backend, a: AddMotifArgs) -> Result<String, String> {
    let handle = b.project()?;
    let store = &b.motif_store;

    let motif_id = a.motif_id;
    let t_start_us = a.t_start_us;
    let t_end_us = a.t_end_us;
    let track_id = a.track_id;
    let props = a.props;

    let motif = catalog::builtins()
        .into_iter()
        .find(|t| t.id() == motif_id)
        .or_else(|| store.get_motif(&motif_id))
        .ok_or_else(|| {
            format!("unknown motif_id '{motif_id}' — call list_motifs for the catalog")
        })?;

    let provided = props.unwrap_or_else(|| serde_json::Value::Object(Default::default()));
    let canonical = motif
        .canonicalize_props(&provided)
        .map_err(|e| format!("invalid props: {e}"))?;
    let parsed: serde_json::Value =
        serde_json::from_str(&canonical).map_err(|e| format!("canonical props parse: {e}"))?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| "canonical props is not a JSON object".to_string())?;
    let props_map: imbl::HashMap<String, serde_json::Value> =
        obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect();

    // Resolve the end time (default-duration fallback + `max_duration_s` cap
    // clamp) via the shared helper so this command and the MCP `add_motif`
    // tool can't drift. The cap clamp here only bites explicit over-long
    // `t_end_us`; `add_layer` re-snaps both edges to the frame grid on entry.
    let resolved_end = resolve_motif_t_end_us(
        t_start_us,
        t_end_us,
        motif.manifest.default_duration_s,
        // Cap is driven by the props being added (canonicalized above), so a
        // `max_duration_prop`-mapped motif clamps to its prop value.
        crate::motifs::catalog::resolve_motif_max_dur_us(&motif.manifest, &props_map),
    );
    if resolved_end <= t_start_us {
        return Err(format!(
            "t_end_us {resolved_end} must be greater than t_start_us {t_start_us}",
        ));
    }

    let track = match track_id {
        Some(s) => Uuid::parse_str(&s).map_err(|e| format!("track_id: {e}"))?,
        None => handle
            // Every auto-routed motif insert gets its own track.
            // Reusing an existing "Overlay" track would re-trip the
            // per-track no-overlap invariant the moment a second
            // motif is added at a colliding range.
            .add_track(Actor::User, Some("Overlay".into()))
            .await
            .map_err(|e: CommandError| e.to_string())?,
    };

    let params = LayerParams::Motif(MotifParams {
        motif_id: motif.id().to_string(),
        motif_version: motif.manifest.version,
        props: props_map,
        src_in_us: 0,
        transform: Transform::default(),
        opacity: Animated::Static(1.0),
    });

    handle
        .add_layer(Actor::User, track, params, t_start_us, resolved_end)
        .await
        .map(|id| id.to_string())
        .map_err(|e: CommandError| e.to_string())
}
