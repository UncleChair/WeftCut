//! weftcut-eval: the pure, dependency-light "WYSIWYG math" shared by the
//! actor + export (native build) and the renderer (wasm32 build). No imbl /
//! uuid / napi / tokio. See docs/superpowers/plans/2026-06-20-weftcut-eval-leaf-crate.md
//!
//! `no_std` ONLY on wasm32: the wasm artifact must stay minimal and std-free,
//! and the wasm build (run on every task) is what enforces the "core/libm only"
//! discipline. Natively the crate links std so its `cdylib`/`rlib`/test targets
//! build without a hand-rolled panic handler or eh_personality — it is consumed
//! by the napi crate purely as an `rlib`, and the wasm `cdylib` is the only
//! std-free artifact we actually ship.
#![cfg_attr(target_arch = "wasm32", no_std)]

/// Temporary smoke symbol; removed once real functions land.
pub const CRATE_OK: bool = true;

// On wasm32 the crate is no_std and links as a standalone cdylib, so it must
// supply its own panic handler. wasm32-unknown-unknown defaults to panic=abort,
// so no eh_personality is needed. Never compiled natively (std supplies one).
#[cfg(all(target_arch = "wasm32", not(test)))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
