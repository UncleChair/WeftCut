//! Differential-harness oracle generator. Reads a command-sequence JSON on
//! argv[1], replays it through the real project actor with deterministic ids,
//! and prints the canonical Trace JSON to stdout. Build/run with
//! `--features replay`. NOT compiled into the production addon.
// pub: consumed by the replay_driver differential-harness bin

use std::collections::HashMap;
use serde_json::{json, Value};
use weftcut_lib::state::{self, Actor, LayerParams, ColorParams, Rgba, ProjectHandle};
use weftcut_lib::state::actor::{LayerEdge, CompositionPatch, LayerPatch};
use weftcut_lib::state::animated::Animated;
use weftcut_lib::state::ids::det;

#[tokio::main]
async fn main() {
    let path = std::env::args().nth(1).expect("usage: replay_driver <sequence.json>");
    let seq: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let name = seq["name"].as_str().unwrap_or("unnamed").to_string();

    det::reset();
    det::enable();
    let initial = state::Project::new_blank("replay"); // consumes ids #1 (A) #2 (B) #3 (project)
    let a_roll = initial.tracks[0].id;
    let b_roll = initial.tracks[1].id;
    let h = state::spawn(initial);

    let mut refs: HashMap<String, String> = HashMap::new();
    refs.insert("A".into(), a_roll.to_string());
    refs.insert("B".into(), b_roll.to_string());

    let mut steps = Vec::new();
    for cmd in seq["commands"].as_array().unwrap() {
        let op = cmd["op"].as_str().unwrap().to_string();
        let outcome = apply(&h, cmd, &refs).await;
        let (ok, error) = match &outcome { Ok(_) => (true, None), Err(e) => (false, Some(e.clone())) };
        if let Ok(Some(id)) = &outcome {
            if let Some(rf) = cmd["ref"].as_str() { refs.insert(rf.to_string(), id.clone()); }
        }
        let snap = h.snapshot().await;
        steps.push(json!({ "op": op, "ok": ok, "error": error, "state": canonical_state(&snap) }));
    }
    det::disable();
    println!("{}", serde_json::to_string_pretty(&json!({ "name": name, "steps": steps })).unwrap());
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

fn resolve_id(refs: &HashMap<String, String>, token: &str) -> uuid::Uuid {
    let key = token.strip_prefix('@').unwrap_or(token);
    uuid::Uuid::parse_str(refs.get(key).unwrap_or(&key.to_string())).unwrap()
}

async fn apply(h: &ProjectHandle, cmd: &Value, refs: &HashMap<String, String>) -> Result<Option<String>, String> {
    let op = cmd["op"].as_str().unwrap();
    let u = Actor::User;
    let r = |c: &Value, k: &str| c[k].as_i64().unwrap();
    match op {
        "add_layer" => {
            let track = resolve_id(refs, cmd["track"].as_str().unwrap());
            let params = match cmd["kind"].as_str().unwrap() {
                "color" => LayerParams::Color(ColorParams {
                    color: Animated::Static(Rgba { r: 255, g: 0, b: 0, a: 255 }),
                    width: 1920, height: 1080,
                }),
                "text" => default_text_params(),
                other => return Err(format!("unknown kind {other}")),
            };
            h.add_layer(u, track, params, r(cmd, "t_start_us"), r(cmd, "t_end_us")).await
                .map(|lid| Some(lid.to_string())).map_err(|e| format!("{e:?}"))
        }
        "add_track" => h.add_track(u, cmd["label"].as_str().map(str::to_string)).await
            .map(|tid| Some(tid.to_string())).map_err(|e| format!("{e:?}")),
        "move_layer" => h.move_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), resolve_id(refs, cmd["to_track"].as_str().unwrap()), r(cmd, "t_start_us"), cmd["escape_group"].as_bool().unwrap_or(false)).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "trim_layer" => {
            let edge = if cmd["edge"].as_str() == Some("out") { LayerEdge::Out } else { LayerEdge::In };
            h.trim_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), edge, r(cmd, "new_t_us"), cmd["escape_group"].as_bool().unwrap_or(false)).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "delete_layer" => h.delete_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap())).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "duplicate_layer" => h.duplicate_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), r(cmd, "t_offset_us")).await
            .map(|nid| Some(nid.to_string())).map_err(|e| format!("{e:?}")),
        "split_layer" => h.split_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), r(cmd, "at_t_us"), cmd["escape_group"].as_bool().unwrap_or(false)).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "groups_create" => {
            let ids: Vec<_> = cmd["layers"].as_array().unwrap().iter().map(|t| resolve_id(refs, t.as_str().unwrap())).collect();
            h.groups_create(u, ids, cmd["label"].as_str().map(str::to_string), cmd["reassign"].as_bool().unwrap_or(false)).await
                .map(|gid| Some(gid.to_string())).map_err(|e| format!("{e:?}"))
        }
        "groups_dissolve" => h.groups_dissolve(u, resolve_id(refs, cmd["group"].as_str().unwrap())).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "groups_add_members" => {
            let ids: Vec<_> = cmd["layers"].as_array().unwrap().iter().map(|t| resolve_id(refs, t.as_str().unwrap())).collect();
            h.groups_add_members(u, resolve_id(refs, cmd["group"].as_str().unwrap()), ids, cmd["reassign"].as_bool().unwrap_or(false)).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "groups_remove_members" => {
            let ids: Vec<_> = cmd["layers"].as_array().unwrap().iter().map(|t| resolve_id(refs, t.as_str().unwrap())).collect();
            h.groups_remove_members(u, resolve_id(refs, cmd["group"].as_str().unwrap()), ids).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "groups_rename" => h.groups_rename(u, resolve_id(refs, cmd["group"].as_str().unwrap()), cmd["label"].as_str().map(str::to_string)).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "add_marker" => h.add_marker(u, r(cmd, "t_us"), cmd["end_t_us"].as_i64(), cmd["label"].as_str().unwrap_or("m"), Rgba { r: 0, g: 128, b: 255, a: 255 }).await
            .map(|mid| Some(mid.to_string())).map_err(|e| format!("{e:?}")),
        "set_composition" => {
            let patch = CompositionPatch { duration_us: cmd["duration_us"].as_i64(), ..Default::default() };
            h.set_composition(u, patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "update_layer" => {
            let patch = LayerPatch {
                label: cmd["label"].as_str().map(str::to_string),
                t_start_us: cmd["t_start_us"].as_i64(),
                t_end_us: cmd["t_end_us"].as_i64(),
                enabled: cmd["enabled"].as_bool(),
                locked: cmd["locked"].as_bool(),
            };
            h.update_layer(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "fit_composition_to_layers" => h.fit_composition_to_layers(u).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "undo" => h.undo(u).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "redo" => h.redo(u).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "update_marker" => {
            let patch = weftcut_lib::state::actor::MarkerPatch {
                t_us: cmd["t_us"].as_i64(),
                end_t_us: cmd["end_t_us"].as_i64(),
                label: cmd["label"].as_str().map(str::to_string),
                color: None,
            };
            h.update_marker(u, resolve_id(refs, cmd["marker"].as_str().unwrap()), patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "remove_marker" => h.remove_marker(u, resolve_id(refs, cmd["marker"].as_str().unwrap())).await.map(|_| None).map_err(|e| format!("{e:?}")),
        other => Err(format!("driver: unsupported op {other}")),
    }
}

fn default_text_params() -> LayerParams {
    use weftcut_lib::state::layer::{TextParams, FontSpec, TextAlign, TextBackend};
    use weftcut_lib::state::transform::Transform;
    LayerParams::Text(TextParams {
        content: "hello".into(),
        font: FontSpec { family: "Inter".into(), size_px: 48.0, weight: 400, italic: false },
        color: Animated::Static(Rgba { r: 255, g: 255, b: 255, a: 255 }),
        align: TextAlign::Center, transform: Transform::default(),
        opacity: Animated::Static(1.0), shadow: None, outline: None,
        intro: None, outro: None, backend_hint: TextBackend::Auto,
    })
}
