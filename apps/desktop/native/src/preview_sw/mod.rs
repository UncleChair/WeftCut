//! Cross-platform pure-software preview decode for WebCodecs-blind formats
//! (ProRes, DNxHD, MPEG-2, VC-1). Mirrors `preview_gpu` but decodes to CPU
//! frames via libavcodec (no D3D11 / hardware path) and swscales to 8-bit NV12.
//!
//! Task 2 ships only the decoder; Task 3 adds `session` (the registry + open
//! bridge that drives it from a worker thread).

pub mod decoder;
