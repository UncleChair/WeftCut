//! Cross-platform preview decode for WebCodecs-blind formats (ProRes, DNxHD,
//! MPEG-2, VC-1). Mirrors `preview_gpu` but ships CPU frames: libavcodec decodes
//! on the software lane or a copy-back hardware lane (NVDEC/VAAPI/VideoToolbox),
//! packed as 8-bit NV12 or u16LE I420P10.
//!
//! `decoder` is the streaming CPU decode surface; `session` drives it from a
//! per-source worker thread and fans decoded frames out through a registry sink
//! (the napi addon wires that sink + registry).

pub mod decoder;
mod session;
pub use session::{PreviewSwRegistry, SwFramePoke};
