//! weftcut-eval: the pure, dependency-light "WYSIWYG math" shared by the napi
//! crate's state/audio helpers and export (native build) and by the renderer +
//! TS actor (wasm32 build). No imbl / uuid / napi / tokio / serde / schemars in
//! the shipped artifact.
//! See docs/adr/0025-shared-eval-wasm-leaf-crate.md
//!
//! `no_std` ONLY on wasm32: the wasm `cdylib` is the only std-free artifact we
//! ship, and the wasm build (run on every task) is what enforces the "core/libm
//! only" discipline. Natively the crate links std and is consumed by the napi
//! crate purely as an `rlib`.
#![cfg_attr(target_arch = "wasm32", no_std)]

// On wasm32 the crate is no_std and links as a standalone cdylib, so it must
// supply its own panic handler. wasm32-unknown-unknown defaults to panic=abort,
// so no eh_personality is needed. Never compiled natively (std supplies one).
#[cfg(all(target_arch = "wasm32", not(test)))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

// Resident-ABI scalar exports for the renderer. wasm32 only (the native crate
// links the leaf as an rlib and calls the functions below directly).
#[cfg(target_arch = "wasm32")]
mod wasm;

// ===========================================================================
// Frame grid. Time is `i64` microseconds (the napi crate aliases `TimeUs = i64`
// and wraps these). Rates cross as the primitive pair `(num, den)`; `Rational`
// stays in the napi crate (`state/time.rs`). Only the i128 ALGORITHM is shared
// here — that is the value that must never drift across the renderer↔Rust
// boundary. Pure integer math; no std needed. Callers pass a valid rate
// (den/num != 0); degenerate-fps guards live in the wrappers (TS
// `renderer/frames.ts`).
//
// Two orthogonal policies, deliberately split into separate functions: an INDEX
// policy (`frame_index_floor` / `_round` / `_ceil`) picks *which* frame, and the
// single OUTPUT policy (`time_us_at_frame`) turns an index into µs. The `snap_*`
// functions are just the compositions. See `docs/data-model.md` — Timeline-field
// alignment.
// ===========================================================================

pub const US_PER_SEC: i64 = 1_000_000;
pub const US_PER_MS: i64 = 1_000;

/// Canonical µs of frame `frame` on the `num/den` grid: half-up
/// `round(frame * US_PER_SEC * den / num)`.
///
/// THE output policy — a grid time is canonical iff it came from here, and there
/// is no truncating variant. Half-up (not truncation) because it matches the
/// demuxer's source-PTS rounding — the integer µs mediabunny mints per packet,
/// which decode carries verbatim (`render/decoder/decodeClock.ts`) — so a
/// composition frame and the source frame it displays agree on the same
/// integer µs.
///
/// LANDMINE: this expression is golden-pinned through `snap_frame_round`
/// (`src/renderer/snapFrameGolden.fixture.json`, asserted from both languages).
/// `+ num / 2` IS exact half-up for odd `num` as well as even — the floor of the
/// halved divisor cannot cross a tie, since an odd divisor has no exact tie.
pub fn time_us_at_frame(frame: i64, num: u32, den: u32) -> i64 {
    let num = num as i128;
    let numer = (frame as i128) * (US_PER_SEC as i128) * (den as i128);
    (numer + num / 2).div_euclid(num) as i64
}

/// Index of the frame `t_us` falls in: the largest `i` with
/// `time_us_at_frame(i) <= t_us`.
///
/// Resolved against the CANONICAL grid, not the exact rational one. The two
/// disagree by up to 1 µs, and pairing an exact-rational index with the half-up
/// output would not be idempotent — re-flooring a canonical value that rounded
/// DOWN below its exact boundary drops a whole frame. The exact quotient only
/// seeds the search; the corrections settle in at most one step each way.
pub fn frame_index_floor(t_us: i64, num: u32, den: u32) -> i64 {
    let prod = (t_us as i128) * (num as i128);
    let div = (US_PER_SEC as i128) * (den as i128);
    let mut i = prod.div_euclid(div) as i64;
    while time_us_at_frame(i + 1, num, den) <= t_us {
        i += 1;
    }
    while time_us_at_frame(i, num, den) > t_us {
        i -= 1;
    }
    i
}

/// Index of the frame boundary NEAREST `t_us` (half-up: an exact half-frame
/// picks the later frame). Resolved on the exact rational grid — unlike
/// floor/ceil there is no idempotence pressure (a canonical value is always
/// nearest to its own index), and this is the expression the golden fixture
/// pins through `snap_frame_round`.
pub fn frame_index_round(t_us: i64, num: u32, den: u32) -> i64 {
    let prod = (t_us as i128) * (num as i128);
    let div = (US_PER_SEC as i128) * (den as i128);
    (prod + div / 2).div_euclid(div) as i64
}

/// Index of the first frame at or after `t_us`: the smallest `i` with
/// `time_us_at_frame(i) >= t_us`. Canonical-grid, mirroring
/// `frame_index_floor`.
pub fn frame_index_ceil(t_us: i64, num: u32, den: u32) -> i64 {
    let i = frame_index_floor(t_us, num, den);
    if time_us_at_frame(i, num, den) < t_us {
        i + 1
    } else {
        i
    }
}

/// Frames of the `num/den` grid inside the half-open range
/// `[start_us, end_us)`: the count of `i >= 0` with
/// `start_us + time_us_at_frame(i) < end_us`.
///
/// The count MUST come from the same predicate as the times it counts, or the
/// tail disagrees: a `ceil(span / frame_dur)` estimate over-counts the full
/// composition and a `round` one drops or adds a trailing frame on an arbitrary
/// `end_us`. The export worker reads this as its output-frame total
/// (`render/worker/frameGrid.ts`).
pub fn frame_count(start_us: i64, end_us: i64, num: u32, den: u32) -> i64 {
    let span = end_us - start_us;
    if span <= 0 {
        return 0;
    }
    let prod = (span as i128) * (num as i128);
    let div = (US_PER_SEC as i128) * (den as i128);
    let mut n = prod.div_euclid(div) as i64;
    while n > 0 && time_us_at_frame(n - 1, num, den) >= span {
        n -= 1;
    }
    while time_us_at_frame(n, num, den) < span {
        n += 1;
    }
    n
}

