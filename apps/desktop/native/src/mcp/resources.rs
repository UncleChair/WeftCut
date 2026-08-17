//! MCP resource readers, transport-free. `read_resource(b, uri, state_json)`
//! dispatches `project://compiled`, `composition://meter` and `media://*`,
//! returning the wire `ResourceResult`; the `project://*` state views are
//! served by the TS MCP host, not here.
//!
//! JSON resources are pretty-printed into a `ResourceContent::Text`; binary
//! ones base64-encode the bytes into a `ResourceContent::Blob`.

use serde_json::Value;
use uuid::Uuid;

use crate::napi_backend::Backend;

#[cfg(feature = "jobs")]
use crate::cache::cached_ok;
#[cfg(feature = "jobs")]
use crate::jobs;
#[cfg(feature = "jobs")]
use crate::state::{MediaId, MediaItem};

use super::wire::{McpToolError, ResourceContent, ResourceDef, ResourceResult};

const URI_PROJECT: &str = "project://current";
const URI_COMPOSITION: &str = "project://composition";
const URI_MEDIA: &str = "project://media";
const URI_TRACKS: &str = "project://tracks";
const URI_MARKERS: &str = "project://markers";
const URI_HISTORY: &str = "project://history";
const URI_COMPILED: &str = "project://compiled";
const URI_METER: &str = "composition://meter";
const PREFIX_MEDIA: &str = "media://";

const APP_JSON: &str = "application/json";
#[cfg(feature = "jobs")]
const APP_OCTET: &str = "application/octet-stream";
#[cfg(feature = "jobs")]
const IMAGE_JPEG: &str = "image/jpeg";

/// The state slice the TS MCP host injects for the resources that stay Rust
/// compute: `project://compiled` needs the full project (audio mix
/// plan); `media://*` needs the `MediaItem` resolved by id. `composition://meter`
/// reads live Rust state and needs neither. Both fields `serde(default)` so a
/// stateless read (`{}`) parses cleanly.
#[derive(Default, serde::Deserialize)]
struct ResourceState {
    #[serde(default)]
    project: Option<crate::state::Project>,
    #[serde(default)]
    media: Option<crate::state::MediaItem>,
    /// Injected by the TS host for `media://{id}/description`: the merged
    /// video-understanding backend config (so the cached-view read can resolve
    /// the default backend + compute the cache key). Stateless — same pattern as
    /// `describe_clip`'s injected config (ADR 0024). Empty → "no backend".
    #[cfg(feature = "speech")]
    #[serde(default)]
    vlm_config: std::collections::HashMap<String, crate::vlm::BackendConfig>,
}

fn serialize_err(e: serde_json::Error) -> McpToolError {
    McpToolError::internal_error(format!("serialize: {e}"), None)
}

/// Wrap a pretty-printed JSON body in a `ResourceResult` text content block.
fn text_resource(uri: &str, body: &Value) -> Result<ResourceResult, McpToolError> {
    let text = serde_json::to_string_pretty(body).map_err(serialize_err)?;
    Ok(ResourceResult {
        contents: vec![ResourceContent::Text {
            uri: uri.to_string(),
            mime_type: Some(APP_JSON.to_string()),
            text,
        }],
    })
}

