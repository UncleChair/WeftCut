//! Priority queue for per-segment render jobs (Phase A3).
//!
//! Vec-backed, since the queue is small (typically < 50 jobs even on long
//! projects after the diff). `push` is O(1), `pop` is O(n) for the
//! highest-priority scan — fast enough at this scale and trivial to
//! reason about.
//!
//! Priority classes (lower value = higher priority, decided at enqueue
//! time by the orchestrator):
//!   * `Playhead` — the segment under the current playhead. User is
//!     looking at it.
//!   * `Visible` — segments within the timeline panel's scroll viewport.
//!   * `PlayheadAdjacent` — segments touching the playhead segment, so
//!     playback doesn't stall at the next boundary.
//!   * `Ordered` — everything else, drained in timeline order.
//!
//! Cancellation: each push returns a [`CancelHandle`] that the
//! orchestrator can fire to kill a running job — the worker watches the
//! handle's `Notify` via `tokio::select!` and drops the ffmpeg `Child`
//! when cancellation wins. `kill_on_drop` on the spawn command sends
//! SIGKILL/`TerminateProcess` automatically.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::{Mutex, Notify};

use crate::ir::{InlineSubPaths, TemplateRenders};
use crate::state::Project;

/// Priority class for a queued segment. `Ord` is significant: lower
/// value = higher priority. Workers pop the lowest `(class, seq)` pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PriorityClass {
    /// Segment under the current playhead — render first.
    Playhead = 0,
    /// Inside the visible timeline region.
    Visible = 1,
    /// Adjacent to the playhead segment (next/prev). Reduces stalls on
    /// crossing a segment boundary during playback.
    PlayheadAdjacent = 2,
    /// Default. Drained in timeline order (lowest `in_us` first within
    /// this class, via the `seq` counter set at enqueue time).
    Ordered = 3,
}

#[derive(Clone, Debug)]
pub struct SegmentJob {
    pub hash: String,
    pub in_us: i64,
    pub out_us: i64,
    /// Orchestrator's commit counter at enqueue time. Used to decide
    /// staleness for cancellation (`current_commit - job.commit_id >= 2`
    /// → kill — see decision in `docs/preview-segmented-cache.md`).
    pub commit_id: u64,
    /// Project snapshot that produced this job's `hash`. Workers must
    /// render against THIS snapshot or the bytes won't match the hash —
    /// breaking the dedup invariant. Arc'd so all jobs in a cycle share
    /// one snapshot at zero copy cost.
    pub project: Arc<Project>,
    /// Same-cycle materialized inline subtitles. Side map keyed by
    /// LayerId — the rebased project still uses the original LayerIds.
    pub inline_subs: Arc<InlineSubPaths>,
    /// Same-cycle materialized template renders.
    pub template_renders: Arc<TemplateRenders>,
}

/// Cancellation handle. Cheap to clone — both fields are `Arc`. The
/// orchestrator keeps one copy per in-flight job and calls `cancel()` to
/// signal the worker.
#[derive(Clone)]
pub struct CancelHandle {
    cancelled: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl CancelHandle {
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// `await` resolves as soon as `cancel()` has been called (now or
    /// later). Use inside `tokio::select!` to race against the job's
    /// future — when cancel wins, drop the job future and `kill_on_drop`
    /// on the ffmpeg `Child` does the rest.
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        // The store happens-before the notify_waiters in `cancel()`; the
        // notify-then-recheck loop catches the race where the store landed
        // between is_cancelled() above and notified() below.
        loop {
            let waiter = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            waiter.await;
            if self.is_cancelled() {
                return;
            }
        }
    }
}

impl Default for CancelHandle {
    fn default() -> Self {
        Self::new()
    }
}

struct QueuedItem {
    job: SegmentJob,
    class: PriorityClass,
    seq: u64,
    cancel: CancelHandle,
}

/// Priority queue holding pending segment renders. Producer side calls
/// `push`; worker tasks call `pop` (blocks until an item arrives).
pub struct SegmentQueue {
    items: Mutex<Vec<QueuedItem>>,
    notify: Notify,
    seq_counter: AtomicU64,
}

