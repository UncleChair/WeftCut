//! Slim preview helper module.
//!
//! Post DOM-preview cutover (`docs/preview.md` Phase F), the
//! Rust-side preview renderer is gone. ffmpeg runs only at import
//! (proxies) and export. This module survives as the home of
//! [`with_proxies_substituted`], which both the export pipeline
//! and the Render & Play path use to swap source paths for their
//! 540p (or canvas-capped) proxy before lowering.
//!
//! Everything else that used to live here — `PreviewRenderer`,
//! segmented cache (`segmented.rs`), encoder + manifest +
//! queue + codec + failure machinery, the `preview:render_*` and
//! `preview:segment_*` Tauri events — was deleted at cutover.
//! See `docs/preview.md` (now archival) for the
//! prior design.

use crate::state::Project;

/// Clone the project with each `MediaItem.path_abs` replaced by its
/// full `proxy_path` when that proxy exists on disk. Per-clip proxies are
/// `jobs::proxy::PROXY_HEIGHT` H.264 + AAC; export's `Scale` node
/// upscales to canvas anyway, so resolution substitution is
/// transparent. Quick proxies are preview-only TS-side artifacts and are
/// deliberately ignored here.
pub fn with_proxies_substituted(project: &Project) -> Project {
    let mut next = project.clone();
    let updates: Vec<_> = next
        .media_pool
        .iter()
        .filter_map(|(id, item)| {
            let proxy = item.proxy_path.as_ref()?;
            if !proxy.is_file() {
                return None;
            }
            let mut swapped = item.clone();
            swapped.path_abs = proxy.clone();
            Some((*id, swapped))
        })
        .collect();
    for (id, item) in updates {
        next.media_pool.insert(id, item);
    }
    next
}
