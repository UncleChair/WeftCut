//! Motifs: web pages captured to deterministic video frames.
//!
//! A Motif is a `manifest.json`-island + `index.html` (+ `assets/`) bundle. The
//! brain — catalog, on-disk user store, authoring lifecycle, cross-project
//! staleness, and the file watcher — lives here and is exposed via napi. The
//! capture *driver* lives in the Electron main process (`electron/main/motif/`):
//! an offscreen `BrowserWindow` + `webContents.debugger` CDP renders + screenshots
//! a Motif, with bytes served by `motif_resolve_file` over `protocol.handle`.

pub mod authoring;
pub mod authoring_commands;
pub mod builtin;
pub mod catalog;
pub mod staleness;
pub mod store;
pub mod watcher;

/// Resolve the capture `ctx.duration` (seconds) for `motif_id`: search the
/// built-ins, then (lazily — only if not a built-in) the user manifests, then
/// fall back to 5.0. `get_user_manifests` is only invoked when `motif_id` is
/// not a built-in, so built-in captures never touch the disk. Pure (modulo the
/// caller's closure) so it stays unit-testable. (Relocated from the deleted
/// `commands.rs`; backs the `motif_ctx_duration_s` napi method.)
pub fn resolve_capture_duration(
    motif_id: &str,
    builtins: &[catalog::Motif],
    get_user_manifests: impl FnOnce() -> Vec<catalog::Manifest>,
    props: &serde_json::Value,
) -> f64 {
    if let Some(m) = builtins.iter().find(|m| m.id() == motif_id) {
        return catalog::motif_ctx_duration_s(&m.manifest, props);
    }
    for m in get_user_manifests() {
        if m.id == motif_id {
            return catalog::motif_ctx_duration_s(&m, props);
        }
    }
    5.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::motifs::catalog::{builtin_countdown, Manifest};

    #[test]
    fn duration_uses_builtin_then_user_then_default() {
        let builtins = catalog::builtins();
        let props = serde_json::json!({ "seconds": 7 });
        let d = resolve_capture_duration("countdown", &builtins, Vec::new, &props);
        assert!((d - 7.0).abs() < 1e-9);
        let d_no_walk = resolve_capture_duration(
            "countdown",
            &builtins,
            || panic!("built-in capture must not walk the user-motif store"),
            &props,
        );
        assert!((d_no_walk - 7.0).abs() < 1e-9);
        let mut user: Manifest = builtin_countdown().manifest;
        user.id = "user-x".into();
        user.max_duration_prop = None;
        user.max_duration_s = None;
        user.content_duration_s = Some(2.5);
        let d2 = resolve_capture_duration("user-x", &builtins, move || vec![user], &serde_json::json!({}));
        assert!((d2 - 2.5).abs() < 1e-9);
        let d3 = resolve_capture_duration("ghost", &builtins, Vec::new, &serde_json::json!({}));
        assert!((d3 - 5.0).abs() < 1e-9);
    }
}
