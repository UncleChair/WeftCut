//! Differential-harness oracle generator. Reads a command-sequence JSON on
//! argv[1], replays it through the real project actor with deterministic ids,
//! and prints the canonical Trace JSON to stdout. Build/run with
//! `--features replay`. NOT compiled into the production addon.
// pub: consumed by the replay_driver differential-harness bin

use std::collections::{BTreeMap, HashMap};
use weftcut_lib::state::effect::{Effect, EffectPatch};
use weftcut_lib::state::transition::TransitionKind;
use serde_json::{json, Value};
use weftcut_lib::state::{self, Actor, LayerParams, ColorParams, Rgba, ProjectHandle};
use weftcut_lib::state::{LayerEdge, CompositionPatch, LayerPatch};
use weftcut_lib::state::animated::Animated;
use weftcut_lib::state::ids::det;

#[tokio::main]
async fn main() {
    let path = std::env::args().nth(1).expect("usage: replay_driver <sequence.json>");
    let seq: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let name = seq["name"].as_str().unwrap_or("unnamed").to_string();
    let emit_summary = std::env::var("REPLAY_EMIT").as_deref() == Ok("summary");

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
        let step = if emit_summary {
            let status = h.history_status().await;
            json!({ "op": op, "ok": ok, "error": error, "summary": canonical_summary(&snap, &status) })
        } else {
            json!({ "op": op, "ok": ok, "error": error, "state": canonical_state(&snap) })
        };
        steps.push(step);
    }
    det::disable();
    println!("{}", serde_json::to_string_pretty(&json!({ "name": name, "steps": steps })).unwrap());
}

