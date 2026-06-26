//! Production-command differential oracle. Drives the REAL Backend::dispatch
//! (production channel parsing) with deterministic ids. Build/run with
//! `--features replay,jobs,export,mcp,cloud,motifs`. NOT in the production addon.
use std::collections::HashMap;
use serde_json::{json, Value};
use weftcut_lib::NullEventSink;
use weftcut_lib::Backend;
use weftcut_lib::state;

#[tokio::main]
async fn main() {
    let path = std::env::args().nth(1).expect("usage: prod_driver <sequence.json>");
    let seq: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let name = seq["name"].as_str().unwrap_or("unnamed").to_string();

    state::ids::det::reset();
    state::ids::det::enable();
    let tmp = std::env::temp_dir().join(format!("weftcut-prod-{}", std::process::id()));
    let backend = Backend::new_for_replay(
        std::sync::Arc::new(NullEventSink),
        tmp.join("config").to_string_lossy().to_string(),
        tmp.join("cache").to_string_lossy().to_string(),
    );
    let h = backend.init_for_replay().await; // mints A(#1) B(#2) project(#3)
    let a_roll = h.snapshot().await.tracks[0].id.to_string();
    let b_roll = h.snapshot().await.tracks[1].id.to_string();

    let mut refs: HashMap<String, String> = HashMap::new();
    refs.insert("A".into(), a_roll);
    refs.insert("B".into(), b_roll);

    let mut steps = Vec::new();
    for cmd in seq["commands"].as_array().unwrap() {
        let op = cmd["op"].as_str().unwrap().to_string();
        let (ok, error, ret) = if op == "add_media" {
            // Pool seed (renderer never does this; import does). Apply via handle.
            match h.add_media_item(state::Actor::User, media_item(cmd)).await {
                Ok(id) => (true, None, Some(id.to_string())),
                Err(e) => (false, Some(format!("{e:?}")), None),
            }
        } else {
            let args = build_wire_args(cmd, &refs);
            match backend.dispatch(&op, &serde_json::to_string(&args).unwrap()).await {
                Ok(ret_json) => (true, None, extract_ref_id(&op, &ret_json)),
                Err(e) => (false, Some(e), None),
            }
        };
        if let (true, Some(id)) = (ok, &ret) {
            if let Some(rf) = cmd["ref"].as_str() { refs.insert(rf.to_string(), id.clone()); }
        }
        let snap = h.snapshot().await;
        steps.push(json!({ "op": op, "ok": ok, "error": error, "state": canonical_state(&*snap) }));
    }
    state::ids::det::disable();
    println!("{}", serde_json::to_string_pretty(&json!({ "name": name, "steps": steps })).unwrap());
}

/// Build the wire-args object for dispatch: copy every key of cmd except op/ref,
/// resolving @ref-token string values to their resolved UUID strings.
fn build_wire_args(cmd: &Value, refs: &HashMap<String, String>) -> Value {
    let mut obj = serde_json::Map::new();
    if let Some(map) = cmd.as_object() {
        for (k, v) in map {
            if k == "op" || k == "ref" { continue; }
            let resolved = resolve_value(v, refs);
            obj.insert(k.clone(), resolved);
        }
    }
    Value::Object(obj)
}

/// Recursively resolve @ref tokens in a value: string @X → resolved UUID string.
fn resolve_value(v: &Value, refs: &HashMap<String, String>) -> Value {
    match v {
        Value::String(s) => {
            if let Some(key) = s.strip_prefix('@') {
                if let Some(id) = refs.get(key) {
                    return Value::String(id.clone());
                }
            }
            v.clone()
        }
        Value::Array(arr) => Value::Array(arr.iter().map(|x| resolve_value(x, refs)).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, val) in map {
                out.insert(k.clone(), resolve_value(val, refs));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// For id-returning commands, parse the returned JSON string UUID. The dispatch
/// result is a JSON string of the id (`"\"<uuid>\""`); double-parse to get the
/// raw UUID string. For split_layer_grouped the result is a tuple — capture
/// the left field. Others → None.
fn extract_ref_id(op: &str, ret_json: &str) -> Option<String> {
    match op {
        "add_track"
        | "add_color_layer"
        | "add_media_layer"
        | "add_text_layer"
        | "add_demo_color_layer"
        | "add_demo_text_layer"
        | "add_effect"
        | "groups_create"
        | "duplicate_layer"
        | "separate_audio_to_new_track"
        | "add_caption_track"
        | "add_marker"
        // The no-track_id case mints the Overlay track FIRST then the layer
        // (two commits); we capture the LAYER id, matching the TS two-commit order.
        | "add_motif" => {
            // The dispatch ser() call JSON-encodes the UUID string, so the result
            // is `"\"<uuid>\""` — parse the outer JSON string to get the raw UUID.
            serde_json::from_str::<String>(ret_json).ok()
        }
        "split_layer_grouped" => {
            // Returns a tuple [left_id, right_id]; capture left.
            let v: Value = serde_json::from_str(ret_json).ok()?;
            v.as_array()?.first()?.as_str().map(str::to_string)
        }
        _ => None,
    }
}

/// Serialize via serde_json::Value (BTreeMap => keys sorted; preserve_order is
/// off) then normalize the two wall-clock fields, matching the TS canonicalize.
fn canonical_state(p: &state::Project) -> Value {
    let mut v = serde_json::to_value(p).unwrap();
    if let Some(m) = v.get_mut("metadata").and_then(Value::as_object_mut) {
        m.insert("created_at".into(), json!("<TS>"));
        m.insert("modified_at".into(), json!("<TS>"));
    }
    v
}

/// Byte-identical twin of the TS mediaItemTemplate. Fixed defaults for every
/// field bar id/kind/duration_us; path uses forward slashes for stable PathBuf
/// serialization; imported_at is a fixed instant (the TS literal must match its
/// serialized form — see the regen step).
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