pub(crate) async fn read_resource(
    b: &Backend,
    uri: &str,
    state_json: &str,
) -> Result<ResourceResult, McpToolError> {
    let state: ResourceState = serde_json::from_str(state_json).map_err(|e| {
        McpToolError::internal_error(format!("resource state injection: {e}"), None)
    })?;

    // media://* needs the MediaItem the TS host resolved by id (TS owns state).
    // Peeled off ahead of the URI match: thumbnail / frame / waveform return
    // blobs, /description and /analysis return JSON.
    if let Some(tail) = uri.strip_prefix(PREFIX_MEDIA) {
        // /description — cached VLM view, needs the injected config; see
        // `read_description_resource`.
        #[cfg(feature = "speech")]
        if let Some(id_part) = tail.strip_suffix("/description") {
            return read_description_resource(b, uri, id_part, state.media, &state.vlm_config).await;
        }
        // /analysis — always computable, computes on miss; see
        // `read_analysis_resource`.
        #[cfg(feature = "jobs")]
        if let Some(id_part) = tail.strip_suffix("/analysis") {
            return read_analysis_resource(b, uri, id_part, state.media).await;
        }
        return read_media_resource(b, uri, tail, state.media).await;
    }

    let body: Value = match uri {
        URI_METER => meter_payload(b),
        URI_COMPILED => {
            // The audio mix plan IS the compiled view of the export audio pipeline
            // (ADR 0019). Envelope point COUNTS, not values — keyframed gain on a
            // long layer would be hundreds of thousands of floats. A transient
            // ConformMissing state reports inline instead of failing the read. The
            // TS host injects the full project — this resource is agent-triggered
            // and infrequent.
            let project = state.project.ok_or_else(|| {
                McpToolError::internal_error(
                    "project://compiled requires the injected project (TS host)".to_string(),
                    None,
                )
            })?;
            match crate::audio::mix::plan_for_project(&project, None) {
                Ok(plan) => serde_json::json!({
                    "kind": "audio_mix_plan",
                    "sample_rate": crate::audio::mix::MIX_SAMPLE_RATE,
                    "window_frames": [plan.window_start_frame, plan.window_end_frame],
                    "layers": plan.layers.iter().map(|l| serde_json::json!({
                        "label": l.label,
                        "conform_path": l.conform_path.display().to_string(),
                        "start_frame": l.start_frame,
                        "src_in_frame": l.src_in_frame,
                        "src_out_frame": l.src_out_frame,
                        "gain_constant": l.gain.is_constant(),
                        "gain_points": l.gain.values.len(),
                        "pan_constant": l.pan.is_constant(),
                        "pan_points": l.pan.values.len(),
                    })).collect::<Vec<_>>(),
                }),
                Err(e) => serde_json::json!({
                    "kind": "audio_mix_plan",
                    "error": e.to_string(),
                }),
            }
        }
        // project://current / composition /
        // media / tracks / markers / history / layers/{id} are served directly by
        // the TS MCP host (the sole state owner) and never reach this reader.
        other => {
            return Err(McpToolError::resource_not_found(
                format!(
                    "unknown or TS-served resource URI: {other} (project://* state views are served by the TS MCP host)",
                ),
                None,
            ));
        }
    };

    text_resource(uri, &body)
}

/// The latest preview master-bus meter reading. Gated on `jobs` (the audio
/// meter slot only exists when the jobs feature is on); reports `live: false`
/// when the feature is off so the resource never 404s.
#[cfg(feature = "jobs")]
fn meter_payload(b: &Backend) -> Value {
    let latest = b.audio_meter.0.lock().expect("meter lock poisoned").clone();
    match latest {
        Some((at, report)) if at.elapsed() < std::time::Duration::from_secs(2) => {
            serde_json::json!({
                "live": true,
                "rms_db": report.rms_db,
                "peak_db": report.peak_db,
            })
        }
        _ => serde_json::json!({ "live": false }),
    }
}

#[cfg(not(feature = "jobs"))]
fn meter_payload(_b: &Backend) -> Value {
    serde_json::json!({ "live": false })
}

// ============================================================
// media://* binary resources
// ============================================================

