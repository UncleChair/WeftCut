//! `Project → IRGraph`. Pure function over `&Project` + `RenderTarget`.
//!
//! Audio-only post P12-b: the visual half of the IR was deleted with the
//! Pixi-renderer migration. Lowering walks every enabled, non-locked
//! `LayerParams::Audio(_)` layer, places it via `DecodeA → Adelay`, and
//! amix-mixes the result into a single `OutA`.

use thiserror::Error;

use super::graph::IRGraph;
use super::node::{IRNode, NodeId};
use super::target::RenderTarget;
use crate::state::ids::MediaId;
use crate::state::layer::LayerParams;
use crate::state::project::Project;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum LowerError {
    #[error("layer references missing media {0}")]
    MissingMedia(MediaId),
}

pub fn lower(project: &Project, target: RenderTarget) -> Result<IRGraph, LowerError> {
    let mut g = IRGraph::new(target);

    let mut audio_streams: Vec<NodeId> = Vec::new();

    for track in project.tracks.iter() {
        if !track.enabled {
            continue;
        }
        for layer in track.layers.iter() {
            if !layer.enabled || layer.locked {
                continue;
            }
            let LayerParams::Audio(p) = &layer.params else {
                continue;
            };
            if p.mute {
                continue;
            }
            let media = project
                .media_pool
                .get(&p.media)
                .ok_or(LowerError::MissingMedia(p.media))?;
            let input = g.add_input(&media.path_abs);
            let dec = g.add_node(IRNode::DecodeA {
                input,
                src_in_us: p.src_in_us,
                src_out_us: p.src_out_us,
            });
            let placed = g.add_node(IRNode::Adelay {
                in_: dec,
                offset_us: layer.t_start_us,
            });
            audio_streams.push(placed);
        }
    }

    if !audio_streams.is_empty() {
        let mixed = if audio_streams.len() == 1 {
            audio_streams[0]
        } else {
            g.add_node(IRNode::Amix { inputs: audio_streams })
        };
        let a_out = g.add_node(IRNode::OutA {
            in_: mixed,
            label: "aout".into(),
            sample_rate: target.sample_rate,
        });
        g.audio_out = Some(a_out);
    }

    Ok(g)
}
