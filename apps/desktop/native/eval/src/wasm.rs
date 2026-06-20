//! Resident-ABI wasm exports. SCALARS ONLY across the boundary: the active
//! keyframe track lives in static buffers, uploaded once via `set_kf`/`set_n`
//! and evaluated per call by `eval`. Times are `f64` µs and rates are `i32`
//! (NEVER i64 — that would force BigInt marshaling at the JS boundary). Built
//! only for wasm32; the native crate excludes this module.
//!
//! Single-threaded by construction (one wasm instance, no threads), so the
//! `static mut` track buffer needs no synchronization. `Rational` is NOT here —
//! the snap fn takes `(num, den)` primitives (it stays in the napi crate).
use crate::{
    db_to_linear as db_to_linear_impl, eval_f64, role_audible as role_audible_impl,
    snap_frame_round, Interpolation, Kf,
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

/// `snap_frame_round(t_us, num/den)` — round to the nearest frame boundary.
#[no_mangle]
pub extern "C" fn snap_round(t_us: f64, num: i32, den: i32) -> f64 {
    snap_frame_round(t_us as i64, num as u32, den as u32) as f64
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

/// Liveness probe for the loader.
#[no_mangle]
pub extern "C" fn noop() {}