#[cfg(feature = "jobs")]
async fn read_media_resource(
    b: &Backend,
    uri: &str,
    tail: &str,
    media: Option<MediaItem>,
) -> Result<ResourceResult, McpToolError> {
    // tail = "{id}/thumbnail" | "{id}/frame/{t_us}" | "{id}/waveform"
    let (id_part, sub) = tail.split_once('/').ok_or_else(|| {
        McpToolError::resource_not_found(format!("media URI missing sub-path: {uri}"), None)
    })?;
    let media_id: MediaId = Uuid::parse_str(id_part).map_err(|_| {
        McpToolError::resource_not_found(format!("media URI has invalid UUID: {id_part}"), None)
    })?;
    // `None` → the id was absent from the project state.
    let media = media.ok_or_else(|| {
        McpToolError::resource_not_found(format!("media {media_id} not found"), None)
    })?;

    if sub == "thumbnail" {
        serve_thumbnail(b, uri, &media).await
    } else if sub == "waveform" {
        serve_waveform(b, uri, &media).await
    } else if let Some(t_str) = sub.strip_prefix("frame/") {
        let t_us: i64 = t_str.parse().map_err(|_| {
            McpToolError::invalid_params(format!("frame URI t_us not an integer: {t_str}"), None)
        })?;
        serve_frame(b, uri, &media, t_us).await
    } else {
        Err(McpToolError::resource_not_found(
            format!("unknown media sub-resource '{sub}'"),
            None,
        ))
    }
}

#[cfg(not(feature = "jobs"))]
async fn read_media_resource(
    _b: &Backend,
    uri: &str,
    _tail: &str,
    _media: Option<crate::state::MediaItem>,
) -> Result<ResourceResult, McpToolError> {
    Err(McpToolError::resource_not_found(
        format!("media resources require the jobs feature: {uri}"),
        None,
    ))
}

/// Serve `media://{id}/description` — the cached scene-description view for the
/// resolver's DEFAULT params (default backend, fps 1.0, general focus). Resolves
/// the backend from the injected VLM config, computes the same cache key
/// `describe_clip` uses, and returns the stored `DescriptionCache`
/// (`{ covered_ranges, segments }`, source-absolute). Reports a clear not-found
/// when no backend is configured or nothing has been described yet — unlike the
/// always-computable analysis resources.
#[cfg(feature = "speech")]
async fn read_description_resource(
    b: &Backend,
    uri: &str,
    id_part: &str,
    media: Option<crate::state::MediaItem>,
    vlm_config: &std::collections::HashMap<String, crate::vlm::BackendConfig>,
) -> Result<ResourceResult, McpToolError> {
    use crate::vlm;

    let media_id = Uuid::parse_str(id_part).map_err(|_| {
        McpToolError::resource_not_found(format!("media URI has invalid UUID: {id_part}"), None)
    })?;
    let media = media.ok_or_else(|| {
        McpToolError::resource_not_found(format!("media {media_id} not found"), None)
    })?;

    // Same preference-then-availability walk as describe_clip, no preference.
    let backend = vlm::resolve::select_backend(None, vlm_config).ok_or_else(|| {
        McpToolError::resource_not_found(
            format!(
                "no video-understanding backend configured — configure one, then call describe_clip for media {media_id}",
            ),
            None,
        )
    })?;
    let model = vlm::resolve::model_label(backend, vlm_config.get(backend.as_str()));
    // Default view params mirror describe_clip's defaults (fps 1.0, general).
    let key = vlm::cache_key(&media.file_hash_blake3, backend, &model, 1000, vlm::Focus::General);
    let path = b.cache.description(&key);
    crate::cache::touch_if_stale(&path);
    if !crate::cache::cached_ok(&path) {
        return Err(McpToolError::resource_not_found(
            format!(
                "no description computed yet for media {media_id} ({}, default sampling) — call describe_clip",
                backend.as_str(),
            ),
            None,
        ));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| McpToolError::internal_error(format!("read {}: {e}", path.display()), None))?;
    let body: Value = serde_json::from_slice(&bytes)
        .map_err(|e| McpToolError::internal_error(format!("parse description cache: {e}"), None))?;
    text_resource(uri, &body)
}

