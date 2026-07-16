//! WeftCut native decode component (`@weftcut/native-decode`): the optional
//! preview-decode runtime (SW libavcodec lane everywhere, D3D11 GPU lane on
//! Windows). Lazily required by Electron main; absence must never affect
//! `@weftcut/core`. See docs/adr/0030 and docs/preview.md §Decode engine.

mod backend;
mod events;
mod export_sw;
#[cfg(windows)]
mod preview_gpu;
mod preview_sw;
