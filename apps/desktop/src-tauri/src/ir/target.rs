//! Render-target parameterization. Same IR, two targets — preview at proxy
//! resolution, export at full.

// `RenderTarget::proxy` is the proxy-resolution constructor. Live preview
// currently uses `full` (libmpv's vo handles scaling); proxy lands when
// background-job thumbnails / waveform generation does.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use crate::state::time::Rational;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderTarget {
    pub width: u32,
    pub height: u32,
    pub fps: Rational,
    pub sample_rate: u32,
    pub channels: u8,
    pub quality: Quality,
    pub hwaccel: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Quality {
    Draft,
    Final,
}

impl RenderTarget {
    /// Project's full-resolution target — for export.
    pub fn full(
        width: u32,
        height: u32,
        fps: Rational,
        sample_rate: u32,
        channels: u8,
    ) -> Self {
        Self {
            width,
            height,
            fps,
            sample_rate,
            channels,
            quality: Quality::Final,
            hwaccel: true,
        }
    }

    /// Proxy resolution for live preview. Mirrors the project's aspect ratio
    /// at `preview_width` × proportional height; fps unchanged.
    pub fn proxy(
        preview_width: u32,
        preview_height: u32,
        fps: Rational,
        sample_rate: u32,
        channels: u8,
    ) -> Self {
        Self {
            width: preview_width,
            height: preview_height,
            fps,
            sample_rate,
            channels,
            quality: Quality::Draft,
            hwaccel: true,
        }
    }
}