/// Serve `media://{id}/analysis` — the deterministic shot-layer view for the
/// tool's DEFAULT detection params (sensitivity 0.4, min_shot_us 500000, all
/// passes). Unlike `media://{id}/description`, the shot layer is ALWAYS
/// computable, so a cache miss COMPUTES on demand (a whole-source scan) and
/// writes it through, then returns — it never reports "not computed yet"
/// (mirrors `serve_frame`'s on-demand `jobs::extract_frame`). Idempotent pure
/// view: the same source + default params key the same VSHOT sidecar, so
/// repeated reads return byte-identical JSON; `analyze_clip` is the parameterized
/// recompute path that shares this cache. Returns the WHOLE-source `ShotReport`
/// (source-absolute times) — a media resource has no layer window to clip to.
#[cfg(feature = "jobs")]
async fn read_analysis_resource(
    b: &Backend,
    uri: &str,
    id_part: &str,
    media: Option<MediaItem>,
) -> Result<ResourceResult, McpToolError> {
    let media_id = Uuid::parse_str(id_part).map_err(|_| {
        McpToolError::resource_not_found(format!("media URI has invalid UUID: {id_part}"), None)
    })?;
    let media = media.ok_or_else(|| {
        McpToolError::resource_not_found(format!("media {media_id} not found"), None)
    })?;
    if !matches!(media.kind, crate::state::MediaKind::Video) {
        return Err(McpToolError::invalid_request(
            format!("media {media_id} is not a video — media://{{id}}/analysis needs a video source"),
            None,
        ));
    }
    // Default params mirror analyze_clip's defaults; source-keyed, so a layer's
    // analyze_clip with default args shares this exact cache entry.
    let opts = jobs::shot::ShotOpts {
        sensitivity: 0.4,
        min_shot_us: 500_000,
        stats: true,
        events: true,
    };
    let report = jobs::shot::cached_source_report(&b.cache, &media, &opts)
        .await
        .map_err(|e| McpToolError::internal_error(format!("shot analysis: {e:#}"), None))?;
    let body = serde_json::to_value(&report).map_err(serialize_err)?;
    text_resource(uri, &body)
}

#[cfg(feature = "jobs")]
async fn serve_thumbnail(
    b: &Backend,
    uri: &str,
    media: &MediaItem,
) -> Result<ResourceResult, McpToolError> {
    // Pick the middle thumbnail (index 5) — agents asking for "show me
    // this clip" generally want a representative still, not the first
    // frame which is often a slate / black.
    const MID: usize = 5;
    let path = b.cache.thumbnail(&media.file_hash_blake3, MID);
    crate::cache::touch_if_stale(&path);
    if !cached_ok(&path) {
        return Err(McpToolError::resource_not_found(
            format!(
                "thumbnail not generated yet for media {} — wait for a media:job_complete event with kind=thumbnails, or read media://{}/frame/<t_us> for an on-demand extraction",
                media.id, media.id,
            ),
            None,
        ));
    }
    blob_response(uri, &path, IMAGE_JPEG).await
}

#[cfg(feature = "jobs")]
async fn serve_frame(
    b: &Backend,
    uri: &str,
    media: &MediaItem,
    t_us: i64,
) -> Result<ResourceResult, McpToolError> {
    let path = jobs::extract_frame(&b.cache, media, t_us)
        .await
        .map_err(|e| McpToolError::internal_error(format!("frame extract: {e:#}"), None))?;
    blob_response(uri, &path, IMAGE_JPEG).await
}

#[cfg(feature = "jobs")]
async fn serve_waveform(
    b: &Backend,
    uri: &str,
    media: &MediaItem,
) -> Result<ResourceResult, McpToolError> {
    let path = b.cache.waveform(&media.file_hash_blake3);
    crate::cache::touch_if_stale(&path);
    if !cached_ok(&path) {
        return Err(McpToolError::resource_not_found(
            format!(
                "waveform not generated yet for media {} — wait for a media:job_complete event with kind=waveform",
                media.id,
            ),
            None,
        ));
    }
    blob_response(uri, &path, APP_OCTET).await
}