/// Snap `t_us` DOWN to the canonical start of the frame containing it.
pub fn snap_frame_floor(t_us: i64, num: u32, den: u32) -> i64 {
    time_us_at_frame(frame_index_floor(t_us, num, den), num, den)
}

/// Snap `t_us` UP to the canonical start of the next frame (identity when
/// `t_us` is already canonical).
pub fn snap_frame_ceil(t_us: i64, num: u32, den: u32) -> i64 {
    time_us_at_frame(frame_index_ceil(t_us, num, den), num, den)
}

/// Round `t_us` to the NEAREST `num/den`-fps frame boundary (half-up).
///
/// Use this for round-to-nearest snap of timeline mutations (move, trim, split,
/// seek). Floor/ceil exist for the rare cases where asymmetric snap is needed.
///
/// LANDMINE — the half-up OUTPUT (`time_us_at_frame`, not truncation) is what
/// keeps a moved layer painting the right source frame: at frame indices where
/// `N * 1_000_000 * den / num` has fractional > 0.5 (e.g. frames 2, 5, 8 at
/// 30 fps) a truncating output stores `src_in_us` 1 µs below the demuxer's
/// source PTS for that frame, so `FrameRing.frameAt` falls into source frame
/// N−1. At the un-moved position the error is masked (the `t_start_us`
/// truncation gap cancels it in `layerLocalUs`); it surfaces the moment the
/// layer moves to a destination with no such gap.
///
/// TWIN: `renderer/frames.ts::snapFrameRound` re-exports this through wasm, and
/// `snapFrameGolden.fixture.json` is asserted from both languages. An
/// intentional math change means recomputing the fixture in the same turn.
pub fn snap_frame_round(t_us: i64, num: u32, den: u32) -> i64 {
    time_us_at_frame(frame_index_round(t_us, num, den), num, den)
}

/// µs → AUDIO sample-frame index at `rate` Hz, round half-up. NOT a member of
/// the video frame grid above: `rate` is an integer Hz, not a rational fps, and
/// the frames-per-µs ratio (48 000 / 1 000 000 = 48/1000 at 48 kHz) is exact on
/// the grid, so it needs no separate output policy. Do not overload it with video
/// frame indices. `i128` internally so hour-plus timelines don't overflow. Shared
/// by the export mixer (`audio/mix.rs`) and the renderer's preview scheduler
/// (`render/audio/chunkSchedule.ts`) so both place audio on one frame grid.
pub fn us_to_frame(us: i64, rate: u32) -> i64 {
    let prod = (us as i128) * (rate as i128);
    let frame = (prod + (US_PER_SEC as i128) / 2).div_euclid(US_PER_SEC as i128);
    frame as i64
}

// ===========================================================================
// Keyframe evaluation. `Interpolation` + `unit_bezier` + the slice-form
// evaluator `eval_f64` are shared with the renderer (wasm) so preview, export,
// and the actor all interpolate identically.
// ===========================================================================

/// Keyframe interpolation. Segment `[kf[i], kf[i+1])` is governed by
/// `kf[i].interp`: Hold holds the left value; Linear/EaseIn/EaseOut/Bezier
/// interpolate via `unit_bezier`. `Default = Linear`. The serde wire shape
/// (`{kind: ...}`) is gated on the `serde` feature.
#[derive(Clone, Copy, Debug, PartialEq, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "kind"))]
pub enum Interpolation {
    Hold,
    #[default]
    Linear,
    EaseIn,
    EaseOut,
    Bezier {
        p1: (f64, f64),
        p2: (f64, f64),
    },
}

/// Two-endpoint blend at eased progress `u` ∈ [0,1]. `u` is ALREADY remapped
/// by the segment's `Interpolation` before lerp sees it, so easing stays
/// orthogonal to the value type. (Spatial motion paths are NOT this trait —
/// they need the whole keyframe sequence; a separate future layer.)
pub trait Interpolate: Copy {
    fn lerp(a: Self, b: Self, u: f64) -> Self;
}
impl Interpolate for f64 {
    #[inline]
    fn lerp(a: f64, b: f64, u: f64) -> f64 {
        a + (b - a) * u
    }
}

// ===========================================================================
// Color (`Rgba8`) interpolation in OkLab + premultiplied alpha.
//
// This is a LEAF-LOCAL color type ON PURPOSE: the wasm preview build (the only
// std-free shipped artifact) compiles this crate as a cdylib and does NOT depend
// on the napi crate, so `eval::<Rgba8>` can only monomorphize in wasm if the
// color type, its `Interpolate` impl, AND the OkLab math all live here. The napi
// `Rgba` storage/wire type stays in `native/src/state/color.rs` and converts to
// this via `Rgba::to_eval` / `Rgba::from_eval` (a plain method pair, not `From`,
// to dodge the orphan rule). Keep this type dependency-light — NO serde, NO
// schemars.
//
// All math is f64 and uses `libm::pow` / `libm::cbrt` (NEVER `f64::powf` /
// `f64::cbrt` — std is unavailable in the no_std wasm build AND would break
// native↔wasm bit-identity, same rule as `db_to_linear`). `x^3` is `x*x*x`.
// OkLab matrices are Björn Ottosson's reference; the premultiplied lerp follows
// CSS Color 4 §12.3.
// ===========================================================================

/// 8-bit-per-channel sRGB color, the value type for color keyframes. Plain POD
/// (`Copy`), no serde/schemars — the napi `Rgba` is the storage/wire type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgba8 {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

/// u8 channel → f64 in [0,1].
#[inline]
fn u8_to_f(c: u8) -> f64 {
    c as f64 / 255.0
}

/// f64 → u8: round half-up, clamp. Pure arithmetic so it is deterministic
/// across native + wasm (no `f64::round`, which is std-only).
#[inline]
fn f_to_u8(c: f64) -> u8 {
    (c.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

#[inline]
fn srgb_to_linear(c: f64) -> f64 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        libm::pow((c + 0.055) / 1.055, 2.4)
    }
}

