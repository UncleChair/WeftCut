# Task 7 Report: Native — export pan path → coefficient-lerp matrix

## What was done

### mix_block rewrite (`native/src/audio/mix.rs`)

Changed the import line from:
```rust
use crate::audio::envelope::{Envelope, pan_frame, sample_gain, sample_pan};
```
to:
```rust
use crate::audio::envelope::{Envelope, pan_coeffs_at, sample_gain, sample_pan};
```

Replaced the per-sample pan application block inside the `for k in 0..frames` loop. Old code:
- sampled `pan.eval(local_us)` to a scalar value `p`
- built a scaled `[f32;2]` by doubling the mono sample into both slots
- called `pan_frame(p, &scaled[..ch.min(2)])` (lerped VALUE then computed matrix at that single point)

New code:
- calls `pan_coeffs_at(&layer.pan, ch as i32, local_us)` → `[a,b,c,d]` (lerps COEFFICIENTS between grid straddling points — the X parity contract)
- builds `(l, r)` with mono-correct `1 => (frame[0]*g, 0.0)` arm so `r=0` and the `b*r` / `d*r` terms vanish for mono
- outputs `out[k*2] += a*l + b*r; out[k*2+1] += c*l + d*r`

### Deletions (`native/src/audio/envelope.rs`)

Deleted:
- `pub fn pan_frame(pan: f32, ch: &[f32]) -> (f32, f32)` and its preceding doc-comment block (20 lines)
- Three unit tests: `pan_law_center_mono_is_equal_power`, `pan_law_stereo_center_is_identity`, `pan_law_hard_left_stereo_folds_right_into_left`

Coverage for those three cases is now in the pan-law golden (Task 4).

## pan_frame deletion confirmation

```
$ grep -rn "pan_frame" native/src
(no output)
```

Zero matches — `pan_frame` is fully deleted and unreferenced.

## Test evidence

### Command
```
cargo test -p weftcut --manifest-path native/Cargo.toml --features jobs,export audio::mix
```

### Output (audio::mix — 17 tests)
```
test audio::mix::tests::single_centered_mono_layer_equal_power ... ok
test audio::mix::tests::overlapping_layers_sum ... ok
test audio::mix::tests::placement_offsets_and_silence_gaps ... ok
test audio::mix::tests::gain_envelope_applies_per_sample ... ok
test audio::mix::tests::golden_vectors_match_fixture ... ok
test audio::mix::tests::us_to_frame_is_exact_on_the_grid ... ok
... (all 17 passing)
test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured
```

The `single_centered_mono_layer_equal_power` test confirms: mono center (pan=0) → `pan_coeffs(0.0, 1) = [0.7071, 0, 0.7071, 0]`, input 0.5 → each side `0.5 × 0.7071 ≈ 0.35355`, passes at 1e-4 tolerance.

### Command
```
cargo test -p weftcut --manifest-path native/Cargo.toml --features jobs,export audio::envelope
```

### Output (audio::envelope — 8 tests)
```
test audio::envelope::tests::golden_vectors_match_fixture ... ok
test audio::envelope::tests::fade_in_ramps_linearly ... ok
... (all 8 passing)
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured
```

## Files changed

- `apps/desktop/native/src/audio/mix.rs` — import + mix_block per-sample body
- `apps/desktop/native/src/audio/envelope.rs` — deleted `pan_frame` fn + 3 tests

## Self-review

- The mono arm `1 => (frame[0]*g, 0.0)` correctly sets `r=0`, matching the brief's explanation: `pan_coeffs(channels=1)` returns `[a,0,c,0]` (b=d=0), so `a*l+b*0` and `c*l+d*0` reduce to `a*l` and `c*l`.
- The stereo arm `_ => (frame[0]*g, frame[1]*g)` preserves parity with the old stereo scaling (gains applied before the matrix, same as before).
- `pan_coeffs_at` is called with `ch as i32` — exactly as the brief specifies; the channels argument selects the pan law branch inside `weftcut_eval::pan_coeffs`.
- No formatter/linter was run; style matches surrounding code by hand.

## Concerns

None. The rewrite is a direct substitution confirmed by 25 passing tests (17 mix + 8 envelope), the grep clean check, and matching the verbatim brief.