impl SegmentQueue {
    pub fn new() -> Self {
        Self {
            items: Mutex::new(Vec::new()),
            notify: Notify::new(),
            seq_counter: AtomicU64::new(0),
        }
    }

    /// Enqueue a job. Returns a CancelHandle the orchestrator can fire to
    /// kill the job in-flight. `seq` is an internal monotonic counter so
    /// FIFO ordering within a class is the enqueue order.
    pub async fn push(
        &self,
        job: SegmentJob,
        class: PriorityClass,
    ) -> CancelHandle {
        let seq = self.seq_counter.fetch_add(1, Ordering::Relaxed);
        let cancel = CancelHandle::new();
        {
            let mut items = self.items.lock().await;
            items.push(QueuedItem {
                job,
                class,
                seq,
                cancel: cancel.clone(),
            });
        }
        // notify_waiters wakes *all* pending pops so multiple workers can
        // race to claim the new item. The pop loop re-checks emptiness
        // under the lock so only one wins.
        self.notify.notify_waiters();
        cancel
    }

    /// Wait for the highest-priority item and pop it. Resolves only when
    /// an item is available — there is no "queue closed" state in A3
    /// because the SegmentedRenderer holds the queue for the app
    /// lifetime.
    pub async fn pop(&self) -> (SegmentJob, CancelHandle) {
        loop {
            // Register the waiter BEFORE checking. This closes the race
            // where a push could land between our check and our wait.
            let waiter = self.notify.notified();
            {
                let mut items = self.items.lock().await;
                if let Some(idx) = best_index(&items) {
                    let item = items.swap_remove(idx);
                    return (item.job, item.cancel);
                }
            }
            waiter.await;
        }
    }

    /// Remove all currently-queued items whose hash isn't kept by the
    /// predicate. Used by the orchestrator when a new manifest's diff
    /// makes some pending segments obsolete.
    pub async fn retain_hashes<F: Fn(&str) -> bool>(&self, keep: F) -> usize {
        let mut items = self.items.lock().await;
        let before = items.len();
        items.retain(|it| keep(it.job.hash.as_str()));
        before - items.len()
    }

    /// Number of items currently waiting. O(1).
    pub async fn len(&self) -> usize {
        self.items.lock().await.len()
    }
}

impl Default for SegmentQueue {
    fn default() -> Self {
        Self::new()
    }
}

/// Return the index of the highest-priority item — lowest `(class, seq)`.
/// `None` only on an empty slice.
fn best_index(items: &[QueuedItem]) -> Option<usize> {
    items
        .iter()
        .enumerate()
        .min_by_key(|(_, it)| (it.class, it.seq))
        .map(|(i, _)| i)
}

