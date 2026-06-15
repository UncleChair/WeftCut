//! Pure `Animated<f64>` keyframe transforms for the authoring surface.
//!
//! Behavioral mirror of `apps/desktop/src/keyframe/edits.ts`. Times are
//! LAYER-LOCAL microseconds (the keyframe `t_us` base). Each fn returns a NEW
//! track; the actor re-normalizes (snap/sort/dedupe) on write, so these need
//! only stay self-consistent.
//!
//! Cross-language parity is locked by `keyframeEditsGolden.fixture.json`
//! (asserted by `golden_vectors_match_fixture` here AND by
//! `keyframe/edits.golden.test.ts`). Any edit here MUST be mirrored in the TS
//! and reflected in the fixture — there is no other enforcing test (see memory
//! `feedback_engine_source_drift`, `feedback_snap_math_drift`).

use crate::state::animated::{Animated, Interpolation, Keyframe};
use crate::state::ids::{KeyframeId, new_id};

const DEFAULT_INTERP: Interpolation = Interpolation::Linear;

/// Insert-or-update a key at `t_us` (layer-local). A `Static` track is lifted
/// (the new key is the only key). An existing key at exactly `t_us` is updated
/// in place — value always; interp only when `interp` is `Some`. Otherwise a new
/// key is inserted with `interp` when `Some`, else the preceding key's interp,
/// else `Linear`.
pub fn upsert(
    track: &Animated<f64>,
    t_us: i64,
    value: f64,
    interp: Option<Interpolation>,
) -> Animated<f64> {
    let kfs = match track {
        Animated::Static(_) => {
            return Animated::Keyframed(
                std::iter::once(Keyframe {
                    id: new_id(),
                    t_us,
                    value,
                    interp: interp.unwrap_or(DEFAULT_INTERP),
                })
                .collect(),
            );
        }
        Animated::Keyframed(kfs) => kfs,
    };
    let mut keys: Vec<Keyframe<f64>> = kfs.iter().cloned().collect();
    if let Some(at) = keys.iter().position(|k| k.t_us == t_us) {
        keys[at].value = value;
        if let Some(i) = interp {
            keys[at].interp = i;
        }
        return Animated::Keyframed(keys.into_iter().collect());
    }
    let inherited = keys
        .iter()
        .filter(|k| k.t_us < t_us)
        .next_back()
        .map(|k| k.interp)
        .unwrap_or(DEFAULT_INTERP);
    keys.push(Keyframe {
        id: new_id(),
        t_us,
        value,
        interp: interp.unwrap_or(inherited),
    });
    keys.sort_by_key(|k| k.t_us);
    Animated::Keyframed(keys.into_iter().collect())
}

/// Remove a key by id. When it was the last key, collapse to a `Static` holding
/// that key's value (so the property keeps its on-screen value). `fallback` is
/// used only if `id` is absent (callers pre-check existence).
pub fn remove(track: &Animated<f64>, id: KeyframeId, fallback: f64) -> Animated<f64> {
    let Animated::Keyframed(kfs) = track else {
        return track.clone();
    };
    let remaining: Vec<Keyframe<f64>> = kfs.iter().filter(|k| k.id != id).cloned().collect();
    if remaining.is_empty() {
        let removed = kfs.iter().find(|k| k.id == id).map(|k| k.value);
        return Animated::Static(removed.unwrap_or(fallback));
    }
    Animated::Keyframed(remaining.into_iter().collect())
}

/// Move one key to `new_t_us` (layer-local) and re-sort.
pub fn retime(track: &Animated<f64>, id: KeyframeId, new_t_us: i64) -> Animated<f64> {
    let Animated::Keyframed(kfs) = track else {
        return track.clone();
    };
    let mut keys: Vec<Keyframe<f64>> = kfs
        .iter()
        .map(|k| {
            if k.id == id {
                Keyframe { t_us: new_t_us, ..k.clone() }
            } else {
                k.clone()
            }
        })
        .collect();
    keys.sort_by_key(|k| k.t_us);
    Animated::Keyframed(keys.into_iter().collect())
}

