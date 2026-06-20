//! Slim preview helper module.
//!
//! The Rust side runs ffmpeg only at import (proxies) and export; preview
//! rendering is done by the DOM/Pixi renderer. This module's sole remaining
//! job is [`with_proxies_substituted`], used by both the export pipeline and
//! the Render & Play path to swap source paths for their proxy before
//! lowering. See `docs/preview.md`.

use crate::state::Project;

/// Clone the project with each `MediaItem.path_abs` replaced by its
/// full `proxy_path` when that proxy exists on disk. Per-clip proxies are
/// H.264 + AAC capped at `jobs::proxy::PROXY_HEIGHT_CAP`; export's `Scale` node
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