#[cfg(feature = "jobs")]
async fn blob_response(
    uri: &str,
    path: &std::path::Path,
    mime: &str,
) -> Result<ResourceResult, McpToolError> {
    use base64::Engine;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| McpToolError::internal_error(format!("read {}: {e}", path.display()), None))?;
    let blob = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(ResourceResult {
        contents: vec![ResourceContent::Blob {
            uri: uri.to_string(),
            mime_type: Some(mime.to_string()),
            blob,
        }],
    })
}

// ============================================================
// Static resource catalog
// ============================================================

struct ResourceDescriptor {
    uri: &'static str,
    name: &'static str,
    description: &'static str,
}

const STATIC_RESOURCES: &[ResourceDescriptor] = &[
    ResourceDescriptor {
        uri: URI_PROJECT,
        name: "Current project",
        description: "The full open WeftCut project as JSON. Re-fetch after change events.",
    },
    ResourceDescriptor {
        uri: URI_COMPOSITION,
        name: "Composition",
        description: "Canvas size, fps, sample rate, color space, background.",
    },
    ResourceDescriptor {
        uri: URI_MEDIA,
        name: "Media pool",
        description: "All imported media items keyed by id.",
    },
    ResourceDescriptor {
        uri: URI_TRACKS,
        name: "Tracks",
        description: "Tracks with layer envelopes. Read project://layers/{id} for full layer detail.",
    },
    ResourceDescriptor {
        uri: URI_MARKERS,
        name: "Markers",
        description: "Timeline markers, sorted by t_us.",
    },
    ResourceDescriptor {
        uri: URI_HISTORY,
        name: "History",
        description: "Recent operations and named checkpoints (no snapshots). `ops` is a window: `window_start` is the absolute stack index of `ops[0]`, and `cursor` is absolute too — never an offset into `ops`; absolute indices are the only ones `jump_to` accepts. `evicted` > 0 means the oldest entries were dropped for good.",
    },
    ResourceDescriptor {
        uri: URI_COMPILED,
        name: "Audio mix plan",
        description: "Compiled export-audio mix plan (layer placement on the 48 kHz frame grid + envelope summaries) — for agents that want structural reasoning about what export will mix.",
    },
    ResourceDescriptor {
        uri: URI_METER,
        name: "Audio meter",
        description: "Latest preview master-bus level reading (rms/peak dBFS). `live: false` when nothing has played in the last 2 seconds.",
    },
];

/// The advertised resource catalog (`resources/list`).
pub(super) fn static_resources() -> Vec<ResourceDef> {
    let out: Vec<ResourceDef> = STATIC_RESOURCES
        .iter()
        .map(|d| ResourceDef {
            uri: d.uri.to_string(),
            name: d.name.to_string(),
            description: d.description.to_string(),
            mime_type: APP_JSON.to_string(),
        })
        .collect();
    out
}

#[cfg(test)]
mod stateless_tests {
    use super::*;
    use crate::napi_backend::Backend;

    /// The advertised `project://history` description must teach the window
    /// semantics (`window_start`, `evicted`, absolute `jump_to` indices):
    /// several MCP clients surface only `resources/list` to the model, so a
    /// semantic that lives nowhere else is a semantic agents never see.
    #[test]
    fn history_description_carries_window_semantics() {
        let defs = static_resources();
        let d = defs.iter().find(|r| r.uri == URI_HISTORY).unwrap();
        for needle in ["window_start", "evicted", "jump_to"] {
            assert!(
                d.description.contains(needle),
                "project://history description lost `{needle}`"
            );
        }
    }

