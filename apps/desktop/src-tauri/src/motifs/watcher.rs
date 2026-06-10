//! Stage-5 file watch: a recursive `notify` watcher on the user-Motif root.
//!
//! Any disk change — external-editor saves included — coalesces through a
//! quiet-window debounce into ONE `motifs:changed` emit; the frontend's
//! existing resync pipeline (syncCatalog → content-hash cache key → `?v=`
//! host cache-buster → sprite refresh) does the rest. Deliberately NO
//! per-file dispatch (the resync is a full, idempotent refresh) and NO
//! filtering of the app's own writes (install/delete/amend also emit
//! `motifs:changed` themselves; the debounced duplicate is harmless).

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};

/// Quiet window: after a change, wait until this long passes with no further
/// event, then fire once. Absorbs editor write bursts and multi-file writes.
pub const DEBOUNCE_QUIET: Duration = Duration::from_millis(400);

/// Keeps the OS watcher alive for the app's lifetime (held in managed state).
pub struct MotifWatcher {
    _watcher: notify::RecommendedWatcher,
}

/// Attach a recursive watcher at `root` (created if missing — a first boot
/// has no user Motifs yet, but the watcher must still attach) and fire
/// `on_change` once per debounced burst.
pub fn spawn(
    root: PathBuf,
    on_change: impl Fn() + Send + 'static,
) -> notify::Result<MotifWatcher> {
    std::fs::create_dir_all(&root).ok();
    let (tx, rx) = mpsc::channel::<()>();
    // Errors are forwarded as change signals too: an overflow means
    // "something changed that we may have missed" — a spurious resync is
    // harmless, a missed one isn't.
    let mut watcher =
        notify::recommended_watcher(move |_res: notify::Result<notify::Event>| {
            let _ = tx.send(());
        })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;
    std::thread::spawn(move || debounce_loop(&rx, DEBOUNCE_QUIET, on_change));
    Ok(MotifWatcher { _watcher: watcher })
}

/// Coalesce: block for the next event, drain until `quiet` elapses with no
/// further event, then fire once. Exits when the channel disconnects (the
/// watcher was dropped).
pub fn debounce_loop(rx: &mpsc::Receiver<()>, quiet: Duration, on_change: impl Fn()) {
    while rx.recv().is_ok() {
        while rx.recv_timeout(quiet).is_ok() {}
        on_change();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn debounce_coalesces_a_burst_into_one_fire() {
        let (tx, rx) = mpsc::channel::<()>();
        let fired = Arc::new(AtomicUsize::new(0));
        let f = fired.clone();
        let handle = std::thread::spawn(move || {
            debounce_loop(&rx, Duration::from_millis(50), move || {
                f.fetch_add(1, Ordering::SeqCst);
            })
        });
        for _ in 0..5 {
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(5));
        }
        std::thread::sleep(Duration::from_millis(250));
        assert_eq!(fired.load(Ordering::SeqCst), 1, "burst must coalesce to one fire");
        tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(250));
        assert_eq!(fired.load(Ordering::SeqCst), 2, "a later burst fires again");
        drop(tx); // disconnect -> loop exits
        handle.join().unwrap();
    }

    #[test]
    fn watcher_fires_on_a_real_file_write() {
        let dir = tempfile::tempdir().unwrap();
        let fired = Arc::new(AtomicUsize::new(0));
        let f = fired.clone();
        let _w = spawn(dir.path().to_path_buf(), move || {
            f.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        // Give the OS watch a beat to attach before writing.
        std::thread::sleep(Duration::from_millis(200));
        std::fs::create_dir_all(dir.path().join("m1")).unwrap();
        std::fs::write(dir.path().join("m1").join("index.html"), "<html>").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while fired.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(fired.load(Ordering::SeqCst) >= 1, "watcher never fired on a write");
    }
}
