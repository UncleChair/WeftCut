//! Resident-ABI wasm exports. SCALARS ONLY across the boundary: the active
//! keyframe track lives in static buffers, uploaded once via `set_kf`/`set_n`
//! and evaluated per call by `eval`. Times are `f64` µs and rates are `i32`
//! (NEVER i64 — that would force BigInt marshaling at the JS boundary). Built
//! only for wasm32; the native crate excludes this module.
//!
//! Color is the one carve-out: an `Rgba8` crosses as a PACKED i32 (RGBA8 in one
//! scalar) via `set_kf_rgba`/`eval_rgba_packed` — still no BigInt and no memory
//! reads, just one i32 per color instead of four channel scalars.
//!
//! Single-threaded by construction (one wasm instance, no threads), so the
//! `static mut` track buffer needs no synchronization. `Rational` is NOT here —
//! the snap fn takes `(num, den)` primitives (it stays in the napi crate).
// NOTE: the generic `crate::eval` is NOT imported here — this module exports its
// own `extern "C" fn eval` (the scalar shim), so the color path calls
// `crate::eval::<Rgba8>` fully-qualified to dodge the name collision.
use crate::{
    db_to_linear as db_to_linear_impl, eval_f64, fade_multiplier as fade_multiplier_impl,
    frame_count as frame_count_impl, frame_index_ceil as frame_index_ceil_impl,
    frame_index_floor as frame_index_floor_impl, frame_index_round as frame_index_round_impl,
    pan_coeffs as pan_coeffs_impl, role_audible as role_audible_impl, snap_frame_ceil,
    snap_frame_floor, snap_frame_round, time_us_at_frame as time_us_at_frame_impl,
    us_to_frame as us_to_frame_impl, Interpolation, Kf, Rgba8,
};

/// Max keyframes held resident for ONE animated property (an `Animated<T>` /
/// the renderer's `AnimTrack` — e.g. one layer's opacity or x), NOT a whole
/// timeline track or clip. Static buffers because the no_std wasm build has no
/// heap; `set_n`/`set_kf` clamp longer inputs (the renderer authors at most a
/// handful per property). LANDMINE: this caps the wasm PREVIEW only — native
/// export's `value_at` evaluates the full keyframe vector, so a >MAXKF property
/// would make preview diverge from export. TS `loadTrack` (MAX_KEYFRAMES) warns.
const MAXKF: usize = 256;

static mut T: [i64; MAXKF] = [0; MAXKF];
static mut V: [f64; MAXKF] = [0.0; MAXKF];
static mut IT: [Interpolation; MAXKF] = [Interpolation::Linear; MAXKF];
static mut N: usize = 0;

// Resident COLOR track, PARALLEL to the scalar one above (independent buffer;
// `loadColorTrack` in the TS layer caches it under its own handle). Values are
// packed RGBA8 (`(r<<24)|(g<<16)|(b<<8)|a`, r in the HIGH byte) so a color
// crosses the scalars-only ABI as one i32 — see the module header.
static mut TC: [i64; MAXKF] = [0; MAXKF];
static mut VC: [u32; MAXKF] = [0; MAXKF];
static mut ITC: [Interpolation; MAXKF] = [Interpolation::Linear; MAXKF];
static mut NC: usize = 0;

/// `snap_frame_round(t_us, num/den)` — round to the nearest frame boundary.
#[no_mangle]
pub extern "C" fn snap_round(t_us: f64, num: i32, den: i32) -> f64 {
    snap_frame_round(t_us as i64, num as u32, den as u32) as f64
}

/// `snap_frame_floor(t_us, num/den)` — floor to the frame boundary at or below.
#[no_mangle]
pub extern "C" fn snap_floor(t_us: f64, num: i32, den: i32) -> f64 {
    snap_frame_floor(t_us as i64, num as u32, den as u32) as f64
}

/// `snap_frame_ceil(t_us, num/den)` — ceil to the frame boundary at or above.
#[no_mangle]
pub extern "C" fn snap_ceil(t_us: f64, num: i32, den: i32) -> f64 {
    snap_frame_ceil(t_us as i64, num as u32, den as u32) as f64
}

