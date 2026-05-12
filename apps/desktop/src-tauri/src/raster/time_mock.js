// Phase 5 time-mock shim.
//
// Goal: turn the offscreen webview into a deterministic frame source.
// Real wall time is never observed by the template; instead the host calls
// `window.__seek(t_seconds)` between captures and the shim advances a fake
// clock, flushes pending rAF callbacks against it, awaits fonts, and waits
// one real frame so layout + compositor commit the visual update.
//
// MUST be injected before any template script runs (Tauri's
// `initialization_script` → WebView2's `AddScriptToExecuteOnDocumentCreated`).
// If the template captures a reference to the original APIs before this runs,
// it bypasses the shim.

(function () {
  let __t = 0;

  // Keep references to the originals — we need `_origRAF` to flush one real
  // frame after stepping the clock, so the compositor commits.
  const _origRAF = window.requestAnimationFrame.bind(window);
  const _origPerfNow = window.performance.now.bind(window.performance);

  // Override the time sources. Templates relying on `performance.now()` /
  // `Date.now()` / rAF for animation will now see frame-stepped time.
  // Performance is on Performance.prototype in some engines; fall back to
  // direct assignment if defineProperty fails.
  try {
    Object.defineProperty(window.performance, "now", {
      configurable: true,
      value: () => __t * 1000,
    });
  } catch (_) {
    window.performance.now = () => __t * 1000;
  }
  window.Date.now = () => __t * 1000;

  const rafCallbacks = new Set();
  window.requestAnimationFrame = (cb) => {
    rafCallbacks.add(cb);
    return 0; // ID isn't meaningful while time is paused.
  };
  window.cancelAnimationFrame = (id) => {
    // Best-effort; templates rarely care.
    void id;
  };

  // For declarative CSS / Web Animations, walk getAnimations() and pin each
  // animation's currentTime to __t. Done inside __seek so each step picks up
  // new animations the template may have created mid-render.
  function pinWebAnimations() {
    if (typeof document.getAnimations !== "function") return;
    const ms = __t * 1000;
    for (const a of document.getAnimations()) {
      try {
        a.pause();
        a.currentTime = ms;
      } catch (_) {
        // Some animations refuse to pause (e.g. infinite + already-finished
        // edge cases). Ignore — the template can implement __onSeek for
        // imperative control.
      }
    }
  }

  // Polling-based completion signal. WebView2's ExecuteScript returns the
  // serialized form of the script's last expression — if it's an unresolved
  // Promise we get `{}`, not the awaited value. So we expose:
  //   __seek_dispatch(t) → sequence number (sync return)
  //   __seek_status()    → { done: latest-completed-seq, latest: highest-dispatched }
  // and let the host poll. Cheap (each poll = one ExecuteScript), and works
  // identically on any platform we later wire up.
  let __seek_seq = 0;
  let __seek_done_seq = 0;

  async function __seek_impl(seconds) {
    __t = Number(seconds) || 0;

    // 1. Run any rAF callbacks queued before this seek with the new fake
    //    `performance.now()`. They may schedule more rAFs (a typical
    //    animation loop does); those land in the set for the next seek.
    const cbs = [...rafCallbacks];
    rafCallbacks.clear();
    for (const cb of cbs) {
      try {
        cb(__t * 1000);
      } catch (e) {
        // Don't let one bad callback abort the whole seek; surface the
        // problem to the host via console so the per-template error path
        // can pick it up.
        console.error("raster __seek rAF callback threw:", e);
      }
    }

    // 2. Catch declarative animations that don't use rAF.
    pinWebAnimations();

    // 3. Optional template hook for imperative timing (canvas/WebGL).
    if (typeof window.__onSeek === "function") {
      try {
        await window.__onSeek(__t);
      } catch (e) {
        console.error("raster __seek user hook threw:", e);
      }
    }

    // 4. Wait for fonts to be ready BEFORE the layout flush — otherwise a
    //    text-heavy template captures with system-fallback glyphs the first
    //    time and only stabilises on later seeks.
    if (document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch (_) {}
    }

    // 5. Flush one real frame so layout / compositor commit the changes
    //    we just queued. Without this the next capture may still show the
    //    pre-seek pixels on slow / offscreen compositors.
    await new Promise((resolve) => _origRAF(() => resolve(undefined)));
  }

  // Original async API — kept for templates that call it directly.
  window.__seek = async function __seek(seconds) {
    const seq = ++__seek_seq;
    await __seek_impl(seconds);
    __seek_done_seq = Math.max(__seek_done_seq, seq);
    return seq;
  };

  // Sync-return dispatch for hosts that can only ExecuteScript and poll.
  // Returns the sequence number to wait on; the actual async work runs in
  // the background and marks __seek_done_seq when it finishes.
  window.__seek_dispatch = function __seek_dispatch(seconds) {
    const seq = ++__seek_seq;
    __seek_impl(seconds).then(
      () => {
        __seek_done_seq = Math.max(__seek_done_seq, seq);
      },
      (e) => {
        // Surface the failure but still mark done so the host doesn't
        // poll forever; the next __seek_status will show a `pending`
        // count > 0 and the host can decide what to do.
        console.error("raster __seek_dispatch failed:", e);
        __seek_done_seq = Math.max(__seek_done_seq, seq);
      },
    );
    return seq;
  };

  window.__seek_status = function __seek_status() {
    return { done: __seek_done_seq, latest: __seek_seq };
  };

  // Expose a probe the host can call to confirm the shim took effect (used
  // by the spike + sanity test). Returns the current fake time in seconds.
  window.__raster_probe = function () {
    return { t: __t, real_now: _origPerfNow(), shim_now: window.performance.now() };
  };
})();