    /// project://compiled computes the audio mix plan from the INJECTED
    /// project, not a mirror. A blank project has no audio layers, so the plan
    /// is an empty layer list — proving the arm read `state.project`.
    #[cfg(feature = "export")]
    #[tokio::test]
    async fn compiled_uses_injected_project() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        let p = crate::state::Project::new_blank("compiled-test");
        let state = serde_json::json!({ "project": p }).to_string();
        let r = read_resource(&b, URI_COMPILED, &state).await.unwrap();
        let text = match &r.contents[0] {
            ResourceContent::Text { text, .. } => text.clone(),
            _ => panic!("expected text"),
        };
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(body["kind"], "audio_mix_plan");
        assert_eq!(
            body["layers"].as_array().unwrap().len(),
            0,
            "blank project has no audio layers"
        );
    }

    /// composition://meter reads live Rust state and needs no injected slice — an
    /// empty state JSON resolves to `live: false` (nothing has played).
    #[tokio::test]
    async fn meter_needs_no_state() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        let r = read_resource(&b, URI_METER, "{}").await.unwrap();
        let text = match &r.contents[0] {
            ResourceContent::Text { text, .. } => text.clone(),
            _ => panic!("expected text"),
        };
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(body["live"], false);
    }

    /// project://* state views are TS-served; the Rust reader returns a clear
    /// not-found.
    #[tokio::test]
    async fn project_views_are_not_served_by_rust() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        let err = read_resource(&b, "project://current", "{}")
            .await
            .unwrap_err();
        assert!(
            err.message.contains("TS-served") || err.message.contains("unknown"),
            "project://current must report it is TS-served; got: {}",
            err.message
        );
    }

    /// media://* resolves from the INJECTED MediaItem. With a fabricated
    /// item whose thumbnail cache is empty, the reader reports "not generated yet"
    /// — proving it read `state.media` (it never touched the mirror).
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn media_resource_uses_injected_item() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let id = uuid::Uuid::now_v7();
        let item = serde_json::json!({
            "id": id, "label": null, "path_abs": "/nonexistent", "path_rel": null,
            "kind": "Video", "metadata": crate::state::MediaMetadata::default(),
            "decode_route": { "route": "bypass" }, "waveform_path": null,
            "conform_path": null, "thumbnails_dir": null,
            "file_hash_blake3": format!("test-{id}"), "file_size": 0, "file_mtime": 0,
            "imported_at": chrono::Utc::now(),
        });
        let state = serde_json::json!({ "media": item }).to_string();
        let uri = format!("media://{id}/thumbnail");
        let err = read_resource(&b, &uri, &state).await.unwrap_err();
        assert!(
            err.message.contains("not generated yet"),
            "media:// must read the injected item (cache empty → not generated yet); got: {}",
            err.message
        );
    }

    /// serve_thumbnail must touch the poster's mtime before reading it — the
    /// disk-LRU sweep keys a thumbnail dir's survival on its MAX contained
    /// mtime (`cache::disk_lru`), so an agent read that skips this call would
    /// look like "unused" and get evicted out from under a live MCP client.
    #[cfg(feature = "jobs")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn thumbnail_read_touches_stale_mtime() {
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let id = uuid::Uuid::now_v7();
        let hash = format!("touch-test-{id}");
        let path = b.cache.thumbnail(&hash, 5);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"jpeg-bytes").unwrap();
        let stale = std::time::SystemTime::now()
            - crate::cache::TOUCH_THROTTLE
            - std::time::Duration::from_secs(60);
        let f = std::fs::File::options().write(true).open(&path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(stale))
            .unwrap();

        let item = serde_json::json!({
            "id": id, "label": null, "path_abs": "/nonexistent", "path_rel": null,
            "kind": "Video", "metadata": crate::state::MediaMetadata::default(),
            "decode_route": { "route": "bypass" }, "waveform_path": null,
            "conform_path": null, "thumbnails_dir": null,
            "file_hash_blake3": hash, "file_size": 0, "file_mtime": 0,
            "imported_at": chrono::Utc::now(),
        });
        let state = serde_json::json!({ "media": item }).to_string();
        let uri = format!("media://{id}/thumbnail");
        read_resource(&b, &uri, &state).await.unwrap();

        let m = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert!(
            m > stale + std::time::Duration::from_secs(30),
            "thumbnail read must refresh a stale poster mtime"
        );
    }
}