/// Set the easing of the segment leaving key `id`.
pub fn set_interp(track: &Animated<f64>, id: KeyframeId, interp: Interpolation) -> Animated<f64> {
    let Animated::Keyframed(kfs) = track else {
        return track.clone();
    };
    Animated::Keyframed(
        kfs.iter()
            .map(|k| if k.id == id { Keyframe { interp, ..k.clone() } } else { k.clone() })
            .collect(),
    )
}

/// Port of `keyframe/curve.ts::interpToCoeffs`: interp → cubic-bezier control
/// coords. Linear / Hold map to the identity diagonal.
fn interp_to_coeffs(interp: Interpolation) -> [f64; 4] {
    match interp {
        Interpolation::Bezier { p1, p2 } => [p1.0, p1.1, p2.0, p2.1],
        Interpolation::EaseIn => [0.42, 0.0, 1.0, 1.0],
        Interpolation::EaseOut => [0.0, 0.0, 0.58, 1.0],
        _ => [0.0, 0.0, 1.0, 1.0],
    }
}

fn clamp01(v: f64) -> f64 {
    if v < 0.0 { 0.0 } else if v > 1.0 { 1.0 } else { v }
}

/// Monotone-clamped tangent (value per microsecond) at interior key `i`; 0 at a
/// local extremum, an endpoint, or when a neighbour delta is 0.
fn tangent_at(keys: &[Keyframe<f64>], i: usize) -> f64 {
    if i == 0 || i + 1 >= keys.len() {
        return 0.0;
    }
    let d_prev = keys[i].value - keys[i - 1].value;
    let d_next = keys[i + 1].value - keys[i].value;
    if d_prev == 0.0 || d_next == 0.0 || d_prev.signum() != d_next.signum() {
        return 0.0;
    }
    let dt = (keys[i + 1].t_us - keys[i - 1].t_us) as f64;
    if dt <= 0.0 {
        return 0.0;
    }
    (keys[i + 1].value - keys[i - 1].value) / dt
}

/// Bake monotone (no-overshoot) C1 tangents at key `id` into the outgoing
/// segment (this key's p1) and the incoming segment (previous key's p2).
pub fn smooth_one(track: &Animated<f64>, id: KeyframeId) -> Animated<f64> {
    let Animated::Keyframed(kfs) = track else {
        return track.clone();
    };
    let keys: Vec<Keyframe<f64>> = kfs.iter().cloned().collect();
    let Some(i) = keys.iter().position(|k| k.id == id) else {
        return track.clone();
    };
    let m = tangent_at(&keys, i);
    let mut out = keys.clone();

    if i < keys.len() - 1 {
        let dt = (keys[i + 1].t_us - keys[i].t_us) as f64;
        let dv = keys[i + 1].value - keys[i].value;
        if dv == 0.0 || dt <= 0.0 {
            out[i].interp = Interpolation::Linear;
        } else {
            let [_, _, x2, y2] = interp_to_coeffs(keys[i].interp);
            let y1 = clamp01((m * dt) / (3.0 * dv));
            out[i].interp = Interpolation::Bezier { p1: (1.0 / 3.0, y1), p2: (x2, y2) };
        }
    }

    if i > 0 {
        let dt = (keys[i].t_us - keys[i - 1].t_us) as f64;
        let dv = keys[i].value - keys[i - 1].value;
        if dv == 0.0 || dt <= 0.0 {
            out[i - 1].interp = Interpolation::Linear;
        } else {
            let [x1, y1, _, _] = interp_to_coeffs(out[i - 1].interp);
            let y2 = clamp01(1.0 - (m * dt) / (3.0 * dv));
            out[i - 1].interp = Interpolation::Bezier { p1: (x1, y1), p2: (2.0 / 3.0, y2) };
        }
    }

    Animated::Keyframed(out.into_iter().collect())
}

