//! weftcut-eval: the pure, dependency-light "WYSIWYG math" shared by the
//! actor + export (native build) and the renderer (wasm32 build). No imbl /
//! uuid / napi / tokio / serde / schemars in the shipped artifact.
//! See docs/superpowers/plans/2026-06-20-weftcut-eval-leaf-crate.md
//!
//! `no_std` ONLY on wasm32: the wasm artifact must stay minimal and std-free,
//! and the wasm build (run on every task) is what enforces the "core/libm only"
//! discipline. Natively the crate links std so its `cdylib`/`rlib`/test targets
//! build without a hand-rolled panic handler or eh_personality — it is consumed
//! by the napi crate purely as an `rlib`, and the wasm `cdylib` is the only
//! std-free artifact we actually ship.
#![cfg_attr(target_arch = "wasm32", no_std)]

// On wasm32 the crate is no_std and links as a standalone cdylib, so it must
// supply its own panic handler. wasm32-unknown-unknown defaults to panic=abort,
// so no eh_personality is needed. Never compiled natively (std supplies one).
#[cfg(all(target_arch = "wasm32", not(test)))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

// ===========================================================================
// Frame snap. Time is `i64` microseconds (the napi crate aliases `TimeUs = i64`
// and wraps these). Frame rate crosses as the primitive pair `(num, den)`: the
// actor's `Rational` carries serde + schemars derives for the project schema and
// so stays in the napi crate (`state/time.rs`); the wasm/TS sides pass the same
// two integers. Only the i128 snap ALGORITHM is shared here — that is the value
// that must never drift across the renderer↔Rust boundary. Pure integer math;
// no std needed. Callers pass a valid rate (den/num != 0); degenerate-fps guards
// live in the wrappers (TS `snapFrameRound`).
// ===========================================================================

pub const US_PER_SEC: i64 = 1_000_000;
pub const US_PER_MS: i64 = 1_000;

/// Round `t_us` DOWN to the nearest `num/den`-fps frame boundary.
///
/// Math (in `i128` to avoid overflow at hour-plus timelines):
///
/// ```text
/// frame_index   = floor(t_us * num / (US_PER_SEC * den))
/// snapped_t_us  = frame_index * US_PER_SEC * den / num
/// ```
///
/// 29.97 fps (30000/1001) doesn't yield integer-us frame boundaries; the
/// final divide truncates. The asymmetry is harmless as long as every
/// caller snaps with the same function. See `docs/data-model.md` —
/// Timeline-field alignment.
pub fn snap_frame_floor(t_us: i64, num: u32, den: u32) -> i64 {
    let prod = (t_us as i128) * (num as i128);
    let div = (US_PER_SEC as i128) * (den as i128);
    let frame_index = prod.div_euclid(div);
    let snapped = frame_index * (US_PER_SEC as i128) * (den as i128) / (num as i128);
    snapped as i64
}

/// Round `t_us` UP to the nearest `num/den`-fps frame boundary. Symmetric
/// to `snap_frame_floor`; see its docs.
pub fn snap_frame_ceil(t_us: i64, num: u32, den: u32) -> i64 {
    let prod = (t_us as i128) * (num as i128);
    let div = (US_PER_SEC as i128) * (den as i128);
    let frame_index = prod.div_euclid(div);
    let rem = prod.rem_euclid(div);
    let frame_index = if rem > 0 { frame_index + 1 } else { frame_index };
    let snapped = frame_index * (US_PER_SEC as i128) * (den as i128) / (num as i128);
    snapped as i64
}

