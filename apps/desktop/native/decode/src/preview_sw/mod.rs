//! Cross-platform pure-software preview decode for WebCodecs-blind formats
//! (ProRes, DNxHD, MPEG-2, VC-1). Mirrors `preview_gpu` but decodes to CPU
//! frames via libavcodec (no D3D11 / hardware path) and swscales to 8-bit NV12.
//!
//! `decoder` is the streaming CPU decode surface; `session` drives it from a
//! per-source worker thread and fans decoded frames out through a registry sink
//! (the napi addon wires that sink + registry).

pub mod decoder;
mod session;
pub use session::{PreviewSwOpenInfo, PreviewSwRegistry, SwFramePoke};
