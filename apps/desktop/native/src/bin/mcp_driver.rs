//! MCP-channel differential oracle. Drives the REAL `dispatch_tool` (the napi
//! MCP entrypoint's inner call) with deterministic ids, capturing the exact
//! `reply()` envelope per step. Build/run with
//! `--features replay,jobs,export,mcp,cloud,motifs`. NOT in the production addon.
use std::collections::HashMap;
use serde_json::{json, Value};
use weftcut_lib::{dispatch_tool, reply, Backend, NullEventSink, state};

#[tokio::main]
async fn main() {
    let path = std::env::args().nth(1).expect("usage: mcp_driver <sequence.json>");
    let seq: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let name = seq["name"].as_str().unwrap_or("unnamed").to_string();

    state::ids::det::reset();
    state::ids::det::enable();
    let tmp = std::env::temp_dir().join(format!("weftcut-mcp-{}", std::process::id()));
    let backend = Backend::new_for_replay(
        std::sync::Arc::new(NullEventSink),
        tmp.join("config").to_string_lossy().to_string(),
        tmp.join("cache").to_string_lossy().to_string(),
    );
    let h = backend.init_for_replay().await; // mints A(#1) B(#2) project(#3)
    let mut refs: HashMap<String, String> = HashMap::new();
    refs.insert("A".into(), h.snapshot().await.tracks[0].id.to_string());
    refs.insert("B".into(), h.snapshot().await.tracks[1].id.to_string());

    let mut steps = Vec::new();
    for cmd in seq["commands"].as_array().unwrap() {
        let op = cmd["op"].as_str().unwrap().to_string();
        let (ok, mut env, ret) = if op == "add_media" {
            // Pool seed (MCP import_media is jobs/3d-d). Apply via handle.
            match h.add_media_item(state::Actor::User, media_item(cmd)).await {
                Ok(id) => (true, json!({ "ok": true, "result": { "content": [] } }), Some(id.to_string())),
                Err(e) => (false, json!({ "ok": false, "error": { "code": "internal", "message": format!("{e:?}") } }), None),
            }
        } else {
            let args = build_args(cmd, &refs);
            let env_str = reply(dispatch_tool(&backend, &op, &serde_json::to_string(&args).unwrap()).await);
            let env: Value = serde_json::from_str(&env_str).unwrap();
            let ok = env["ok"].as_bool().unwrap();
            let ret = if ok { extract_ref_id(&op, &env["result"], cmd) } else { None };
            (ok, env, ret)
        };
        if let (true, Some(id)) = (ok, &ret) {
            if let Some(rf) = cmd["ref"].as_str() { refs.insert(rf.to_string(), id.clone()); }
        }
        normalize_ts(&mut env);
        let snap = h.snapshot().await;
        steps.push(json!({ "op": op, "ok": ok, "env": env, "state": canonical_state(&*snap) }));
    }
    state::ids::det::disable();
    println!("{}", serde_json::to_string_pretty(&json!({ "name": name, "steps": steps })).unwrap());
}

/// Build the wire-args object: copy every key of cmd except op/ref, resolving
/// @ref-token string values to resolved UUID strings. (= prod_driver build_wire_args.)
fn build_args(cmd: &Value, refs: &HashMap<String, String>) -> Value {
    let mut obj = serde_json::Map::new();
    if let Some(map) = cmd.as_object() {
        for (k, v) in map {
            if k == "op" || k == "ref" || k == "kf_index" { continue; }
            obj.insert(k.clone(), resolve_value(v, refs));
        }
    }
    Value::Object(obj)
}

fn resolve_value(v: &Value, refs: &HashMap<String, String>) -> Value {
    match v {
        Value::String(s) => s.strip_prefix('@').and_then(|k| refs.get(k))
            .map(|id| Value::String(id.clone())).unwrap_or_else(|| v.clone()),
        Value::Array(arr) => Value::Array(arr.iter().map(|x| resolve_value(x, refs)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, val)| (k.clone(), resolve_value(val, refs))).collect()),
        other => other.clone(),
    }
}