#[inline]
fn linear_to_srgb(c: f64) -> f64 {
    if c <= 0.0031308 {
        12.92 * c
    } else {
        1.055 * libm::pow(c, 1.0 / 2.4) - 0.055
    }
}

/// linear sRGB → OkLab (Björn Ottosson reference matrices).
fn linear_to_oklab(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    let l_ = libm::cbrt(l);
    let m_ = libm::cbrt(m);
    let s_ = libm::cbrt(s);
    (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )
}

/// OkLab → linear sRGB (inverse of `linear_to_oklab`).
fn oklab_to_linear(ll: f64, aa: f64, bb: f64) -> (f64, f64, f64) {
    let l_ = ll + 0.3963377774 * aa + 0.2158037573 * bb;
    let m_ = ll - 0.1055613458 * aa - 0.0638541728 * bb;
    let s_ = ll - 0.0894841775 * aa - 1.2914855480 * bb;
    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;
    (
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    )
}

impl Interpolate for Rgba8 {
    /// Premultiplied-alpha OkLab interpolation (CSS Color 4 §12.3).
    /// Premultiplication is why a fade to transparent keeps its hue instead of
    /// darkening toward black. `u==0.0` returns `a` and `u==1.0` returns `b`
    /// exactly (the scalar lerp gives this).
    fn lerp(a: Rgba8, b: Rgba8, u: f64) -> Rgba8 {
        // Endpoint → (L,a,b) in OkLab + alpha in [0,1].
        let to_lab = |c: Rgba8| -> (f64, f64, f64, f64) {
            let (lr, lg, lb) = (
                srgb_to_linear(u8_to_f(c.r)),
                srgb_to_linear(u8_to_f(c.g)),
                srgb_to_linear(u8_to_f(c.b)),
            );
            let (ll, aa, bb) = linear_to_oklab(lr, lg, lb);
            (ll, aa, bb, u8_to_f(c.a))
        };
        let (al, aa, ab, aalpha) = to_lab(a);
        let (bl, ba, bb, balpha) = to_lab(b);

        // Premultiply (L,a,b) by alpha.
        let (apl, apa, apb) = (al * aalpha, aa * aalpha, ab * aalpha);
        let (bpl, bpa, bpb) = (bl * balpha, ba * balpha, bb * balpha);

        // Scalar lerp the premultiplied components + alpha.
        let lerp = |x: f64, y: f64| x + (y - x) * u;
        let pl = lerp(apl, bpl);
        let pa = lerp(apa, bpa);
        let pb = lerp(apb, bpb);
        let ar = lerp(aalpha, balpha);

        // Un-premultiply by the result alpha (zero alpha → zero color).
        let (ll, oa, ob) = if ar > 0.0 {
            (pl / ar, pa / ar, pb / ar)
        } else {
            (0.0, 0.0, 0.0)
        };

        let (lr, lg, lb) = oklab_to_linear(ll, oa, ob);
        Rgba8 {
            r: f_to_u8(linear_to_srgb(lr)),
            g: f_to_u8(linear_to_srgb(lg)),
            b: f_to_u8(linear_to_srgb(lb)),
            a: f_to_u8(ar),
        }
    }
}

/// POD keyframe — the input to `eval_f64`. The actor's imbl-backed
/// `Keyframe<T>` collects into a `&[Kf]` before evaluating (`eval_kfs`).
/// `Copy` so the wasm shim can stage a fixed-size `[Kf; N]` buffer.
/// Default type param `T = f64` so existing `Kf`, `[Kf; N]`, `Vec<Kf>` sites
/// keep meaning `Kf<f64>` without any edits.
#[derive(Clone, Copy, Debug)]
pub struct Kf<T = f64> {
    pub t_us: i64,
    pub value: T,
    pub interp: Interpolation,
}

/// `f64::abs` is std-only; the wasm (no_std) build needs a core-only abs.
#[inline]
fn fabs(x: f64) -> f64 {
    if x < 0.0 {
        -x
    } else {
        x
    }
}

/// Evaluate a `cubic-bezier(x1,y1,x2,y2)` timing function at normalized
/// progress `x` ∈ [0,1]. Control points are (0,0),(x1,y1),(x2,y2),(1,1):
/// solve `X(s)=x` for the Bézier parameter `s` (Newton-Raphson, ≤8 iters,
/// bisection fallback), then return `Y(s)`. `x1,x2` are assumed in [0,1]
/// (enforced at authoring) so `X` is monotone and the solve single-valued.
///
/// CANONICAL WebKit UnitBezier: the renderer's keyframe eval calls this via
/// wasm, the actor/export call it natively. One JS copy survives in
/// `render/animated.ts::unitBezier` for the curve-graph editor overlay only —
/// keep that copy in sync if you change this, and reflect any change in the
/// animated golden fixture.
pub fn unit_bezier(x1: f64, y1: f64, x2: f64, y2: f64, x: f64) -> f64 {
    const EPS: f64 = 1e-7;
    // Bézier → power-basis coefficients.
    let cx = 3.0 * x1;
    let bx = 3.0 * (x2 - x1) - cx;
    let ax = 1.0 - cx - bx;
    let cy = 3.0 * y1;
    let by = 3.0 * (y2 - y1) - cy;
    let ay = 1.0 - cy - by;
    let sample_x = |t: f64| ((ax * t + bx) * t + cx) * t;
    let sample_y = |t: f64| ((ay * t + by) * t + cy) * t;
    let sample_dx = |t: f64| (3.0 * ax * t + 2.0 * bx) * t + cx;

    // Newton-Raphson.
    let mut t = x;
    for _ in 0..8 {
        let xt = sample_x(t) - x;
        if fabs(xt) < EPS {
            return sample_y(t);
        }
        let d = sample_dx(t);
        if fabs(d) < 1e-6 {
            break;
        }
        t -= xt / d;
    }
    // Bisection fallback.
    let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
    t = x;
    if t < lo {
        return sample_y(lo);
    }
    if t > hi {
        return sample_y(hi);
    }
    while lo < hi {
        let xt = sample_x(t);
        if fabs(xt - x) < EPS {
            return sample_y(t);
        }
        if x > xt {
            lo = t;
        } else {
            hi = t;
        }
        t = (hi - lo) * 0.5 + lo;
    }
    sample_y(t)
}