/// The renderer IPC read-view (commands::build_project_summary). No wall-clock
/// fields in the view, so no <TS> normalization is needed (unlike canonical_state).
fn canonical_summary(p: &state::Project, status: &state::HistoryStatus) -> Value {
    serde_json::to_value(weftcut_lib::build_project_summary(p, status)).unwrap()
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

/// Substitute a single @ref token inside an effect-param key (mirrors the TS resolveParamKey).
fn resolve_param_key(refs: &HashMap<String, String>, key: &str) -> String {
    if let Some(at) = key.find('@') {
        let tail = &key[at + 1..];
        let end = tail.find(|c: char| !(c.is_alphanumeric() || c == '_')).unwrap_or(tail.len());
        let name = &tail[..end];
        if let Some(v) = refs.get(name) {
            return format!("{}{}{}", &key[..at], v, &tail[end..]);
        }
    }
    key.to_string()
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
                "video" => LayerParams::VideoClip(state::layer::VideoClipParams {
                    media: resolve_id(refs, cmd["media"].as_str().unwrap()),
                    src_in_us: r(cmd, "src_in_us"), src_out_us: r(cmd, "src_out_us"),
                    transform: Default::default(), opacity: Animated::Static(1.0), crop: None,
                    flip_h: false, flip_v: false, blend_mode: Default::default(), speed: 1.0,
                    fade_in_us: 0, fade_out_us: 0,
                }),
                "audio" => LayerParams::Audio(state::layer::AudioParams {
                    media: resolve_id(refs, cmd["media"].as_str().unwrap()),
                    src_in_us: r(cmd, "src_in_us"), src_out_us: r(cmd, "src_out_us"),
                    gain_db: Animated::Static(0.0), pan: Animated::Static(0.0),
                    fade_in_us: 0, fade_out_us: 0, mute: false,
                    role: state::audio_role::AudioRole::Music,
                }),
                "image" => LayerParams::ImageOverlay(state::layer::ImageOverlayParams {
                    media: resolve_id(refs, cmd["media"].as_str().unwrap()),
                    transform: Default::default(), opacity: Animated::Static(1.0),
                    blend_mode: Default::default(), fade_in_us: 0, fade_out_us: 0,
                }),
                "Motif" => {
                    let props: imbl::HashMap<String, Value> = cmd["props"].as_object()
                        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                        .unwrap_or_default();
                    LayerParams::Motif(state::layer::MotifParams {
                        motif_id: cmd["motif_id"].as_str().unwrap().to_string(),
                        motif_version: cmd["motif_version"].as_u64().unwrap() as u32,
                        props,
                        src_in_us: 0,
                        transform: Default::default(),
                        opacity: Animated::Static(1.0),
                    })
                }
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
            let rat = |v: &Value| -> Option<weftcut_lib::state::time::Rational> {
                v.as_object().map(|o| weftcut_lib::state::time::Rational {
                    num: o["num"].as_i64().unwrap() as u32, den: o["den"].as_i64().unwrap() as u32,
                })
            };
            let patch = CompositionPatch {
                duration_us: cmd["duration_us"].as_i64(),
                fps: cmd.get("fps").filter(|v| !v.is_null()).and_then(|v| rat(v)),
                width: cmd["width"].as_u64().map(|n| n as u32),
                height: cmd["height"].as_u64().map(|n| n as u32),
                sample_rate: cmd["sample_rate"].as_u64().map(|n| n as u32),
                channels: cmd["channels"].as_u64().map(|n| n as u8),
                color_space: cmd.get("color_space").filter(|v| !v.is_null())
                    .map(|v| serde_json::from_value(v.clone()).unwrap()),
                background: cmd.get("background").filter(|v| !v.is_null())
                    .map(|v| serde_json::from_value(v.clone()).unwrap()),
            };
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
            let patch = weftcut_lib::state::MarkerPatch {
                t_us: cmd["t_us"].as_i64(),
                end_t_us: cmd["end_t_us"].as_i64(),
                label: cmd["label"].as_str().map(str::to_string),
                color: None,
            };
            h.update_marker(u, resolve_id(refs, cmd["marker"].as_str().unwrap()), patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "remove_marker" => h.remove_marker(u, resolve_id(refs, cmd["marker"].as_str().unwrap())).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "delete_track" => h.delete_track(u, resolve_id(refs, cmd["track"].as_str().unwrap()), cmd["force"].as_bool().unwrap_or(false)).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "move_track" => h.move_track(u, resolve_id(refs, cmd["track"].as_str().unwrap()), cmd["new_position"].as_u64().unwrap() as usize).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "update_track_flags" => {
            let patch = weftcut_lib::state::TrackFlagsPatch {
                enabled: cmd["enabled"].as_bool(),
                muted: cmd["muted"].as_bool(),
                solo: cmd["solo"].as_bool(),
                locked: cmd["locked"].as_bool(),
            };
            h.update_track_flags(u, resolve_id(refs, cmd["track"].as_str().unwrap()), patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "add_effect" => {
            // commands/mutations.rs:460-474: mint the effect id UNCONDITIONALLY,
            // before the handle — a LayerNotFound still burns it.
            let effect = Effect {
                id: weftcut_lib::state::ids::new_id(),
                kind: cmd["kind"].as_str().unwrap().to_string(),
                enabled: true,
                params: BTreeMap::new(),
            };
            h.add_effect(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), effect).await
                .map(|eid| Some(eid.to_string())).map_err(|e| format!("{e:?}"))
        }
        "update_effect" => {
            let params = cmd.get("params").filter(|v| !v.is_null())
                .map(|v| serde_json::from_value::<BTreeMap<String, Animated<f64>>>(v.clone()).unwrap());
            let patch = EffectPatch { enabled: cmd["enabled"].as_bool(), params };
            h.update_effect(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), resolve_id(refs, cmd["effect"].as_str().unwrap()), patch).await
                .map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "move_effect" => h.move_effect(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), resolve_id(refs, cmd["effect"].as_str().unwrap()), cmd["new_index"].as_u64().unwrap() as usize).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "remove_effect" => h.remove_effect(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), resolve_id(refs, cmd["effect"].as_str().unwrap())).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "add_transition" => h.add_transition(u, resolve_id(refs, cmd["from"].as_str().unwrap()), resolve_id(refs, cmd["to"].as_str().unwrap()), r(cmd, "duration_us"), TransitionKind::Crossfade).await
            .map(|tid| Some(tid.to_string())).map_err(|e| format!("{e:?}")),
        "remove_transition" => h.remove_transition(u, resolve_id(refs, cmd["transition"].as_str().unwrap())).await.map(|_| None).map_err(|e| format!("{e:?}")),
        "add_media" => h.add_media_item(u, media_item(cmd)).await
            .map(|mid| Some(mid.to_string())).map_err(|e| format!("{e:?}")),
        "separate_audio" => h.separate_audio_to_new_track(u, resolve_id(refs, cmd["layer"].as_str().unwrap())).await
            .map(|tid| Some(tid.to_string())).map_err(|e| format!("{e:?}")),
        "set_media_derivatives" => {
            let p = &cmd["patch"];
            let patch = weftcut_lib::state::MediaDerivativesPatch {
                proxy_path: opt_opt_path(p, "proxy_path"),
                proxy_format_version: p.get("proxy_format_version").and_then(|v| v.as_u64()).map(|n| n as u32),
                quick_proxy_path: opt_opt_path(p, "quick_proxy_path"),
                proxy_bypassed: p.get("proxy_bypassed").and_then(|v| v.as_bool()),
                export_uses_original: p.get("export_uses_original").and_then(|v| v.as_bool()),
                waveform_path: opt_path(p, "waveform_path"),
                conform_path: opt_path(p, "conform_path"),
                thumbnails_dir: opt_path(p, "thumbnails_dir"),
            };
            h.set_media_derivatives(u, resolve_id(refs, cmd["media"].as_str().unwrap()), patch).await
                .map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "set_media_workspace_paths" => {
            let p = &cmd["paths"];
            h.set_media_workspace_paths(
                u,
                resolve_id(refs, cmd["media"].as_str().unwrap()),
                std::path::PathBuf::from(p["path_abs"].as_str().unwrap()),
                std::path::PathBuf::from(p["path_rel"].as_str().unwrap()),
                p["file_hash_blake3"].as_str().unwrap().to_string(),
                p["file_size"].as_u64().unwrap(),
                p["file_mtime"].as_u64().unwrap(),
            ).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "remove_media" => h.remove_media(u, resolve_id(refs, cmd["media"].as_str().unwrap()), cmd["force"].as_bool().unwrap_or(false)).await
            .map(|_| None).map_err(|e| format!("{e:?}")),
        "update_layer_params" => {
            let patch: weftcut_lib::state::LayerParamsPatch =
                serde_json::from_value(cmd["patch"].clone()).map_err(|e| e.to_string())?;
            h.update_layer_params(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), patch).await
                .map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "update_layer_param_track" => {
            let track: Animated<f64> = serde_json::from_value(cmd["track"].clone()).map_err(|e| e.to_string())?;
            let key = resolve_param_key(refs, cmd["param_key"].as_str().unwrap());
            h.update_layer_param_track(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), key, track).await
                .map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "update_layer_param_tracks" => {
            let entries: Vec<(String, Animated<f64>)> = serde_json::from_value(cmd["entries"].clone()).map_err(|e| e.to_string())?;
            h.update_layer_param_tracks(u, resolve_id(refs, cmd["layer"].as_str().unwrap()), entries).await
                .map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "set_role_gain" => {
            let role: state::AudioRole = serde_json::from_value(cmd["role"].clone()).map_err(|e| e.to_string())?;
            h.set_role_gain(u, role, cmd["gain_db"].as_f64().unwrap()).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "update_role_flags" => {
            let role: state::AudioRole = serde_json::from_value(cmd["role"].clone()).map_err(|e| e.to_string())?;
            let patch = state::RoleFlagsPatch { muted: cmd["muted"].as_bool(), solo: cmd["solo"].as_bool() };
            h.update_role_flags(u, role, patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "update_project_settings" => {
            let patch = state::ProjectSettingsPatch { auto_delete_empty_tracks: cmd["auto_delete_empty_tracks"].as_bool() };
            h.update_project_settings(u, patch).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "add_caption_track" => {
            let cues: Vec<_> = cmd["cues"].as_array().unwrap().iter().map(parse_cue).collect();
            let comp_w = cmd["comp_w"].as_u64().unwrap() as u32;
            let comp_h = cmd["comp_h"].as_u64().unwrap() as u32;
            h.add_caption_track(u, cues, comp_w, comp_h, cmd["label"].as_str().map(str::to_string)).await
                .map(|tid| Some(tid.to_string())).map_err(|e| format!("{e:?}"))
        }
        "restyle_caption_track" => {
            let patch: weftcut_lib::state::CaptionStylePatch =
                serde_json::from_value(cmd["patch"].clone()).map_err(|e| e.to_string())?;
            h.restyle_caption_track(u, resolve_id(refs, cmd["track"].as_str().unwrap()), patch).await
                .map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "rebind_motif" => {
            let updates: Vec<weftcut_lib::state::MotifRebindEntry> = cmd["updates"]
                .as_array().unwrap().iter().map(|u| {
                    let props: imbl::HashMap<String, Value> = u["props"].as_object()
                        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                        .unwrap_or_default();
                    weftcut_lib::state::MotifRebindEntry {
                        layer_id: resolve_id(refs, u["layer_id"].as_str().unwrap()),
                        motif_id: u["motif_id"].as_str().unwrap().to_string(),
                        motif_version: u["motif_version"].as_u64().unwrap() as u32,
                        props,
                    }
                }).collect();
            h.rebind_motif(u, updates).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
        "replace_state" => {
            // Build a blank from the args (mirrors Project::new_blank +
            // project_new_workspace's canvas override). new_blank mints ids
            // #(A,B,project); the subsequent replace_state mints reset's op_id +
            // broadcast_unrecorded's event id → 5 ids total (see the plan).
            let mut project = state::Project::new_blank(cmd["name"].as_str().unwrap_or("untitled"));
            if let Some(w) = cmd["width"].as_u64() { project.composition.width = w as u32; }
            if let Some(hh) = cmd["height"].as_u64() { project.composition.height = hh as u32; }
            if let (Some(n), Some(d)) = (cmd["fps_num"].as_u64(), cmd["fps_den"].as_u64()) {
                // fps inputs MUST be pre-reduced (den=1 in the corpus) so this
                // matches the TS `{num,den}` literal regardless of any reduction.
                project.composition.fps = weftcut_lib::state::time::Rational { num: n as u32, den: d as u32 };
            }
            h.replace_state(u, project).await.map(|_| None).map_err(|e| format!("{e:?}"))
        }
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

/// `Option<Option<PathBuf>>` from a patch object: key absent → None (leave);
/// JSON null → Some(None) (clear); string → Some(Some(path)). Mirrors the TS
/// `'key' in patch` tri-state for set_media_derivatives' proxy fields.
fn opt_opt_path(p: &Value, key: &str) -> Option<Option<std::path::PathBuf>> {
    match p.get(key) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => Some(Some(std::path::PathBuf::from(v.as_str().unwrap()))),
    }
}
/// Plain `Option<PathBuf>`: present-and-string → Some; absent or null → None.
fn opt_path(p: &Value, key: &str) -> Option<std::path::PathBuf> {
    p.get(key).and_then(|v| v.as_str()).map(std::path::PathBuf::from)
}

/// Rgba from a {r,g,b,a} JSON object (u8 components; matches TS Rgba interface).
fn rgba_obj(v: &Value) -> Rgba {
    Rgba {
        r: v["r"].as_u64().unwrap() as u8,
        g: v["g"].as_u64().unwrap() as u8,
        b: v["b"].as_u64().unwrap() as u8,
        a: v["a"].as_u64().unwrap() as u8,
    }
}

/// Build a subtitles::Cue from the corpus cue JSON ({start_us,end_us,text,style?}).
/// style fields mirror CueStyle; colors are {r,g,b,a} objects (matching TS Rgba);
/// pos is [x,y].
fn parse_cue(v: &Value) -> weftcut_lib::subtitles::Cue {
    use weftcut_lib::subtitles::{Cue, CueStyle};
    let style = match v.get("style") {
        Some(s) if !s.is_null() => CueStyle {
            font_family: s.get("font_family").and_then(|v| v.as_str()).map(str::to_string),
            size_px: s.get("size_px").and_then(|v| v.as_f64()).map(|n| n as f32),
            primary: s.get("primary").map(rgba_obj),
            bold: s.get("bold").and_then(|v| v.as_bool()).unwrap_or(false),
            italic: s.get("italic").and_then(|v| v.as_bool()).unwrap_or(false),
            outline_px: s.get("outline_px").and_then(|v| v.as_f64()).map(|n| n as f32),
            outline_color: s.get("outline_color").map(rgba_obj),
            shadow_px: s.get("shadow_px").and_then(|v| v.as_f64()).map(|n| n as f32),
            align: s.get("align").and_then(|v| v.as_u64()).map(|n| n as u8),
            pos: s.get("pos").map(|p| { let a = p.as_array().unwrap(); (a[0].as_f64().unwrap(), a[1].as_f64().unwrap()) }),
        },
        _ => CueStyle::default(),
    };
    Cue { start_us: v["start_us"].as_i64().unwrap(), end_us: v["end_us"].as_i64().unwrap(),
          text: v["text"].as_str().unwrap().to_string(), style }
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
        metadata: MediaMetadata { duration_us: cmd["duration_us"].as_i64(), video: None, audio: None, container_format: None },
        proxy_path: None, proxy_format_version: 0, quick_proxy_path: None,
        proxy_bypassed: false, export_uses_original: false, waveform_path: None,
        conform_path: None, thumbnails_dir: None,
        file_hash_blake3: "0".into(), file_size: 0, file_mtime: 0,
        imported_at: "2026-01-01T00:00:00Z".parse::<chrono::DateTime<chrono::Utc>>().unwrap(),
    }
}