/// `time_us_at_frame(frame, num/den)` — canonical µs of a frame index. Frame
/// indices and µs both stay far inside f64's exact-integer range at 24 h
/// (`i * 1e6 * den` peaks near 5.2e15, 1.7x under 2^53), so the f64 ABI is
/// lossless for every rate the app authors.
#[no_mangle]
pub extern "C" fn time_us_at_frame(frame: f64, num: i32, den: i32) -> f64 {
    time_us_at_frame_impl(frame as i64, num as u32, den as u32) as f64
}

/// `frame_index_floor(t_us, num/den)` — index of the frame containing `t_us`.
#[no_mangle]
pub extern "C" fn frame_index_floor(t_us: f64, num: i32, den: i32) -> f64 {
    frame_index_floor_impl(t_us as i64, num as u32, den as u32) as f64
}

/// `frame_index_round(t_us, num/den)` — index of the nearest frame (half-up).
#[no_mangle]
pub extern "C" fn frame_index_round(t_us: f64, num: i32, den: i32) -> f64 {
    frame_index_round_impl(t_us as i64, num as u32, den as u32) as f64
}

/// `frame_index_ceil(t_us, num/den)` — index of the first frame at or after `t_us`.
#[no_mangle]
pub extern "C" fn frame_index_ceil(t_us: f64, num: i32, den: i32) -> f64 {
    frame_index_ceil_impl(t_us as i64, num as u32, den as u32) as f64
}

/// `frame_count(start_us, end_us, num/den)` — grid frames in `[start, end)`.
#[no_mangle]
pub extern "C" fn frame_count(start_us: f64, end_us: f64, num: i32, den: i32) -> f64 {
    frame_count_impl(start_us as i64, end_us as i64, num as u32, den as u32) as f64
}

/// `us_to_frame(us, rate)` — µs → sample-frame index at `rate` Hz (half-up).
/// Callers pass integer-valued µs (the preview playhead is frame-snapped), so the
/// `as i64` cast is lossless — same f64→i64 convention as `snap_round` above.
#[no_mangle]
pub extern "C" fn us_to_frame(us: f64, rate: i32) -> f64 {
    us_to_frame_impl(us as i64, rate as u32) as f64
}

/// Set the resident track length (number of keyframes uploaded via `set_kf`).
#[no_mangle]
pub extern "C" fn set_n(n: i32) {
    let n = (n as usize).min(MAXKF);
    unsafe {
        N = n;
    }
}

/// Upload one keyframe into the resident buffer. `interp`: 0=Hold, 1=Linear,
/// 2=EaseIn, 3=EaseOut, else=Bezier(p1,p2). The p1/p2 args are ignored for the
/// non-Bezier codes.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn set_kf(
    i: i32,
    t_us: f64,
    value: f64,
    interp: i32,
    p1x: f64,
    p1y: f64,
    p2x: f64,
    p2y: f64,
) {
    let it = match interp {
        0 => Interpolation::Hold,
        1 => Interpolation::Linear,
        2 => Interpolation::EaseIn,
        3 => Interpolation::EaseOut,
        _ => Interpolation::Bezier {
            p1: (p1x, p1y),
            p2: (p2x, p2y),
        },
    };
    let i = (i as usize).min(MAXKF - 1);
    unsafe {
        T[i] = t_us as i64;
        V[i] = value;
        IT[i] = it;
    }
}

/// Evaluate the resident track at `t_us`, returning `default` for an empty track.
#[no_mangle]
pub extern "C" fn eval(t_us: f64, default: f64) -> f64 {
    unsafe {
        let n = N;
        let mut buf: [Kf; MAXKF] = [Kf {
            t_us: 0,
            value: 0.0,
            interp: Interpolation::Linear,
        }; MAXKF];
        for i in 0..n {
            buf[i] = Kf {
                t_us: T[i],
                value: V[i],
                interp: IT[i],
            };
        }
        eval_f64(&buf[..n], t_us as i64, default)
    }
}

