//! Transitions between adjacent layers on the same track.
//!
//! A `Transition` authorizes a specific timeline overlap between two layers
//! that the no-overlap invariant would otherwise reject; the overlap span MUST
//! equal `duration_us` so validation can reason about it.
//!
//! Rendering lives in the TS compositor: every kind is a two-input compositor
//! node blending the outgoing and incoming layers over the window — `Crossfade`
//! is the degenerate `mix()` case; `Wipe` and `Slide` add a motion direction.
//!
//! LANDMINE: this module is a deserialize wire contract (same class as
//! `MotifParams`) — the serde JSON shape must exactly mirror the TS model
//! (`src/main/state/model.ts` `TransitionKind`); TS is the sole writer.

use serde::{Deserialize, Serialize};

use super::ids::{LayerId, TransitionId};
use super::time::TimeUs;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transition {
    pub id: TransitionId,
    /// Outgoing layer — the one whose tail overlaps with the incoming layer.
    pub from_layer: LayerId,
    /// Incoming layer — the one whose head overlaps. Renders on top during
    /// the transition window.
    pub to_layer: LayerId,
    /// Length of the transition in timeline microseconds. Must equal the
    /// overlap between `from_layer` and `to_layer`. Enforced in validation.
    pub duration_us: TimeUs,
    pub kind: TransitionKind,
    /// How many µs of the outgoing layer's tail this transition borrowed to
    /// open its overlap; 0 = pure placement overlap (both layers play exactly
    /// their trimmed ranges). Always in `[0, duration_us]`; the TS inverse ops
    /// route by it. Last in the struct because serde field order mirrors the
    /// TS `JSON.stringify` wire order.
    pub extended_us: TimeUs,
}

/// Motion direction (industry convention), NOT the reveal side: `Left` means
/// the wipe boundary sweeps right-to-left, and the slide's incoming layer
/// enters from the right edge moving left. Lowercase on the wire to match the
/// TS `TransitionDirection` union.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransitionDirection {
    Left,
    Right,
    Up,
    Down,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TransitionKind {
    /// Linear blend from `from_layer` to `to_layer` over the window.
    Crossfade,
    /// A hard boundary sweeps the frame in `direction`, revealing `to_layer`.
    Wipe { direction: TransitionDirection },
    /// `to_layer` glides in over `from_layer`, moving in `direction`.
    Slide { direction: TransitionDirection },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Inline JSON literals written exactly as TS `JSON.stringify` emits them
    /// (key order = model.ts field order) — the cross-language contract check.
    #[test]
    fn transition_kinds_deserialize_from_ts_json() {
        let cases: [(&str, TransitionKind); 3] = [
            (
                r#"{"id":"00000000-0000-0000-0000-000000000006","from_layer":"00000000-0000-0000-0000-000000000004","to_layer":"00000000-0000-0000-0000-000000000005","duration_us":1000000,"kind":{"kind":"Crossfade"},"extended_us":1000000}"#,
                TransitionKind::Crossfade,
            ),
            (
                r#"{"id":"00000000-0000-0000-0000-000000000007","from_layer":"00000000-0000-0000-0000-000000000004","to_layer":"00000000-0000-0000-0000-000000000005","duration_us":1000000,"kind":{"kind":"Wipe","direction":"left"},"extended_us":0}"#,
                TransitionKind::Wipe {
                    direction: TransitionDirection::Left,
                },
            ),
            (
                r#"{"id":"00000000-0000-0000-0000-000000000008","from_layer":"00000000-0000-0000-0000-000000000004","to_layer":"00000000-0000-0000-0000-000000000005","duration_us":1000000,"kind":{"kind":"Slide","direction":"up"},"extended_us":500000}"#,
                TransitionKind::Slide {
                    direction: TransitionDirection::Up,
                },
            ),
        ];
        for (json, expected_kind) in cases {
            let tr: Transition = serde_json::from_str(json).expect("deserialize TS JSON");
            assert_eq!(tr.kind, expected_kind);
            assert_eq!(tr.duration_us, 1_000_000);
        }
    }

    #[test]
    fn transition_kind_serde_round_trips_byte_stable() {
        for kind in [
            TransitionKind::Crossfade,
            TransitionKind::Wipe {
                direction: TransitionDirection::Right,
            },
            TransitionKind::Slide {
                direction: TransitionDirection::Down,
            },
        ] {
            let tr = Transition {
                id: crate::state::ids::new_id(),
                from_layer: crate::state::ids::new_id(),
                to_layer: crate::state::ids::new_id(),
                duration_us: 500_000,
                kind,
                extended_us: 200_000,
            };
            let json = serde_json::to_string(&tr).unwrap();
            let back: Transition = serde_json::from_str(&json).unwrap();
            let again = serde_json::to_string(&back).unwrap();
            assert_eq!(json, again, "round-trip JSON should be byte-identical");
            assert_eq!(back, tr);
        }
    }

    /// Every direction value round-trips through its lowercase wire form.
    #[test]
    fn direction_wire_casing_is_lowercase() {
        for (dir, wire) in [
            (TransitionDirection::Left, "\"left\""),
            (TransitionDirection::Right, "\"right\""),
            (TransitionDirection::Up, "\"up\""),
            (TransitionDirection::Down, "\"down\""),
        ] {
            assert_eq!(serde_json::to_string(&dir).unwrap(), wire);
            assert_eq!(
                serde_json::from_str::<TransitionDirection>(wire).unwrap(),
                dir
            );
        }
    }
}