/// Round `t_us` to the NEAREST `num/den`-fps frame boundary (half-up).
/// Same i128 arithmetic as `snap_frame_floor`/`snap_frame_ceil`. For
/// `t_us` exactly at a half-frame, snaps UP to the later frame.
///
/// Use this for round-to-nearest snap of timeline mutations (move,
/// trim, split, seek). Floor/ceil exist for the rare cases where
/// asymmetric snap is needed.
///
/// The OUTPUT value is also half-up rounded, matching the demuxer's
/// source-PTS rounding (`apps/desktop/src/renderer/render/decoder/PacketPump.ts`:
/// `Math.round(pts * 1e6)`). Without this, per-frame splits
/// at frame indices where `N * 1_000_000 * den / num` has fractional
/// > 0.5 (e.g. frames 2, 5, 8 at 30 fps) store `src_in_us` 1 µs below
/// the demuxer's source PTS for the same frame, so `FrameRing.frameAt`
/// falls into source frame N−1. The mismatch is masked at the un-moved
/// position by `snapFrameFloor`'s half-up output (which yields a +1 µs
/// `layerLocalUs` that cancels the offset) but surfaces the moment the
/// layer is moved to a destination whose `t_start_us` has no truncation
/// gap to subtract. Fixed by aligning this output rounding with the
/// demuxer's.
pub fn snap_frame_round(t_us: i64, num: u32, den: u32) -> i64 {
    let prod = (t_us as i128) * (num as i128);
    let div = (US_PER_SEC as i128) * (den as i128);
    // Half-up: floor((prod + div/2) / div).
    let frame_index = (prod + div / 2).div_euclid(div);
    let num = num as i128;
    let numer = frame_index * (US_PER_SEC as i128) * (den as i128);
    let snapped = (numer + num / 2).div_euclid(num);
    snapped as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    // 30 fps = (30, 1); 29.97 fps = (30_000, 1001).
    #[test]
    fn snap_floor_integer_fps_at_frame_boundary() {
        // 30 fps → frame duration ~33333.33 us. The function uses i128
        // integer math throughout, so the asymmetry around the
        // non-integer frame boundary lands as:
        //   * t=0       → frame 0 starts at 0
        //   * t=33332   → still in frame 0 (33332*30 < 1_000_000)
        //   * t=33333   → still in frame 0 (33333*30 = 999990 < 1e6)
        //   * t=33334   → snaps DOWN to frame 1's snapped start = 33333
        // The asymmetry doesn't matter as long as every caller snaps
        // with the same function (and they do).
        assert_eq!(snap_frame_floor(0, 30, 1), 0);
        assert_eq!(snap_frame_floor(33_332, 30, 1), 0);
        assert_eq!(snap_frame_floor(33_333, 30, 1), 0);
        assert_eq!(snap_frame_floor(33_334, 30, 1), 33_333);
    }

    #[test]
    fn snap_ceil_integer_fps_at_frame_boundary() {
        assert_eq!(snap_frame_ceil(0, 30, 1), 0);
        // Just past the first frame boundary should snap to the next frame.
        assert_eq!(snap_frame_ceil(1, 30, 1), 33_333);
        assert_eq!(snap_frame_ceil(33_333, 30, 1), 33_333);
        assert_eq!(snap_frame_ceil(33_334, 30, 1), 66_666);
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
    fn snap_floor_then_ceil_brackets_input() {
        // For any t_us in the middle of a frame, floor < t_us <= ceil
        // (or floor == t_us == ceil when on a boundary).
        let t = 17_000_i64; // middle of frame 0 at 30 fps
        let lo = snap_frame_floor(t, 30, 1);
        let hi = snap_frame_ceil(t, 30, 1);
        assert!(lo <= t);
        assert!(t <= hi);
        assert!(hi - lo <= 33_334); // one frame at 30 fps
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
    fn snap_round_brackets_floor_and_ceil() {
        // For any t_us, floor <= round <= ceil — within 1 µs slack on the
        // upper bound. The slack exists because `snap_frame_round` now
        // half-up rounds its OUTPUT (matching the demuxer) while
        // `snap_frame_ceil` still truncates: for fractional > 0.5 frame
        // boundaries (e.g. frame 2 at 30 fps is 66666.667 µs), ceil
        // returns 66666 and round returns 66667. Bracket invariant holds
        // on the FRAME INDEX; the µs output value can land 1 µs above
        // ceil at those grid points.
        for t in [0_i64, 10_000, 17_000, 33_333, 50_000, 99_999] {
            let lo = snap_frame_floor(t, 30, 1);
            let mid = snap_frame_round(t, 30, 1);
            let hi = snap_frame_ceil(t, 30, 1);
            assert!(lo <= mid, "floor {lo} <= round {mid} (t={t})");
            assert!(mid <= hi + 1, "round {mid} <= ceil {hi} + 1 (t={t})");
        }
    }

    #[test]
    fn snap_round_29_97_doesnt_overflow_at_hour_scale() {
        let one_hour = 3_600_000_000_i64;
        let snapped = snap_frame_round(one_hour, 30_000, 1001);
        // Within half a frame of the input.
        let half_frame_us = 16_700_i64;
        assert!((snapped - one_hour).abs() <= half_frame_us);
    }

    /// Cross-language golden vectors. The SAME fixture is asserted by
    /// `apps/desktop/src/renderer/frames.golden.test.ts` against the TS
    /// `snapFrameRound`; a value that passes one side and fails the other is
    /// snap-math drift, which is exactly what this test exists to catch. On an
    /// INTENTIONAL math change, recompute the affected `expect` values (i128
    /// integer math) and mirror the edit in `frames.ts` the same turn.
    #[test]
    fn golden_vectors_match_fixture() {
        #[derive(serde::Deserialize)]
        struct Sample {
            t_us: i64,
            expect: i64,
        }
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            fps_num: u32,
            fps_den: u32,
            samples: Vec<Sample>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
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
    }
}
