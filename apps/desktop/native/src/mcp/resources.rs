//! MCP resource readers, transport-free. `read_resource(b, uri)` dispatches the
//! `project://*` JSON resources and the binary `media://*` resources, returning
//! the wire `ResourceResult`.
//!
//! JSON resources serialize the project snapshot (pretty-printed) into a
//! `ResourceContent::Text`. Binary resources base64-encode the bytes into a
//! `ResourceContent::Blob`.

use serde_json::Value;
use uuid::Uuid;

use crate::napi_backend::Backend;
use crate::state::LayerId;

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
const PREFIX_LAYERS: &str = "project://layers/";
const PREFIX_MEDIA: &str = "media://";

#[cfg(feature = "motifs")]
const URI_MOTIFS: &str = "motifs://current";

const APP_JSON: &str = "application/json";
#[cfg(feature = "jobs")]
const APP_OCTET: &str = "application/octet-stream";
#[cfg(feature = "jobs")]
const IMAGE_JPEG: &str = "image/jpeg";

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
) -> Result<ResourceResult, McpToolError> {
    let snap = b.snapshot_for_read().await?;

    // media://* paths return binary content (image bytes, peaks file). We
    // peel them off here so the rest of `read_resource` can stay
    // text/JSON oriented.
    if let Some(tail) = uri.strip_prefix(PREFIX_MEDIA) {
        return read_media_resource(b, uri, tail, &snap).await;
    }

    let body: Value = match uri {
        URI_PROJECT => serde_json::to_value(&*snap).map_err(serialize_err)?,
        URI_COMPOSITION => serde_json::to_value(&snap.composition).map_err(serialize_err)?,
        URI_MEDIA => serde_json::to_value(&snap.media_pool).map_err(serialize_err)?,
        URI_TRACKS => serde_json::to_value(&snap.tracks).map_err(serialize_err)?,
        URI_MARKERS => serde_json::to_value(&snap.markers).map_err(serialize_err)?,
        // History lives in the TS state actor (the sole writer); its view is
        // mirrored here via `set_project_mirror`. A clear error if unset — the
        // TS host pushes the mirror at boot before any read can run.
        URI_HISTORY => b
            .mirror_history_view()
            .ok_or_else(|| McpToolError::internal_error(
                "history view not set (TS host must push the read-mirror first)".to_string(),
                None,
            ))?,
        URI_METER => meter_payload(b),
        URI_COMPILED => {
            // The audio mix plan IS the compiled view of the export
            // audio pipeline (the lavfi IR it replaced is gone; ADR
            // 0019). Envelope point COUNTS, not values — keyframed
            // gain on a long layer would be hundreds of thousands of
            // floats. A transient ConformMissing state reports inline
            // instead of failing the read.
            match crate::audio::mix::plan_for_project(&snap, None) {
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
        #[cfg(feature = "motifs")]
        URI_MOTIFS => {
            let payload: Vec<serde_json::Value> =
                crate::commands::motifs::list_motifs_inner(&b.motif_store)
                    .into_iter()
                    .map(|mut entry| {
                        if let Some(obj) = entry.as_object_mut() {
                            obj.remove("html");
                        }
                        entry
                    })
                    .collect();
            serde_json::to_value(&payload).map_err(serialize_err)?
        }
        other if other.starts_with(PREFIX_LAYERS) => {
            let tail = &other[PREFIX_LAYERS.len()..];
            let id_part = match tail.split_once('/') {
                Some((_, suffix)) => {
                    return Err(McpToolError::resource_not_found(
                        format!("unsupported layer sub-resource '{suffix}'"),
                        None,
                    ));
                }
                None => tail,
            };
            let layer_id: LayerId = Uuid::parse_str(id_part).map_err(|_| {
                McpToolError::resource_not_found(
                    format!("layer URI has invalid UUID: {id_part}"),
                    None,
                )
            })?;
            let layer = snap
                .tracks
                .iter()
                .flat_map(|t| t.layers.iter())
                .find(|l| l.id == layer_id)
                .ok_or_else(|| {
                    McpToolError::resource_not_found(
                        format!("layer {layer_id} not found"),
                        None,
                    )
                })?;
            serde_json::to_value(layer).map_err(serialize_err)?
        }
        other => {
            return Err(McpToolError::resource_not_found(
                format!("unknown resource URI: {other}"),
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
    snap: &crate::state::Project,
) -> Result<ResourceResult, McpToolError> {
    // tail = "{id}/thumbnail" | "{id}/frame/{t_us}" | "{id}/waveform"
    let (id_part, sub) = tail.split_once('/').ok_or_else(|| {
        McpToolError::resource_not_found(
            format!("media URI missing sub-path: {uri}"),
            None,
        )
    })?;
    let media_id: MediaId = Uuid::parse_str(id_part).map_err(|_| {
        McpToolError::resource_not_found(
            format!("media URI has invalid UUID: {id_part}"),
            None,
        )
    })?;
    let media = snap
        .media_pool
        .get(&media_id)
        .cloned()
        .ok_or_else(|| {
            McpToolError::resource_not_found(
                format!("media {media_id} not found"),
                None,
            )
        })?;

    if sub == "thumbnail" {
        serve_thumbnail(b, uri, &media).await
    } else if sub == "waveform" {
        serve_waveform(b, uri, &media).await
    } else if let Some(t_str) = sub.strip_prefix("frame/") {
        let t_us: i64 = t_str.parse().map_err(|_| {
            McpToolError::invalid_params(
                format!("frame URI t_us not an integer: {t_str}"),
                None,
            )
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
    _snap: &crate::state::Project,
) -> Result<ResourceResult, McpToolError> {
    Err(McpToolError::resource_not_found(
        format!("media resources require the jobs feature: {uri}"),
        None,
    ))
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
    let path = jobs::extract_frame(&b.cache, media, t_us).await.map_err(
        |e| McpToolError::internal_error(format!("frame extract: {e:#}"), None),
    )?;
    blob_response(uri, &path, IMAGE_JPEG).await
}

#[cfg(feature = "jobs")]
async fn serve_waveform(
    b: &Backend,
    uri: &str,
    media: &MediaItem,
) -> Result<ResourceResult, McpToolError> {
    let path = b.cache.waveform(&media.file_hash_blake3);
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
    let bytes = tokio::fs::read(path).await.map_err(|e| {
        McpToolError::internal_error(format!("read {}: {e}", path.display()), None)
    })?;
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
        description: "Recent operations and named checkpoints (no snapshots).",
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
    let mut out: Vec<ResourceDef> = STATIC_RESOURCES
        .iter()
        .map(|d| ResourceDef {
            uri: d.uri.to_string(),
            name: d.name.to_string(),
            description: d.description.to_string(),
            mime_type: APP_JSON.to_string(),
        })
        .collect();
    #[cfg(feature = "motifs")]
    out.push(ResourceDef {
        uri: URI_MOTIFS.to_string(),
        name: "Motif catalog".to_string(),
        description: "Built-in, installed, and draft Motifs (html stripped). Re-fetch after motifs:changed events.".to_string(),
        mime_type: APP_JSON.to_string(),
    });
    out
}

#[cfg(test)]
mod read_mirror_tests {
    use super::*;
    use crate::napi_backend::Backend;

    #[tokio::test]
    async fn read_resource_serves_the_mirror_when_set() {
        // new_for_test: see napi_backend.rs:457 for the exact constructor args.
        let b = Backend::new_for_test(std::sync::Arc::new(crate::events::VecEventSink::new()));
        let p = crate::state::Project::new_blank("mirror-test");
        let original_id = p.project_id.to_string();
        let project_json = serde_json::to_string(&p).unwrap();
        let history_json = r#"{"ops":[],"cursor":0,"len":1,"checkpoints":[]}"#.to_string();
        b.set_project_mirror(project_json, history_json).unwrap();

        let r = read_resource(&b, "project://current").await.unwrap();
        let text = match &r.contents[0] {
            ResourceContent::Text { text, .. } => text.clone(),
            _ => panic!("expected text"),
        };
        let body: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(body["project_id"].as_str().unwrap(), original_id, "served the mirrored project");
    }
}