/// Generic slice-form keyframe evaluator. Empty slice ⇒ `default`; `t_us`
/// before-first/after-last clamps to the end key. Segment interpolation follows
/// [`Interpolation`]. PRECONDITION: keyframes sorted by `t_us` (the actor stores
/// them normalized). `render/animated.ts::resolveAnimated` calls this through
/// wasm. The only type-specific operation is `T::lerp` at the very tail; all
/// segment search, clamp, and easing logic is shared across value types.
pub fn eval<T: Interpolate>(kfs: &[Kf<T>], t_us: i64, default: T) -> T {
    if kfs.is_empty() {
        return default;
    }
    if kfs.len() == 1 {
        return kfs[0].value;
    }
    let first = &kfs[0];
    let last = &kfs[kfs.len() - 1];
    if t_us <= first.t_us {
        return first.value;
    }
    if t_us >= last.t_us {
        return last.value;
    }
    let mut i = 0;
    while i < kfs.len() - 1 && kfs[i + 1].t_us <= t_us {
        i += 1;
    }
    let a = &kfs[i];
    let b = &kfs[i + 1];
    let span = (b.t_us - a.t_us) as f64;
    if span <= 0.0 {
        return b.value;
    }
    let mut u = (t_us - a.t_us) as f64 / span;
    match a.interp {
        Interpolation::Hold => return a.value,
        Interpolation::Linear => {}
        Interpolation::EaseIn => u = unit_bezier(0.42, 0.0, 1.0, 1.0, u),
        Interpolation::EaseOut => u = unit_bezier(0.0, 0.0, 0.58, 1.0, u),
        Interpolation::Bezier { p1, p2 } => u = unit_bezier(p1.0, p1.1, p2.0, p2.1, u),
    }
    T::lerp(a.value, b.value, u)
}

/// Thin wrapper — KEEP this exact public signature (audio envelope sampler
/// calls it directly).
pub fn eval_f64(kfs: &[Kf<f64>], t_us: i64, default: f64) -> f64 {
    eval(kfs, t_us, default)
}

// ===========================================================================
// Audio: dB→linear gain + role mute/solo gate. Primitive-typed — `RoleMixSettings`
// stays in the napi crate (`state/audio_role.rs`); the mix.rs wrappers pass its
// fields here. Shared with the renderer's audio-preview gating (wasm).
// ===========================================================================

/// Linear gain for a dB value: `10^(db/20)`. `f32` to match `Envelope::scale`.
/// `libm::pow` (not `f64::powf`) so native + wasm compute bit-identically.
pub fn db_to_linear(db: f64) -> f32 {
    libm::pow(10.0, db / 20.0) as f32
}

/// True iff any role in the table is soloed (pass each role's `solo` flag).
/// An empty iterator answers `false` correctly.
pub fn any_role_solo(solos: impl IntoIterator<Item = bool>) -> bool {
    solos.into_iter().any(|s| s)
}

/// A role is audible unless muted, or a solo set exists and it isn't soloed —
/// mute wins over solo.
pub fn role_audible(muted: bool, solo: bool, any_solo: bool) -> bool {
    if muted {
        return false;
    }
    if any_solo && !solo {
        return false;
    }
    true
}

/// Linear gain for a role's `gain_db` (v1 has no per-role DSP).
pub fn role_gain_linear(gain_db: f64) -> f32 {
    db_to_linear(gain_db)
}

/// Equal-power pan law as a 2×2 mix matrix `[a, b, c, d]`, applied as
/// `out_l = a·l + b·r`, `out_r = c·l + d·r`. Branch-matched to Chromium's
/// `StereoPannerNode` (`third_party/blink/.../stereo_panner.cc`) so the matrix
/// reproduces WebAudio's pan exactly. `channels <= 1` (mono) routes the single input
/// through the `l` slot: `[cos, 0, sin, 0]`. `libm` trig in f64→f32 so native +
/// wasm agree bit-for-bit (see `db_to_linear`). Shared by the export mixer
/// (`audio/mix.rs`) and the renderer's preview matrix mixer (`render/audio/
/// panGraph.ts`, via the wasm `pan_coeff` shim).
///
/// mono:          x=(pan+1)/2; a=cos(xπ/2), c=sin(xπ/2), b=d=0
/// stereo pan≤0:  x=pan+1;     a=1, b=cos(xπ/2), c=0, d=sin(xπ/2)
/// stereo pan>0:  x=pan;       a=cos(xπ/2), b=0, c=sin(xπ/2), d=1
pub fn pan_coeffs(pan: f64, channels: i32) -> [f32; 4] {
    let p = pan.clamp(-1.0, 1.0);
    let fp2 = core::f64::consts::FRAC_PI_2;
    // Cast f64→f32 and clamp any rounding residue at the trig-exact zeros
    // (libm::cos(π/2) ≈ 6.12e-17 in f64; as f32 that is non-zero, breaking the
    // exact-boundary assertions and diverging from the StereoPannerNode spec).
    let zf = |v: f32| if v.abs() < 1e-7 { 0.0 } else { v };
    let cs = |x: f64| (zf(libm::cos(x * fp2) as f32), zf(libm::sin(x * fp2) as f32));
    if channels <= 1 {
        let (c, s) = cs((p + 1.0) / 2.0);
        [c, 0.0, s, 0.0]
    } else if p <= 0.0 {
        let (c, s) = cs(p + 1.0);
        [1.0, c, 0.0, s]
    } else {
        let (c, s) = cs(p);
        [c, 0.0, s, 1.0]
    }
}

