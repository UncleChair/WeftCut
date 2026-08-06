//! Bounded waits for the session tests. Test-only (`#[cfg(test)]` in lib.rs).
//!
//! Every lane's session does its work on its own thread — spin-up, a real
//! libavcodec decode, then a sink callback — so a test that wants to observe the
//! result has to wait for another thread. `thread::sleep(fixed)` before the
//! assertion turns that wait into an assertion about MACHINE SPEED: a budget
//! that is comfortable on a dev box fails on a loaded CI runner, and the failure
//! is indistinguishable from the behaviour under test being broken. The
//! export-lane decode-panic test failed exactly that way on the windows leg (run
//! 31110481180) with a 300 ms sleep, reporting an empty vec of pokes.
//!
//! Polling instead is both faster on a fast machine and honest on a slow one:
//! the deadline is long enough that reaching it means the condition really is
//! not coming, so a timeout stays a real finding.

use std::thread;
use std::time::Duration;

/// Poll `cond` until it holds, for up to ~5 s. Returns whether it held, so the
/// caller keeps its own assertion message (and can print the state it observed).
///
/// Use this instead of a fixed sleep whenever the next statement asserts on
/// something a session thread produces. A fixed sleep is still right for the
/// opposite shape — proving something does NOT happen, or that a call returns
/// promptly — where there is no condition to poll for.
pub(crate) fn wait_for(mut cond: impl FnMut() -> bool) -> bool {
    for _ in 0..500 {
        if cond() {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    cond()
}