/// Compute the worker concurrency for the preview segment queue. Per
/// `docs/preview-segmented-cache.md` decision M3:
///   * With HW encoder: `min(num_cpus/2, HW_SESSION_CAP=6)` — NVENC
///     consumer cards top out around 6 effective sessions, so going
///     wider oversubscribes the GPU.
///   * Without HW: `num_cpus/2` — leaves headroom for the editor itself.
pub fn worker_concurrency(num_cpus: usize, has_hw_encoder: bool) -> usize {
    const HW_SESSION_CAP: usize = 6;
    let base = (num_cpus / 2).max(1);
    if has_hw_encoder {
        base.min(HW_SESSION_CAP)
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    fn job(hash: &str, in_us: i64, out_us: i64) -> SegmentJob {
        SegmentJob {
            hash: hash.into(),
            in_us,
            out_us,
            commit_id: 0,
            project: Arc::new(Project::new_blank("queue-test")),
            inline_subs: Arc::new(InlineSubPaths::new()),
            template_renders: Arc::new(TemplateRenders::new()),
        }
    }

    #[tokio::test]
    async fn pop_blocks_when_empty() {
        let q = SegmentQueue::new();
        // Pop with a tight timeout — must NOT resolve.
        let r = timeout(Duration::from_millis(50), q.pop()).await;
        assert!(r.is_err(), "pop must block on empty queue");
    }

    #[tokio::test]
    async fn single_item_pops_immediately() {
        let q = SegmentQueue::new();
        let _h = q.push(job("a", 0, 1_000_000), PriorityClass::Ordered).await;
        let (j, _c) = q.pop().await;
        assert_eq!(j.hash, "a");
    }

    #[tokio::test]
    async fn fifo_within_same_class() {
        let q = SegmentQueue::new();
        for h in ["a", "b", "c"] {
            q.push(job(h, 0, 1), PriorityClass::Ordered).await;
        }
        assert_eq!(q.pop().await.0.hash, "a");
        assert_eq!(q.pop().await.0.hash, "b");
        assert_eq!(q.pop().await.0.hash, "c");
    }

    #[tokio::test]
    async fn priority_class_wins_over_seq() {
        let q = SegmentQueue::new();
        // Enqueue ordered first, then playhead. Playhead must pop first.
        q.push(job("o1", 0, 1), PriorityClass::Ordered).await;
        q.push(job("o2", 0, 1), PriorityClass::Ordered).await;
        q.push(job("p", 0, 1), PriorityClass::Playhead).await;
        q.push(job("v", 0, 1), PriorityClass::Visible).await;
        // Pop order: playhead, visible, then ordered FIFO.
        assert_eq!(q.pop().await.0.hash, "p");
        assert_eq!(q.pop().await.0.hash, "v");
        assert_eq!(q.pop().await.0.hash, "o1");
        assert_eq!(q.pop().await.0.hash, "o2");
    }

    #[tokio::test]
    async fn push_wakes_blocked_pop() {
        let q = Arc::new(SegmentQueue::new());
        let q_for_pop = q.clone();
        let waiter = tokio::spawn(async move { q_for_pop.pop().await });
        // Give the pop task a moment to register the waiter.
        tokio::time::sleep(Duration::from_millis(20)).await;
        q.push(job("late", 0, 1), PriorityClass::Ordered).await;
        let (j, _c) =
            timeout(Duration::from_millis(200), waiter).await.unwrap().unwrap();
        assert_eq!(j.hash, "late");
    }

    #[tokio::test]
    async fn retain_hashes_drops_unwanted_items() {
        let q = SegmentQueue::new();
        for h in ["keep1", "drop", "keep2"] {
            q.push(job(h, 0, 1), PriorityClass::Ordered).await;
        }
        let dropped = q
            .retain_hashes(|h| h.starts_with("keep"))
            .await;
        assert_eq!(dropped, 1);
        assert_eq!(q.len().await, 2);
    }

    #[tokio::test]
    async fn cancel_handle_signals_waiters() {
        let h = CancelHandle::new();
        assert!(!h.is_cancelled());
        let h2 = h.clone();
        let waiter = tokio::spawn(async move {
            h2.cancelled().await;
            h2.is_cancelled()
        });
        // Give the waiter a moment to register on Notify.
        tokio::time::sleep(Duration::from_millis(20)).await;
        h.cancel();
        let cancelled =
            timeout(Duration::from_millis(200), waiter).await.unwrap().unwrap();
        assert!(cancelled);
    }

    #[tokio::test]
    async fn cancel_already_fired_is_immediate() {
        let h = CancelHandle::new();
        h.cancel();
        // `cancelled().await` must resolve right away — exercise the
        // is_cancelled() short-circuit in the loop.
        timeout(Duration::from_millis(20), h.cancelled())
            .await
            .expect("immediate resolve");
    }

    #[test]
    fn worker_concurrency_caps_at_hw_session_limit() {
        // 32-thread Threadripper with HW encoder → capped at 6.
        assert_eq!(worker_concurrency(32, true), 6);
        // 8-thread laptop with HW encoder → 4 (8/2).
        assert_eq!(worker_concurrency(8, true), 4);
        // 8-thread laptop without HW → 4 (the cap doesn't apply).
        assert_eq!(worker_concurrency(8, false), 4);
        // 32-thread without HW → 16. Pure CPU scaling.
        assert_eq!(worker_concurrency(32, false), 16);
        // Single-core hardware (unrealistic but defensive) → at least 1
        // worker, not 0.
        assert_eq!(worker_concurrency(1, false), 1);
        assert_eq!(worker_concurrency(1, true), 1);
    }
}