/// Fade multiplier at layer-local `t_us`: linear 0→1 over `fade_in_us` from the
/// layer start, 1→0 over `fade_out_us` into the layer end, multiplied where they
/// overlap. Zero-length fades are identity. Shared by the export mixer and the
/// renderer's gain sampler (wasm `fade_mul`).
pub fn fade_multiplier(t_us: i64, span_us: i64, fade_in_us: i64, fade_out_us: i64) -> f64 {
    let mut m = 1.0f64;
    if fade_in_us > 0 && t_us < fade_in_us {
        m *= (t_us.max(0) as f64) / fade_in_us as f64;
    }
    if fade_out_us > 0 {
        let from_end = span_us - t_us;
        if from_end < fade_out_us {
            m *= (from_end.max(0) as f64) / fade_out_us as f64;
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- audio: equal-power pan law ----
    #[test]
    fn pan_coeffs_branches() {
        // stereo center (pan<=0 branch, x=1): cos(pi/2)=0, sin(pi/2)=1 -> identity
        assert_eq!(pan_coeffs(0.0, 2), [1.0, 0.0, 0.0, 1.0]);
        // stereo hard-left (x=0): cos(0)=1, sin(0)=0 -> L=l+r, R=0
        assert_eq!(pan_coeffs(-1.0, 2), [1.0, 1.0, 0.0, 0.0]);
        // stereo hard-right (pan>0, x=1): L=0, R=l+r
        assert_eq!(pan_coeffs(1.0, 2), [0.0, 0.0, 1.0, 1.0]);
        // mono center (x=0.5): cos(pi/4)=sin(pi/4)=0.70710677
        let m = pan_coeffs(0.0, 1);
        assert!((m[0] - 0.70710677).abs() < 1e-6 && m[1] == 0.0);
        assert!((m[2] - 0.70710677).abs() < 1e-6 && m[3] == 0.0);
        // clamp out-of-range
        assert_eq!(pan_coeffs(-5.0, 2), pan_coeffs(-1.0, 2));
    }

    /// Cross-language golden for the pan law. The SAME fixture is asserted by
    /// `render/audio/panLaw.golden.test.ts` against the wasm `pan_coeff` shim; a
    /// value passing one side and failing the other is pan-law drift. Also the
    /// native↔wasm `libm::cos/sin` determinism proof.
    #[test]
    fn pan_law_golden_matches_fixture() {
        #[derive(serde::Deserialize)]
        struct Coeff {
            name: String,
            pan: f64,
            channels: i32,
            expect: [f32; 4],
        }
        #[derive(serde::Deserialize)]
        struct Apply {
            name: String,
            pan: f64,
            channels: i32,
            r#in: [f32; 2],
            expect: [f32; 2],
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            coeff_cases: Vec<Coeff>,
            apply_cases: Vec<Apply>,
        }

        let f: Fixture = serde_json::from_str(include_str!(
            "../../../src/renderer/render/audio/panLawGolden.fixture.json"
        ))
        .expect("pan law fixture parses");
        for c in &f.coeff_cases {
            let got = pan_coeffs(c.pan, c.channels);
            for i in 0..4 {
                assert!(
                    (got[i] - c.expect[i]).abs() < 1e-5,
                    "coeff `{}` idx {i}: got {}, expect {}",
                    c.name,
                    got[i],
                    c.expect[i]
                );
            }
        }
        for a in &f.apply_cases {
            let [ka, kb, kc, kd] = pan_coeffs(a.pan, a.channels);
            let (l, r) = (a.r#in[0], a.r#in[1]);
            let out = [ka * l + kb * r, kc * l + kd * r];
            for i in 0..2 {
                assert!(
                    (out[i] - a.expect[i]).abs() < 1e-5,
                    "apply `{}` ch {i}: got {}, expect {}",
                    a.name,
                    out[i],
                    a.expect[i]
                );
            }
        }
    }

    // ---- audio: db_to_linear + role gate ----
    #[test]
    fn db_to_linear_unity_double_and_tenth() {
        assert!((db_to_linear(0.0) - 1.0).abs() < 1e-9);
        assert!((db_to_linear(6.0206) - 2.0).abs() < 1e-4);
        assert!((db_to_linear(-20.0) - 0.1).abs() < 1e-6);
    }

    #[test]
    fn role_gate_mute_wins_and_solo_gates() {
        assert!(!role_audible(true, true, true)); // mute wins over solo
        assert!(!role_audible(false, false, true)); // solo set exists, not soloed
        assert!(role_audible(false, true, true)); // soloed
        assert!(role_audible(false, false, false)); // no solo set, unmuted
    }

    #[test]
    fn any_role_solo_detects_a_soloed_role() {
        assert!(any_role_solo([false, true, false]));
        assert!(!any_role_solo([false, false]));
        assert!(!any_role_solo(core::iter::empty::<bool>()));
    }

    // ---- audio: fade ramp ----
    #[test]
    fn fade_multiplier_ramps() {
        // no fades -> identity
        assert_eq!(fade_multiplier(500_000, 1_000_000, 0, 0), 1.0);
        // 1 s fade-in over a 10 s span
        assert!((fade_multiplier(0, 10_000_000, 1_000_000, 0) - 0.0).abs() < 1e-9);
        assert!((fade_multiplier(500_000, 10_000_000, 1_000_000, 0) - 0.5).abs() < 1e-9);
        assert!((fade_multiplier(1_000_000, 10_000_000, 1_000_000, 0) - 1.0).abs() < 1e-9);
        // 1 s fade-out ramps to 0 at the end
        assert!((fade_multiplier(9_500_000, 10_000_000, 0, 1_000_000) - 0.5).abs() < 1e-9);
        assert!((fade_multiplier(10_000_000, 10_000_000, 0, 1_000_000) - 0.0).abs() < 1e-9);
    }

    // ---- audio sample-frame conversion (us_to_frame) ----
    #[test]
    fn us_to_frame_48k_grid() {
        assert_eq!(us_to_frame(0, 48_000), 0);
        assert_eq!(us_to_frame(1_000_000, 48_000), 48_000); // 1 s
        assert_eq!(us_to_frame(20_833, 48_000), 1_000); // 20833.33 µs ≈ frame 1000
    }

    /// The conversion reduces to `(us*48 + 500)/1000` (the inlined form it
    /// replaced in `audio/mix.rs` + `chunkSchedule.ts`). Assert against it across
    /// a range incl. negatives — the preview playhead can sit before a layer's
    /// start, so `us` (composition µs − layer start) is sometimes negative.
    #[test]
    fn us_to_frame_matches_reduced_form() {
        for us in [
            -3_600_000_000_i64,
            -20_833,
            -1,
            0,
            1,
            17,
            20_833,
            1_000_000,
            3_600_000_000,
        ] {
            let reduced = (us * 48 + 500).div_euclid(1000);
            assert_eq!(us_to_frame(us, 48_000), reduced, "us={us}");
        }
    }

    // ---- keyframe eval (eval_f64) ----
    fn kf(t_us: i64, value: f64, interp: Interpolation) -> Kf {
        Kf {
            t_us,
            value,
            interp,
        }
    }

    #[test]
    fn eval_empty_returns_default() {
        assert!((eval_f64(&[], 0, 4.2) - 4.2).abs() < 1e-9);
    }

    #[test]
    fn eval_single_returns_value() {
        let kfs = [kf(0, 3.0, Interpolation::Linear)];
        assert!((eval_f64(&kfs, 100_000, 0.0) - 3.0).abs() < 1e-9);
    }

    #[test]
    fn eval_clamps_before_first_and_after_last() {
        let kfs = [
            kf(5_000_000, 2.0, Interpolation::Linear),
            kf(10_000_000, 8.0, Interpolation::Linear),
        ];
        assert!((eval_f64(&kfs, 0, 0.0) - 2.0).abs() < 1e-9);
        assert!((eval_f64(&kfs, 15_000_000, 0.0) - 8.0).abs() < 1e-9);
    }

    #[test]
    fn eval_linear_midpoint() {
        let kfs = [
            kf(0, 0.0, Interpolation::Linear),
            kf(10_000_000, 10.0, Interpolation::Linear),
        ];
        assert!((eval_f64(&kfs, 5_000_000, 0.0) - 5.0).abs() < 1e-6);
    }

    #[test]
    fn eval_hold_sticks_left() {
        let kfs = [
            kf(0, 3.0, Interpolation::Hold),
            kf(10_000_000, 8.0, Interpolation::Hold),
        ];
        assert!((eval_f64(&kfs, 5_000_000, 0.0) - 3.0).abs() < 1e-9);
    }

    #[test]
    fn eval_ease_in_matches_unit_bezier() {
        let kfs = [
            kf(0, 0.0, Interpolation::EaseIn),
            kf(10_000_000, 10.0, Interpolation::EaseIn),
        ];
        let expected = unit_bezier(0.42, 0.0, 1.0, 1.0, 0.5) * 10.0;
        assert!((eval_f64(&kfs, 5_000_000, 0.0) - expected).abs() < 1e-9);
    }

    // ---- color: Rgba8 OkLab + premultiplied-alpha lerp ----
    // Structural / endpoint / gamma-sanity only — exact OkLab golden values
    // are not pinned here.

    #[test]
    fn rgba8_lerp_endpoints_return_inputs() {
        let pairs = [
            (
                Rgba8 {
                    r: 255,
                    g: 0,
                    b: 0,
                    a: 255,
                },
                Rgba8 {
                    r: 0,
                    g: 255,
                    b: 0,
                    a: 255,
                },
            ),
            (
                Rgba8 {
                    r: 12,
                    g: 34,
                    b: 56,
                    a: 200,
                },
                Rgba8 {
                    r: 200,
                    g: 100,
                    b: 50,
                    a: 80,
                },
            ),
        ];
        for (a, b) in pairs {
            assert_eq!(Rgba8::lerp(a, b, 0.0), a, "u=0 must return a exactly");
            assert_eq!(Rgba8::lerp(a, b, 1.0), b, "u=1 must return b exactly");
        }
    }

    #[test]
    fn rgba8_lerp_red_to_green_midpoint_is_brighter_than_naive() {
        // OkLab (perceptual) interpolation of opaque red → green keeps luminance
        // up: both channels exceed the naive sRGB midpoint of 127/128. (A naive
        // per-channel sRGB lerp would yield r≈g≈127.)
        let red = Rgba8 {
            r: 255,
            g: 0,
            b: 0,
            a: 255,
        };
        let green = Rgba8 {
            r: 0,
            g: 255,
            b: 0,
            a: 255,
        };
        let mid = Rgba8::lerp(red, green, 0.5);
        assert!(mid.r > 128, "r={} should exceed naive sRGB midpoint", mid.r);
        assert!(mid.g > 128, "g={} should exceed naive sRGB midpoint", mid.g);
        assert_eq!(mid.a, 255, "opaque endpoints stay opaque");
    }

    #[test]
    fn rgba8_lerp_fade_to_transparent_keeps_hue() {
        // Premultiplied alpha: opaque red → transparent black at the midpoint
        // stays clearly red (no black-halo darkening), with alpha ~128.
        let red = Rgba8 {
            r: 255,
            g: 0,
            b: 0,
            a: 255,
        };
        let clear = Rgba8 {
            r: 0,
            g: 0,
            b: 0,
            a: 0,
        };
        let mid = Rgba8::lerp(red, clear, 0.5);
        assert!(
            mid.r > 100 && mid.g < 40 && mid.b < 40,
            "expected red-dominant hue, got {mid:?}"
        );
        assert!(
            (mid.a as i32 - 128).abs() <= 1,
            "alpha should be ~128, got {}",
            mid.a
        );
    }

    #[test]
    fn rgba8_lerp_equal_alpha_gray_midpoint_is_between() {
        // Equal opaque alpha reduces to a plain OkLab lerp; the gray midpoint
        // sits between the two endpoints and stays neutral (r≈g≈b).
        let dark = Rgba8 {
            r: 64,
            g: 64,
            b: 64,
            a: 255,
        };
        let light = Rgba8 {
            r: 192,
            g: 192,
            b: 192,
            a: 255,
        };
        let mid = Rgba8::lerp(dark, light, 0.5);
        assert!(mid.r > 64 && mid.r < 192, "r={} between endpoints", mid.r);
        let max = mid.r.max(mid.g).max(mid.b);
        let min = mid.r.min(mid.g).min(mid.b);
        assert!(max - min <= 1, "gray stays neutral, got {mid:?}");
        assert_eq!(mid.a, 255);
    }

    // ---- frame grid ----
    // 30 fps = (30, 1); 29.97 fps = (30_000, 1001). At 30 fps the canonical
    // boundaries are 0, 33_333, 66_667, 100_000, … — half-up, so consecutive
    // integer-µs widths alternate 33_333/33_334 and NO pre-rounded frame
    // duration reproduces them.

    /// The rate matrix every grid property below is checked against: the four
    /// broadcast fractional rates and their integer twins.
    const RATES: [(u32, u32); 8] = [
        (24_000, 1001),
        (24, 1),
        (25, 1),
        (30_000, 1001),
        (30, 1),
        (50, 1),
        (60_000, 1001),
        (60, 1),
    ];

    const US_24H: i64 = 86_400_000_000;

    #[test]
    fn time_us_at_frame_is_half_up() {
        assert_eq!(time_us_at_frame(0, 30, 1), 0);
        assert_eq!(time_us_at_frame(1, 30, 1), 33_333); // 33_333.333 → down
        assert_eq!(time_us_at_frame(2, 30, 1), 66_667); // 66_666.667 → up
        assert_eq!(time_us_at_frame(3, 30, 1), 100_000);
        assert_eq!(time_us_at_frame(1, 30_000, 1001), 33_367); // 33_366.667 → up
        assert_eq!(time_us_at_frame(2, 30_000, 1001), 66_733); // 66_733.333 → down
    }

    #[test]
    fn frame_index_policies_split_the_canonical_cell() {
        // Frame 1 at 30 fps starts at canonical 33_333. 33_332 is still frame 0
        // for floor, already frame 1 for ceil, and frame 1 for round (past the
        // 16_667 half-frame).
        assert_eq!(frame_index_floor(33_332, 30, 1), 0);
        assert_eq!(frame_index_ceil(33_332, 30, 1), 1);
        assert_eq!(frame_index_round(33_332, 30, 1), 1);
        // Exactly on the canonical boundary all three agree.
        for f in [
            frame_index_floor(33_333, 30, 1),
            frame_index_round(33_333, 30, 1),
            frame_index_ceil(33_333, 30, 1),
        ] {
            assert_eq!(f, 1);
        }
        // Half-frame rounds UP; one µs below it does not.
        assert_eq!(frame_index_round(16_666, 30, 1), 0);
        assert_eq!(frame_index_round(16_667, 30, 1), 1);
    }

    #[test]
    fn snap_floor_lands_on_the_canonical_start_of_its_own_cell() {
        assert_eq!(snap_frame_floor(0, 30, 1), 0);
        assert_eq!(snap_frame_floor(33_332, 30, 1), 0);
        assert_eq!(snap_frame_floor(33_333, 30, 1), 33_333);
        assert_eq!(snap_frame_floor(33_334, 30, 1), 33_333);
        // Frame 2's canonical start rounds UP from 66_666.667; a truncating
        // output policy returned 66_666 here and left the value off-grid.
        assert_eq!(snap_frame_floor(66_667, 30, 1), 66_667);
        assert_eq!(snap_frame_floor(99_999, 30, 1), 66_667);
    }

    #[test]
    fn snap_ceil_lands_on_the_next_canonical_start() {
        assert_eq!(snap_frame_ceil(0, 30, 1), 0);
        assert_eq!(snap_frame_ceil(1, 30, 1), 33_333);
        assert_eq!(snap_frame_ceil(33_333, 30, 1), 33_333);
        assert_eq!(snap_frame_ceil(33_334, 30, 1), 66_667);
    }

    #[test]
    fn snap_floor_29_97_doesnt_overflow_at_hour_scale() {
        // Sanity: an hour in microseconds is 3_600_000_000.
        // i128 arithmetic must not overflow.
        let one_hour = 3_600_000_000_i64;
        let snapped = snap_frame_floor(one_hour, 30_000, 1001);
        // 29.97 fps means ~107892 frames per hour. Snapped value is
        // <= one_hour by construction.
        assert!(snapped <= one_hour);
        assert!(snapped > one_hour - 50_000); // within one frame
    }

    #[test]
    fn snap_round_integer_fps() {
        // At 30 fps, frame duration ≈ 33333.33 us. Integer snap_frame_round
        // rounds half-up: anything from 16667 us (half-frame) onward goes
        // to the next frame.
        assert_eq!(snap_frame_round(0, 30, 1), 0);
        assert_eq!(snap_frame_round(16_666, 30, 1), 0);
        assert_eq!(snap_frame_round(16_667, 30, 1), 33_333);
        assert_eq!(snap_frame_round(33_333, 30, 1), 33_333);
        assert_eq!(snap_frame_round(49_999, 30, 1), 33_333);
        // Output is half-up rounded to match PacketPump.ts source-PTS rounding
        // (frame 2 true µs = 66_666.667 → 66_667).
        assert_eq!(snap_frame_round(50_000, 30, 1), 66_667);
    }

    #[test]
    fn snap_round_29_97_doesnt_overflow_at_hour_scale() {
        let one_hour = 3_600_000_000_i64;
        let snapped = snap_frame_round(one_hour, 30_000, 1001);
        // Within half a frame of the input.
        let half_frame_us = 16_700_i64;
        assert!((snapped - one_hour).abs() <= half_frame_us);
    }

    /// Frame indices to probe: a dense head (where index-policy off-by-ones
    /// live) plus a coprime stride out to 24 h, the far end of the range the
    /// i128 math exists to keep exact.
    fn probe_frames(num: u32, den: u32) -> Vec<i64> {
        let last = frame_count(0, US_24H, num, den) - 1;
        let mut out: Vec<i64> = (0..10_000_i64.min(last)).collect();
        let mut i = 10_000_i64;
        while i < last {
            out.push(i);
            i += 9973;
        }
        out.push(last);
        out
    }

    #[test]
    fn frame_index_round_trips_and_time_is_strictly_monotonic() {
        for (num, den) in RATES {
            let mut prev: Option<(i64, i64)> = None;
            for i in probe_frames(num, den) {
                let t = time_us_at_frame(i, num, den);
                assert_eq!(
                    frame_index_round(t, num, den),
                    i,
                    "{num}/{den} frame {i} → {t} did not round-trip"
                );
                assert_eq!(frame_index_floor(t, num, den), i, "{num}/{den} floor at {t}");
                assert_eq!(frame_index_ceil(t, num, den), i, "{num}/{den} ceil at {t}");
                if let Some((pi, pt)) = prev {
                    assert!(t > pt, "{num}/{den}: frame {i} ({t}) <= frame {pi} ({pt})");
                }
                prev = Some((i, t));
            }
        }
    }

    #[test]
    fn snap_is_idempotent_and_floor_le_round_le_ceil() {
        for (num, den) in RATES {
            // Canonical boundaries, their ±1 µs neighbours, cell midpoints, and
            // hour/24 h scale — the places a policy mismatch shows up.
            let mut probes = vec![0_i64, 1, US_24H];
            for i in [0_i64, 1, 2, 3, 107_892, 5_183_999] {
                let t = time_us_at_frame(i, num, den);
                probes.extend([t - 1, t, t + 1, t + (US_PER_SEC * den as i64) / (2 * num as i64)]);
            }
            for t in probes.into_iter().filter(|t| *t >= 0) {
                let lo = snap_frame_floor(t, num, den);
                let mid = snap_frame_round(t, num, den);
                let hi = snap_frame_ceil(t, num, den);
                assert!(lo <= mid && mid <= hi, "{num}/{den} t={t}: {lo}/{mid}/{hi}");
                assert!(lo <= t && t <= hi, "{num}/{den} t={t} not bracketed");
                assert_eq!(snap_frame_floor(lo, num, den), lo, "{num}/{den} floor t={t}");
                assert_eq!(snap_frame_round(mid, num, den), mid, "{num}/{den} round t={t}");
                assert_eq!(snap_frame_ceil(hi, num, den), hi, "{num}/{den} ceil t={t}");
            }
        }
    }

    #[test]
    fn frame_count_agrees_with_its_own_predicate() {
        for (num, den) in RATES {
            assert_eq!(frame_count(1_000_000, 1_000_000, num, den), 0);
            assert_eq!(frame_count(2_000_000, 1_000_000, num, den), 0); // reversed range
            for end in [1_i64, 999_999, 1_000_000, 10_000_000, 3_600_000_000, US_24H] {
                let start = 500_000;
                let n = frame_count(start, start + end, num, den);
                if n > 0 {
                    assert!(
                        time_us_at_frame(n - 1, num, den) < end,
                        "{num}/{den} end={end}: frame {} not inside",
                        n - 1
                    );
                }
                assert!(
                    time_us_at_frame(n, num, den) >= end,
                    "{num}/{den} end={end}: frame {n} should be past the range"
                );
            }
            // A 24 h count fits well inside f64's exact-integer range, which is
            // what lets the TS wrapper hand these across the wasm ABI as f64.
            assert!((frame_count(0, US_24H, num, den) as f64) < 9_007_199_254_740_992.0);
        }
    }

    #[derive(serde::Deserialize)]
    struct GoldenSample {
        t_us: i64,
        expect: i64,
    }
    #[derive(serde::Deserialize)]
    struct GoldenCase {
        name: String,
        fps_num: u32,
        fps_den: u32,
        samples: Vec<GoldenSample>,
    }
    #[derive(serde::Deserialize)]
    struct GoldenFrameTime {
        frame: i64,
        expect: i64,
    }
    #[derive(serde::Deserialize)]
    struct GoldenGridSample {
        t_us: i64,
        floor_frame: i64,
        round_frame: i64,
        ceil_frame: i64,
        floor_us: i64,
        round_us: i64,
        ceil_us: i64,
    }
    #[derive(serde::Deserialize)]
    struct GoldenGridCase {
        name: String,
        fps_num: u32,
        fps_den: u32,
        frame_times: Vec<GoldenFrameTime>,
        samples: Vec<GoldenGridSample>,
    }
    #[derive(serde::Deserialize)]
    struct GoldenFixture {
        cases: Vec<GoldenCase>,
        grid_cases: Vec<GoldenGridCase>,
    }

    /// Cross-language golden vectors. The SAME fixture is asserted by
    /// `apps/desktop/src/renderer/frames.golden.test.ts` against the wasm-backed
    /// TS wrappers; a value that passes one side and fails the other is snap-math
    /// drift, which is exactly what this test exists to catch. `cases` pins
    /// `snap_frame_round`, `grid_cases` pins `time_us_at_frame` plus the three
    /// index policies and their µs outputs. On an INTENTIONAL math change,
    /// recompute the affected `expect` values (i128 integer math) and mirror the
    /// edit in `frames.ts` the same turn.
    #[test]
    fn golden_vectors_match_fixture() {
        let fixture: GoldenFixture = serde_json::from_str(include_str!(
            "../../../src/renderer/snapFrameGolden.fixture.json"
        ))
        .expect("snap golden fixture parses");
        assert!(!fixture.cases.is_empty());
        for case in &fixture.cases {
            for s in &case.samples {
                let got = snap_frame_round(s.t_us, case.fps_num, case.fps_den);
                assert_eq!(
                    got, s.expect,
                    "case `{}` t_us={}: got {got}, expect {}",
                    case.name, s.t_us, s.expect
                );
            }
        }
        assert!(!fixture.grid_cases.is_empty());
        for case in &fixture.grid_cases {
            let (n, d) = (case.fps_num, case.fps_den);
            let at = |label: &str, got: i64, expect: i64, key: i64| {
                assert_eq!(
                    got, expect,
                    "grid case `{}` {label} @{key}: got {got}, expect {expect}",
                    case.name
                );
            };
            for f in &case.frame_times {
                at("time_us_at_frame", time_us_at_frame(f.frame, n, d), f.expect, f.frame);
            }
            for s in &case.samples {
                at("floor_frame", frame_index_floor(s.t_us, n, d), s.floor_frame, s.t_us);
                at("round_frame", frame_index_round(s.t_us, n, d), s.round_frame, s.t_us);
                at("ceil_frame", frame_index_ceil(s.t_us, n, d), s.ceil_frame, s.t_us);
                at("floor_us", snap_frame_floor(s.t_us, n, d), s.floor_us, s.t_us);
                at("round_us", snap_frame_round(s.t_us, n, d), s.round_us, s.t_us);
                at("ceil_us", snap_frame_ceil(s.t_us, n, d), s.ceil_us, s.t_us);
            }
        }
    }
}
