/// Phase B.1 — fade-window opacity resolver.
///
/// Combines a layer's static `opacity` value with its `fade_in_us`
/// and `fade_out_us` window into an effective opacity at master
/// time `tUs`. Outside `[t_start_us, t_end_us]` the layer is fully
/// transparent — the lookahead window may have pre-mounted it but
/// it shouldn't be visible until its window opens.
///
/// The math is internally a `Keyframes<number>` (0 → static at
/// t_start..fade-in-end; static → 0 at fade-out-start..t_end) but
/// inlined as direct math here because the keyframe construction
/// would allocate on every tick. Once Phase 4 exposes
/// `Animated<f64>` over IPC, fade can move to keyframes proper.
///
/// "Crossfade" between two clips is two overlapping calls to this
/// function on neighboring layers — no separate transition path.

/// Layer-window inputs for fade resolution. Pulled out so this
/// function can be called with any layer kind that has these
/// fields (VideoClip, ImageOverlay; Color has a `color.a` alpha but
/// no fade today; Audio has gain rather than opacity).
export interface FadeWindow {
  tStartUs: number;
  tEndUs: number;
  fadeInUs: number;
  fadeOutUs: number;
  /// Layer's authored opacity (1.0 = fully visible). Fade ramps go
  /// from 0 to this value, not from 0 to 1.
  baseOpacity: number;
}

/// Resolve effective opacity at `tUs`. Returns 0 outside the window.
///
/// Clamps `fade_in_us + fade_out_us` against the layer's duration:
/// for very short layers the in + out windows can sum to more than
/// the duration, in which case both ramps run simultaneously and
/// the layer never reaches `baseOpacity`. We split the duration
/// proportionally so the peak meets at the middle (matching what
/// ffmpeg's `fade` filter does).
export function resolveFadeOpacity(win: FadeWindow, tUs: number): number {
  if (tUs < win.tStartUs || tUs >= win.tEndUs) return 0;

  const duration = Math.max(1, win.tEndUs - win.tStartUs);
  let fadeIn = Math.max(0, win.fadeInUs);
  let fadeOut = Math.max(0, win.fadeOutUs);

  // Overlap case: scale both windows so they share the duration
  // 50/50 (ffmpeg's behavior for over-long fade specs).
  if (fadeIn + fadeOut > duration) {
    const scale = duration / (fadeIn + fadeOut);
    fadeIn = Math.floor(fadeIn * scale);
    fadeOut = Math.floor(fadeOut * scale);
  }

  const elapsed = tUs - win.tStartUs;
  const remaining = win.tEndUs - tUs;

  let f = 1;
  if (fadeIn > 0 && elapsed < fadeIn) {
    f = elapsed / fadeIn;
  } else if (fadeOut > 0 && remaining < fadeOut) {
    f = remaining / fadeOut;
  }
  // Clamp defensively — float math can produce 1.000001 or -ε.
  if (f < 0) f = 0;
  else if (f > 1) f = 1;

  return win.baseOpacity * f;
}
