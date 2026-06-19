//! MCP keyframe authoring: arg structs + testable free helpers. The `#[tool]`
//! wrapper methods live in `mcp/mod.rs` (the `#[tool(tool_box)]` macro requires
//! them inside the `WeftCutServer` impl); they parse args and call these.
//!
//! All times are TIMELINE-ABSOLUTE microseconds; helpers convert to layer-local
//! (`t - layer.t_start_us`) before the write. Each helper does snapshot → pure
//! transform (`state::keyframe_edits`) → `update_layer_param_track`, reusing the
//! actor's normalization / validation / lock check / history. Not atomic against
//! a concurrent UI edit — acceptable (every MCP edit tool is the same, and
//! agent-mode puts the human UI in record-only).

use super::wire::McpToolError as McpError;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

/// schemars 0.8 renders `serde_json::Value` as the boolean schema `true`, which
/// the MCP TS-SDK Zod validator rejects (it requires object schemas). Emit `{}`
/// (an unconstrained OBJECT schema) so `client.listTools()` accepts the catalog.
pub(crate) fn any_object_schema(_gen: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
    schemars::schema::Schema::Object(schemars::schema::SchemaObject::default())
}

use crate::state::animated::{Animated, Keyframe};
use crate::state::ids::KeyframeId;
use crate::state::keyframe_edits;
use crate::state::layer::resolve_animated_f64;
use crate::state::{Actor, CommandError, LayerId, ProjectHandle};

// ---- arg structs ----------------------------------------------------------
// `interp` / `track` are `serde_json::Value` because `Interpolation` and
// `Animated<f64>` don't derive `JsonSchema` (imbl::Vector has no impl); the
// wrapper deserializes them into typed values before calling the helpers.

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct GetParamTrackArgs {
    pub layer_id: String,
    pub param_key: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct SetKeyframeArgs {
    pub layer_id: String,
    pub param_key: String,
    pub t_us: i64,
    pub value: f64,
    #[schemars(schema_with = "any_object_schema")]
    pub interp: Option<Value>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct RemoveKeyframeArgs {
    pub layer_id: String,
    pub param_key: String,
    pub keyframe_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct RetimeKeyframeArgs {
    pub layer_id: String,
    pub param_key: String,
    pub keyframe_id: String,
    pub t_us: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct SetKeyframeEasingArgs {
    pub layer_id: String,
    pub param_key: String,
    pub keyframe_id: String,
    #[schemars(schema_with = "any_object_schema")]
    pub interp: Value,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct SmoothKeyframesArgs {
    pub layer_id: String,
    pub param_key: String,
    pub keyframe_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct ClearKeyframesArgs {
    pub layer_id: String,
    pub param_key: String,
    pub value: Option<f64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct SetParamTrackArgs {
    pub layer_id: String,
    pub param_key: String,
    #[schemars(schema_with = "any_object_schema")]
    pub track: Value,
}

// ---- errors ---------------------------------------------------------------

#[derive(Debug)]
pub(super) enum KfError {
    Command(CommandError),
    KeyframeNotFound { layer: LayerId, param: String, keyframe_id: KeyframeId },
}

impl From<CommandError> for KfError {
    fn from(e: CommandError) -> Self {
        KfError::Command(e)
    }
}

pub(super) fn kf_error_to_mcp(e: KfError) -> McpError {
    match e {
        KfError::Command(c) => super::tools::map_command_error(c),
        KfError::KeyframeNotFound { layer, param, keyframe_id } => McpError::invalid_params(
            format!("keyframe {keyframe_id} not found on layer {layer} param '{param}'"),
            None,
        ),
    }
}

// ---- shared read step -----------------------------------------------------

/// Read `(layer.t_start_us, current track clone)` for `(layer, param_key)` from
/// a fresh snapshot, or a CommandError-flavored `KfError` if the layer is
/// missing / the param isn't animatable.
async fn read_track(
    project: &ProjectHandle,
    layer_id: LayerId,
    param_key: &str,
) -> Result<(i64, Animated<f64>), KfError> {
    let snap = project.snapshot().await;
    let layer = snap
        .tracks
        .iter()
        .flat_map(|t| t.layers.iter())
        .find(|l| l.id == layer_id)
        .ok_or(KfError::Command(CommandError::LayerNotFound { layer: layer_id }))?;
    let track = resolve_animated_f64(&layer.params, param_key)
        .ok_or_else(|| {
            KfError::Command(CommandError::UnknownKeyframeParam {
                layer: layer_id,
                param_key: param_key.to_string(),
            })
        })?
        .clone();
    Ok((layer.t_start_us, track))
}

fn require_key(
    track: &Animated<f64>,
    layer: LayerId,
    param: &str,
    id: KeyframeId,
) -> Result<(), KfError> {
    let present = matches!(track, Animated::Keyframed(kfs) if kfs.iter().any(|k| k.id == id));
    if present {
        Ok(())
    } else {
        Err(KfError::KeyframeNotFound { layer, param: param.to_string(), keyframe_id: id })
    }
}

// ---- helpers --------------------------------------------------------------

pub(super) async fn get_param_track(
    project: &ProjectHandle,
    layer_id: LayerId,
    param_key: &str,
) -> Result<Value, KfError> {
    let (t_start_us, track) = read_track(project, layer_id, param_key).await?;
    Ok(match track {
        Animated::Static(v) => json!({ "mode": "Static", "value": v }),
        Animated::Keyframed(kfs) => {
            let keyframes: Vec<Value> = kfs
                .iter()
                .map(|k| {
                    json!({
                        "id": k.id.to_string(),
                        "t_us": k.t_us + t_start_us,
                        "t_local_us": k.t_us,
                        "value": k.value,
                        "interp": k.interp,
                    })
                })
                .collect();
            json!({ "mode": "Keyframed", "keyframes": keyframes })
        }
    })
}

pub(super) async fn set_keyframe(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    t_us: i64,
    value: f64,
    interp: Option<crate::state::animated::Interpolation>,
) -> Result<(), KfError> {
    let (t_start_us, track) = read_track(project, layer_id, param_key).await?;
    let new = keyframe_edits::upsert(&track, t_us - t_start_us, value, interp);
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), new)
        .await?;
    Ok(())
}

pub(super) async fn remove_keyframe(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    keyframe_id: KeyframeId,
) -> Result<(), KfError> {
    let (_t_start, track) = read_track(project, layer_id, param_key).await?;
    require_key(&track, layer_id, param_key, keyframe_id)?;
    // `require_key` guarantees the id is in `track`, so `remove` reads the
    // removed key's value and this fallback is unused — but derive it from the
    // snapshot rather than a magic 0.0 so the intent is self-documenting.
    let fallback = match &track {
        Animated::Static(v) => *v,
        Animated::Keyframed(kfs) => kfs.front().map(|k| k.value).unwrap_or(0.0),
    };
    let new = keyframe_edits::remove(&track, keyframe_id, fallback);
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), new)
        .await?;
    Ok(())
}

pub(super) async fn retime_keyframe(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    keyframe_id: KeyframeId,
    t_us: i64,
) -> Result<(), KfError> {
    let (t_start, track) = read_track(project, layer_id, param_key).await?;
    require_key(&track, layer_id, param_key, keyframe_id)?;
    let new = keyframe_edits::retime(&track, keyframe_id, t_us - t_start);
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), new)
        .await?;
    Ok(())
}

pub(super) async fn set_keyframe_easing(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    keyframe_id: KeyframeId,
    interp: crate::state::animated::Interpolation,
) -> Result<(), KfError> {
    let (_t_start, track) = read_track(project, layer_id, param_key).await?;
    require_key(&track, layer_id, param_key, keyframe_id)?;
    let new = keyframe_edits::set_interp(&track, keyframe_id, interp);
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), new)
        .await?;
    Ok(())
}

