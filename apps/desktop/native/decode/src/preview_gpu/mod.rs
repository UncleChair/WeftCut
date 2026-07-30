//! Windows-only native GPU decode preview path (decode-bench Stage 2).
//! d3d11va decode -> own-shader NV12→RGBA conversion into a pool of shared
//! RGBA8 textures -> Electron sharedTexture -> renderer FrameRing. The
//! conversion (convert.rs) keeps color math + tag authority native (ADR 0032
//! generalized): the browser receives sRGB-passthrough RGBA and its
//! createImageBitmap is a pure byte copy. 8-bit only (Result-7 P010 block).
//! Lifted from poc/shared-texture (branch poc/shared-texture-import); see
//! poc/shared-texture/INTEGRATION-DESIGN.md.
pub mod convert;
pub mod decoder;
mod session;
// The registry + its wire types are the seam the addon wires to its event
// channel; the base build doesn't (allow keeps its warning set clean).
#[allow(unused_imports)]
pub use session::{OpenInfo, PreviewGpuPoke, PreviewGpuRegistry, TimingReport, TimingSummary};
