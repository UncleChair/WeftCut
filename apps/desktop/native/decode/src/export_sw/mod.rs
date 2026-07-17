//! Cross-platform export-side software decode: decodes a WebCodecs-blind
//! ORIGINAL directly for export — no lossy full-proxy — over an exactly-once,
//! GOP-exact, credit-windowed range contract. See ADR 0030 and ADR 0033.
//!
//! Owns: a per-source worker thread (`session`) that reuses
//! `preview_sw::decoder::SwVideoStream` (open / robust seek / presentation-
//! ordered `next_frame` / internal EOS drain / color tags) and fans frames plus
//! control signals out through a registry sink; `backend.rs` routes every poke
//! in-band to the napi per-session callback, preserving producer order.
//!
//! Does NOT own: the decode surface (that is `preview_sw::decoder`), nor any of
//! the WebCodecs no-mid-flush / stop-key / pool-slot machinery — none of it
//! carries over, because `next_frame` already yields presentation order and this
//! session holds no VideoFrame pool. The range/credit contract lives at
//! `serve_range` and `CreditWindow` below.

mod session;
// `backend.rs` drives the registry and matches on its pokes by these two paths;
// the other public items stay reachable through the registry's methods.
pub use session::{ExportPoke, ExportSwRegistry};