/// Extract the @ref id from an MCP result envelope's `result` value, by tool.
/// id tools → result.content[0].text is the raw UUID. add_video_layer → the
/// inner JSON's "video_layer_id". get_param_track → keyframes[cmd.kf_index].id
/// (so a sequence can name a server-minted keyframe id). Others → None.
fn extract_ref_id(op: &str, result: &Value, cmd: &Value) -> Option<String> {
    let text = result.get("content")?.get(0)?.get("text")?.as_str()?;
    match op {
        "add_track" | "add_color_layer" | "duplicate_layer" | "groups_create"
        | "add_effect" | "add_marker" | "checkpoint"
        // add_motif returns the layer id as ToolResult::text(layer_id).
        | "add_motif" => Some(text.to_string()),
        "add_video_layer" => {
            serde_json::from_str::<Value>(text).ok()
                .and_then(|v| v.get("video_layer_id").and_then(Value::as_str).map(str::to_string))
                .or_else(|| Some(text.to_string()))
        }
        "begin_agent_session" => {
            serde_json::from_str::<Value>(text).ok()
                .and_then(|v| v.get("checkpoint_id").and_then(Value::as_str).map(str::to_string))
        }
        "get_param_track" => {
            let idx = cmd.get("kf_index")?.as_u64()? as usize;
            let v: Value = serde_json::from_str(text).ok()?;
            v.get("keyframes")?.get(idx)?.get("id")?.as_str().map(str::to_string)
        }
        _ => None,
    }
}

fn canonical_state(p: &state::Project) -> Value {
    let mut v = serde_json::to_value(p).unwrap();
    if let Some(m) = v.get_mut("metadata").and_then(Value::as_object_mut) {
        m.insert("created_at".into(), json!("<TS>"));
        m.insert("modified_at".into(), json!("<TS>"));
    }
    v
}

/// Normalize wall-clock fields (created_at/modified_at/started_at) to "<TS>" in
/// the captured reply envelope so the oracle is deterministic — matching the TS
/// gate's canonicalize() (canonical.ts TS_FIELDS) and canonical_state's metadata
/// normalization. Result content travels as JSON-encoded strings (text blocks),
/// so descend into a string IFF it parses as a JSON object/array, and re-serialize
/// ONLY when a timestamp was actually replaced inside (else a timestamp-free
/// 3d-b text-block would be re-serialized and break additivity). Returns true iff
/// anything was normalized.
fn normalize_ts(v: &mut Value) -> bool {
    let mut changed = false;
    match v {
        Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                if matches!(k.as_str(), "created_at" | "modified_at" | "started_at") && val.is_string() {
                    *val = json!("<TS>");
                    changed = true;
                } else if normalize_ts(val) {
                    changed = true;
                }
            }
        }
        Value::Array(arr) => {
            for x in arr.iter_mut() {
                if normalize_ts(x) { changed = true; }
            }
        }
        Value::String(s) => {
            if let Ok(mut inner) = serde_json::from_str::<Value>(s) {
                if (inner.is_object() || inner.is_array()) && normalize_ts(&mut inner) {
                    *s = serde_json::to_string(&inner).unwrap();
                    changed = true;
                }
            }
        }
        _ => {}
    }
    changed
}

/// Byte-identical twin of prod_driver::media_item (see that file).
fn media_item(cmd: &Value) -> state::media::MediaItem {
    use state::media::{MediaItem, MediaKind, MediaMetadata};
    let kind = match cmd["kind"].as_str().unwrap() {
        "Video" => MediaKind::Video, "Audio" => MediaKind::Audio, "Image" => MediaKind::Image,
        other => panic!("bad media kind {other}"),
    };
    MediaItem {
        id: uuid::Uuid::parse_str(cmd["id"].as_str().unwrap()).unwrap(),
        label: None, path_abs: "media/clip.bin".into(), path_rel: None, kind,
        metadata: MediaMetadata {
            duration_us: cmd["duration_us"].as_i64(),
            video: None,
            audio: if cmd["with_audio"].as_bool().unwrap_or(false) {
                Some(state::media::AudioStreamMeta { sample_rate: 0, channels: 0, codec: "".into() })
            } else { None },
            container_format: None,
        },
        proxy_path: None, proxy_format_version: 0, quick_proxy_path: None,
        proxy_bypassed: false, export_uses_original: false, waveform_path: None,
        conform_path: None, thumbnails_dir: None,
        file_hash_blake3: "0".into(), file_size: 0, file_mtime: 0,
        imported_at: "2026-01-01T00:00:00Z".parse::<chrono::DateTime<chrono::Utc>>().unwrap(),
    }
}
