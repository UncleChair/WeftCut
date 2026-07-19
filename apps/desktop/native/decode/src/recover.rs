//! Panic-resilience helpers shared by the decode session threads.
//!
//! Two related hazards live in this component, both rooted in the fact that each
//! preview/export session runs on its OWN spawned OS thread and fans frames out
//! through cross-session shared state (the registry `sink` cell, the backend's
//! per-stream `*_sinks` maps, the credit window):
//!
//! 1. **Poison cascade.** `std::sync::Mutex` poisons when a thread panics while
//!    holding the guard. `emit()` holds the `sink` lock ACROSS the routing
//!    closure, which in turn locks a `*_sinks` map — so one panicking decode
//!    thread can poison locks that EVERY other session (and every `open`/`close`)
//!    then hits with `.lock().unwrap()`, turning a single-session failure into an
//!    addon-wide meltdown. [`LockExt::lock_recover`] recovers the guard instead of
//!    re-panicking on poison — the same policy `parking_lot::Mutex` applies by
//!    default. The data behind these locks (a `HashMap`, an `Option<Box<..>>`, a
//!    credit counter) has no cross-field invariant a mid-panic guard could leave
//!    unsafe, so recovering is sound; keeping std `Mutex` avoids adding a
//!    dependency to this supply-chain-sensitive addon.
//!
//! 2. **Silent decode-thread death.** A panic inside the ffmpeg decode path
//!    unwinds the session thread with no signal; the renderer just waits forever
//!    on frames that never arrive. The session loops wrap each service call in
//!    `catch_unwind` and turn a caught panic into a normal `Error` poke (via
//!    [`panic_message`]) so JS learns the session failed and can tear it down.

use std::any::Any;
use std::sync::{Mutex, MutexGuard};

/// Poison-tolerant locking for the component's cross-session mutexes. See the
/// module docs for why recovering the guard (rather than propagating the
/// `PoisonError` as a panic) is both sound and necessary here.
pub(crate) trait LockExt<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Best-effort human string from a caught panic payload (`catch_unwind`'s
/// `Box<dyn Any + Send>`). `panic!`/`.unwrap()`/`.expect()` payloads are `&str`
/// or `String`; anything else degrades to a generic label rather than losing the
/// fact that a panic occurred.
pub(crate) fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}
