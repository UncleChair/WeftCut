//! Windows-only native GPU decode preview path (decode-bench Stage 2).
//! d3d11va decode -> GPU->GPU copy into a pool of shared NV12 textures ->
//! Electron sharedTexture -> renderer FrameRing. 8-bit only (Result-7 P010 block).
//! Lifted from poc/shared-texture (branch poc/shared-texture-import); see
//! poc/shared-texture/INTEGRATION-DESIGN.md.
pub mod decoder;
mod session;
// The registry + its wire types are the seam Task 5 wires to the addon's event
// channel; unused until then (allow keeps the base build's warning set clean).
#[allow(unused_imports)]
pub use session::{OpenInfo, PreviewGpuPoke, PreviewGpuRegistry, TimingReport, TimingSummary};
