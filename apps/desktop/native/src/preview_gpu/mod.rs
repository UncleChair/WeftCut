//! Windows-only native GPU decode preview path (decode-bench Stage 2).
//! d3d11va decode -> GPU->GPU copy into a pool of shared NV12 textures ->
//! Electron sharedTexture -> renderer FrameRing. 8-bit only (Result-7 P010 block).
//! Lifted from poc/shared-texture (branch poc/shared-texture-import); see
//! poc/shared-texture/INTEGRATION-DESIGN.md.
pub mod decoder;
// mod session;   // Task 4
// pub use session::PreviewGpuRegistry;  // Task 4