/// Set the resident COLOR track length (keyframes uploaded via `set_kf_rgba`).
#[no_mangle]
pub extern "C" fn set_n_rgba(n: i32) {
    let n = (n as usize).min(MAXKF);
    unsafe {
        NC = n;
    }
}

/// Upload one COLOR keyframe. `packed` layout is documented at the color-track
/// buffer above; `interp` codes + p1/p2 semantics match `set_kf`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn set_kf_rgba(
    i: i32,
    t_us: f64,
    packed: i32,
    interp: i32,
    p1x: f64,
    p1y: f64,
    p2x: f64,
    p2y: f64,
) {
    let it = match interp {
        0 => Interpolation::Hold,
        1 => Interpolation::Linear,
        2 => Interpolation::EaseIn,
        3 => Interpolation::EaseOut,
        _ => Interpolation::Bezier {
            p1: (p1x, p1y),
            p2: (p2x, p2y),
        },
    };
    let i = (i as usize).min(MAXKF - 1);
    unsafe {
        TC[i] = t_us as i64;
        VC[i] = packed as u32;
        ITC[i] = it;
    }
}

/// Evaluate the resident COLOR track at `t_us` through the SAME leaf
/// `eval::<Rgba8>` (OkLab + premultiplied alpha) the native side runs, returning
/// `default_packed` for an empty track. In/out are packed RGBA8 i32 — r in the
/// HIGH byte, matching the TS `packRgba`/`unpackRgba` exactly.
#[no_mangle]
pub extern "C" fn eval_rgba_packed(t_us: f64, default_packed: i32) -> i32 {
    unsafe {
        let n = NC;
        let unpack = |u: u32| Rgba8 {
            r: (u >> 24) as u8,
            g: (u >> 16) as u8,
            b: (u >> 8) as u8,
            a: u as u8,
        };
        let mut buf: [Kf<Rgba8>; MAXKF] = [Kf {
            t_us: 0,
            value: Rgba8 {
                r: 0,
                g: 0,
                b: 0,
                a: 0,
            },
            interp: Interpolation::Linear,
        }; MAXKF];
        for i in 0..n {
            buf[i] = Kf {
                t_us: TC[i],
                value: unpack(VC[i]),
                interp: ITC[i],
            };
        }
        let def = unpack(default_packed as u32);
        let out = crate::eval::<Rgba8>(&buf[..n], t_us as i64, def);
        (((out.r as u32) << 24) | ((out.g as u32) << 16) | ((out.b as u32) << 8) | (out.a as u32))
            as i32
    }
}

/// `10^(db/20)` linear gain.
#[no_mangle]
pub extern "C" fn db_to_linear(db: f64) -> f32 {
    db_to_linear_impl(db)
}

/// Role mute/solo gate (booleans as i32; nonzero = true). Returns 1 if audible.
#[no_mangle]
pub extern "C" fn role_audible(muted: i32, solo: i32, any_solo: i32) -> i32 {
    role_audible_impl(muted != 0, solo != 0, any_solo != 0) as i32
}

/// `pan_coeffs(pan, channels)[idx]` — equal-power pan law, one coefficient per
/// call (scalar ABI; the renderer reads idx 0..3 to build the matrix curves).
#[no_mangle]
pub extern "C" fn pan_coeff(pan: f64, channels: i32, idx: i32) -> f32 {
    let c = pan_coeffs_impl(pan, channels);
    let i = (idx as usize).min(3);
    c[i]
}

/// `fade_multiplier(t_us, span_us, fade_in_us, fade_out_us)` — fade ramp. Times
/// as f64 µs (frame/grid-aligned integers, lossless `as i64`).
#[no_mangle]
pub extern "C" fn fade_mul(t_us: f64, span_us: f64, fade_in_us: f64, fade_out_us: f64) -> f64 {
    fade_multiplier_impl(
        t_us as i64,
        span_us as i64,
        fade_in_us as i64,
        fade_out_us as i64,
    )
}

/// Liveness probe for the loader.
#[no_mangle]
pub extern "C" fn noop() {}