/// Smooth every key (one whole-track result).
pub fn smooth_all(track: &Animated<f64>) -> Animated<f64> {
    let Animated::Keyframed(kfs) = track else {
        return track.clone();
    };
    let ids: Vec<KeyframeId> = kfs.iter().map(|k| k.id).collect();
    let mut acc = track.clone();
    for id in ids {
        acc = smooth_one(&acc, id);
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kf(id: u128, t_us: i64, value: f64, interp: Interpolation) -> Keyframe<f64> {
        Keyframe { id: uuid::Uuid::from_u128(id), t_us, value, interp }
    }
    fn keyframed(kfs: Vec<Keyframe<f64>>) -> Animated<f64> {
        Animated::Keyframed(kfs.into_iter().collect())
    }
    fn ids(track: &Animated<f64>) -> Vec<KeyframeId> {
        match track {
            Animated::Keyframed(k) => k.iter().map(|x| x.id).collect(),
            Animated::Static(_) => vec![],
        }
    }

    #[test]
    fn upsert_lifts_static() {
        let out = upsert(&Animated::Static(0.5), 1_000_000, 0.9, None);
        let Animated::Keyframed(kfs) = &out else { panic!("lifted") };
        assert_eq!(kfs.len(), 1);
        assert_eq!(kfs[0].t_us, 1_000_000);
        assert!((kfs[0].value - 0.9).abs() < 1e-9);
        assert!(matches!(kfs[0].interp, Interpolation::Linear));
    }

    #[test]
    fn upsert_updates_existing_preserves_id_and_interp() {
        let tr = keyframed(vec![kf(1, 0, 0.0, Interpolation::EaseIn)]);
        let id_before = ids(&tr);
        let out = upsert(&tr, 0, 0.7, None);
        assert_eq!(ids(&out), id_before, "id preserved on in-place update");
        let Animated::Keyframed(kfs) = &out else { panic!() };
        assert!((kfs[0].value - 0.7).abs() < 1e-9);
        assert!(matches!(kfs[0].interp, Interpolation::EaseIn), "interp preserved when None");
    }

    #[test]
    fn upsert_insert_inherits_preceding_interp() {
        let tr = keyframed(vec![
            kf(1, 0, 0.0, Interpolation::EaseIn),
            kf(2, 2_000_000, 1.0, Interpolation::Linear),
        ]);
        let out = upsert(&tr, 1_000_000, 0.5, None);
        let Animated::Keyframed(kfs) = &out else { panic!() };
        assert_eq!(kfs.len(), 3);
        assert_eq!(kfs[1].t_us, 1_000_000);
        assert!(matches!(kfs[1].interp, Interpolation::EaseIn), "inherits preceding key interp");
    }

    #[test]
    fn remove_last_collapses_to_removed_value() {
        let tr = keyframed(vec![kf(1, 0, 0.33, Interpolation::Linear)]);
        let out = remove(&tr, uuid::Uuid::from_u128(1), 999.0);
        assert!(matches!(out, Animated::Static(v) if (v - 0.33).abs() < 1e-9));
    }

    #[test]
    fn retime_resorts() {
        let tr = keyframed(vec![
            kf(1, 0, 0.0, Interpolation::Linear),
            kf(2, 2_000_000, 1.0, Interpolation::Linear),
        ]);
        let out = retime(&tr, uuid::Uuid::from_u128(1), 3_000_000);
        let Animated::Keyframed(kfs) = &out else { panic!() };
        assert_eq!(kfs.iter().map(|k| k.t_us).collect::<Vec<_>>(), vec![2_000_000, 3_000_000]);
        assert!((kfs[1].value - 0.0).abs() < 1e-9, "moved key keeps its value");
    }

    #[test]
    fn smooth_all_equals_fold_of_smooth_one() {
        let tr = keyframed(vec![
            kf(1, 0, 0.0, Interpolation::Linear),
            kf(2, 1_000_000, 1.0, Interpolation::Linear),
            kf(3, 2_000_000, 0.0, Interpolation::Linear),
        ]);
        let folded = {
            let mut acc = tr.clone();
            for id in ids(&tr) {
                acc = smooth_one(&acc, id);
            }
            acc
        };
        let all = smooth_all(&tr);
        let (Animated::Keyframed(a), Animated::Keyframed(b)) = (&all, &folded) else { panic!() };
        for (x, y) in a.iter().zip(b.iter()) {
            assert_eq!(x.interp, y.interp);
        }
    }
}