pub(super) async fn smooth_keyframes(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    keyframe_id: Option<KeyframeId>,
) -> Result<(), KfError> {
    let (_t_start, track) = read_track(project, layer_id, param_key).await?;
    let new = match keyframe_id {
        Some(id) => {
            require_key(&track, layer_id, param_key, id)?;
            keyframe_edits::smooth_one(&track, id)
        }
        None => keyframe_edits::smooth_all(&track),
    };
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), new)
        .await?;
    Ok(())
}

pub(super) async fn clear_keyframes(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    value: Option<f64>,
) -> Result<(), KfError> {
    let (_t_start, track) = read_track(project, layer_id, param_key).await?;
    let new = match (&track, value) {
        (Animated::Static(_), _) => return Ok(()), // already static — no-op
        (Animated::Keyframed(_), Some(v)) => Animated::Static(v),
        (Animated::Keyframed(kfs), None) => {
            Animated::Static(kfs.front().map(|k| k.value).unwrap_or(0.0))
        }
    };
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), new)
        .await?;
    Ok(())
}

pub(super) async fn set_param_track(
    project: &ProjectHandle,
    actor: Actor,
    layer_id: LayerId,
    param_key: &str,
    mut track: Animated<f64>,
) -> Result<(), KfError> {
    // Validate the param + get t_start, then convert incoming (timeline-absolute)
    // keyframe times to layer-local.
    let (t_start, _current) = read_track(project, layer_id, param_key).await?;
    if let Animated::Keyframed(kfs) = &mut track {
        *kfs = kfs
            .iter()
            .map(|k| Keyframe { t_us: k.t_us - t_start, ..k.clone() })
            .collect();
    }
    project
        .update_layer_param_track(actor, layer_id, param_key.to_string(), track)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::actor::spawn;
    use crate::state::ids::new_id;
    use crate::state::{LayerParams, MotifParams, Project, Transform};

    /// A blank project with one Motif layer (opacity is animatable) at
    /// t_start = 2_000_000. Returns the handle + layer id.
    async fn motif_project() -> (ProjectHandle, LayerId) {
        let handle = spawn(Project::new_blank("kf-test"));
        let track_id = handle
            .add_track(Actor::User, Some("kf".into()))
            .await
            .expect("add_track");
        let params = LayerParams::Motif(MotifParams {
            motif_id: "countdown".into(),
            motif_version: 1,
            props: imbl::HashMap::new(),
            src_in_us: 0,
            transform: Transform::default(),
            opacity: Animated::Static(1.0),
        });
        let layer_id = handle
            .add_layer(Actor::User, track_id, params, 2_000_000, 7_000_000)
            .await
            .expect("add_layer");
        (handle, layer_id)
    }

    #[tokio::test]
    async fn set_get_remove_roundtrip_with_timeline_absolute_times() {
        let (handle, layer_id) = motif_project().await;
        set_keyframe(&handle, Actor::User, layer_id, "opacity", 2_000_000, 0.0, None)
            .await
            .unwrap();
        set_keyframe(&handle, Actor::User, layer_id, "opacity", 4_000_000, 1.0, None)
            .await
            .unwrap();

        let v = get_param_track(&handle, layer_id, "opacity").await.unwrap();
        assert_eq!(v["mode"], "Keyframed");
        let kfs = v["keyframes"].as_array().unwrap();
        assert_eq!(kfs.len(), 2);
        // Timeline-absolute in, timeline-absolute out; layer-local is t - t_start.
        assert_eq!(kfs[0]["t_us"], 2_000_000);
        assert_eq!(kfs[0]["t_local_us"], 0);
        assert_eq!(kfs[1]["t_us"], 4_000_000);
        assert_eq!(kfs[1]["t_local_us"], 2_000_000);

        // Remove the first key by id → one key left.
        let id0: KeyframeId = kfs[0]["id"].as_str().unwrap().parse().unwrap();
        remove_keyframe(&handle, Actor::User, layer_id, "opacity", id0)
            .await
            .unwrap();
        let v2 = get_param_track(&handle, layer_id, "opacity").await.unwrap();
        let kfs2 = v2["keyframes"].as_array().unwrap();
        assert_eq!(kfs2.len(), 1);

        // Remove the last key → collapses to Static holding its value (1.0).
        let id1: KeyframeId = kfs2[0]["id"].as_str().unwrap().parse().unwrap();
        remove_keyframe(&handle, Actor::User, layer_id, "opacity", id1)
            .await
            .unwrap();
        let v3 = get_param_track(&handle, layer_id, "opacity").await.unwrap();
        assert_eq!(v3["mode"], "Static");
        assert_eq!(v3["value"], 1.0);
    }

    #[tokio::test]
    async fn remove_unknown_keyframe_errors() {
        let (handle, layer_id) = motif_project().await;
        set_keyframe(&handle, Actor::User, layer_id, "opacity", 2_000_000, 0.0, None)
            .await
            .unwrap();
        let res = remove_keyframe(&handle, Actor::User, layer_id, "opacity", new_id()).await;
        assert!(matches!(res, Err(KfError::KeyframeNotFound { .. })));
    }

    #[tokio::test]
    async fn keyframe_on_non_animatable_param_errors() {
        let (handle, layer_id) = motif_project().await;
        // Motif has no gain_db.
        let res = set_keyframe(&handle, Actor::User, layer_id, "gain_db", 0, 0.0, None).await;
        assert!(matches!(
            res,
            Err(KfError::Command(CommandError::UnknownKeyframeParam { .. }))
        ));
    }

    #[tokio::test]
    async fn set_param_track_converts_timeline_absolute_to_local() {
        let (handle, layer_id) = motif_project().await;
        // Two opacity keyframes given in TIMELINE-ABSOLUTE microseconds.
        let track = Animated::Keyframed(
            vec![
                Keyframe {
                    id: new_id(),
                    t_us: 2_000_000,
                    value: 0.0,
                    interp: crate::state::animated::Interpolation::Linear,
                },
                Keyframe {
                    id: new_id(),
                    t_us: 5_000_000,
                    value: 1.0,
                    interp: crate::state::animated::Interpolation::Linear,
                },
            ]
            .into_iter()
            .collect(),
        );
        set_param_track(&handle, Actor::User, layer_id, "opacity", track)
            .await
            .unwrap();

        // Stored layer-local (t - t_start = t - 2_000_000); read back as absolute.
        let v = get_param_track(&handle, layer_id, "opacity").await.unwrap();
        let kfs = v["keyframes"].as_array().unwrap();
        assert_eq!(kfs.len(), 2);
        assert_eq!(kfs[0]["t_local_us"], 0);
        assert_eq!(kfs[0]["t_us"], 2_000_000);
        assert_eq!(kfs[1]["t_local_us"], 3_000_000);
        assert_eq!(kfs[1]["t_us"], 5_000_000);
    }
}
