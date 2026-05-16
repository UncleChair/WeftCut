//! Segment boundary computation for the segmented preview cache (Phase A1).
//!
//! Pure function over `&Project`: walks clip in/out and transition outer
//! bounds, drops boundaries strictly inside transition windows so transitions
//! stay atomic, then splits any range longer than [`MAX_SEGMENT_US`] at
//! fixed-step offsets. Transition-bearing segments are exempt from the cap;
//! transitions are atomic by design — see `docs/preview-segmented-cache.md`
//! decision S3.a.
//!
//! No effect-range boundaries yet: `state/effect.rs` is "Phase 2 scaffolding"
//! and effects have no timeline-range semantics. Add to the boundary set when
//! that lands; the algorithm here doesn't need to change.

use std::collections::{BTreeSet, HashMap};

use crate::state::ids::LayerId;
use crate::state::project::Project;
use crate::state::time::TimeUs;

/// Target maximum segment duration. Ranges longer than this get split at
/// fixed-step offsets from the range start. Transition-bearing ranges are
/// allowed to exceed this — transitions are atomic.
///
/// Decision: 5 seconds — see `docs/preview-segmented-cache.md` decision S2.
pub const MAX_SEGMENT_US: TimeUs = 5_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SegmentRange {
    pub in_us: TimeUs,
    pub out_us: TimeUs,
}

impl SegmentRange {
    pub fn duration_us(&self) -> TimeUs {
        self.out_us - self.in_us
    }
}

/// Compute timeline segment ranges for `project`. Output is sorted,
/// contiguous, non-overlapping, and covers `[0, composition.duration_us]`.
/// Returns an empty Vec when the composition has zero duration.
pub fn compute_segment_boundaries(project: &Project) -> Vec<SegmentRange> {
    let total = project.composition.duration_us;
    if total <= 0 {
        return Vec::new();
    }

    // 1. Hard boundary set from composition + every layer in/out, clamped
    //    to [0, total]. BTreeSet keeps them sorted and unique.
    let mut boundaries: BTreeSet<TimeUs> = BTreeSet::new();
    boundaries.insert(0);
    boundaries.insert(total);
    for track in project.tracks.iter() {
        for layer in track.layers.iter() {
            let start = layer.t_start_us.max(0).min(total);
            let end = layer.t_end_us.max(0).min(total);
            boundaries.insert(start);
            boundaries.insert(end);
        }
    }

    // 2. Compute timeline windows for every transition so we can do the
    //    collapse-and-readd step.
    let transition_windows = transition_windows(project, total);

    // 3. Transition collapse: drop boundaries strictly inside any transition
    //    window, then re-add the transition's outer bounds. Keeps the
    //    transition contained in a single segment.
    for &(t_start, t_end) in &transition_windows {
        boundaries.retain(|&b| b <= t_start || b >= t_end);
        boundaries.insert(t_start);
        boundaries.insert(t_end);
    }

    // 4. Adjacent-pair → range.
    let initial: Vec<SegmentRange> = {
        let sorted: Vec<TimeUs> = boundaries.into_iter().collect();
        sorted
            .windows(2)
            .map(|w| SegmentRange {
                in_us: w[0],
                out_us: w[1],
            })
            .filter(|r| r.out_us > r.in_us)
            .collect()
    };

    // 5. Split any range > MAX_SEGMENT_US at fixed-step offsets, EXCEPT a
    //    range that overlaps a transition window (transitions stay atomic).
    //    Fixed-step (not equal-divisions) so a small trim that shortens the
    //    last sub-segment doesn't shift all earlier sub-segments — the
    //    diff-by-hash optimization depends on stable cut positions.
    let mut out = Vec::with_capacity(initial.len());
    for r in initial {
        if r.duration_us() <= MAX_SEGMENT_US || range_overlaps_any(&r, &transition_windows) {
            out.push(r);
            continue;
        }
        let mut cursor = r.in_us;
        while cursor + MAX_SEGMENT_US < r.out_us {
            let next = cursor + MAX_SEGMENT_US;
            out.push(SegmentRange {
                in_us: cursor,
                out_us: next,
            });
            cursor = next;
        }
        // Tail segment (always ≤ MAX_SEGMENT_US, possibly equal).
        out.push(SegmentRange {
            in_us: cursor,
            out_us: r.out_us,
        });
    }

    out
}

/// Per-transition timeline window `[t_start, t_end]`, clamped to
/// `[0, total]`. Resolves `tr.to_layer` to its timeline start; the transition
/// window is `[to_layer.t_start_us, to_layer.t_start_us + tr.duration_us]`
/// (per `state/transition.rs` — this equals the authorized overlap).
fn transition_windows(project: &Project, total: TimeUs) -> Vec<(TimeUs, TimeUs)> {
    let mut layer_start: HashMap<LayerId, TimeUs> = HashMap::new();
    for track in project.tracks.iter() {
        for layer in track.layers.iter() {
            layer_start.insert(layer.id, layer.t_start_us);
        }
    }
    let mut out = Vec::new();
    for tr in project.transitions.iter() {
        let Some(&to_start) = layer_start.get(&tr.to_layer) else {
            continue;
        };
        let t_start = to_start.max(0).min(total);
        let t_end = (to_start + tr.duration_us).max(0).min(total);
        if t_end > t_start {
            out.push((t_start, t_end));
        }
    }
    out
}

/// True iff `r` shares a strict-interior overlap with any transition window.
/// Touching at an endpoint does NOT count — a range that ends exactly at a
/// transition start is allowed to split (it's adjacent, not containing).
fn range_overlaps_any(r: &SegmentRange, windows: &[(TimeUs, TimeUs)]) -> bool {
    windows
        .iter()
        .any(|&(t_start, t_end)| r.in_us < t_end && t_start < r.out_us)
}

#[cfg(test)]
mod tests {
    use super::*;

    use chrono::Utc;
    use uuid::Uuid;

    use crate::state::animated::Animated;
    use crate::state::color::Rgba;
    use crate::state::ids::new_id;
    use crate::state::layer::{ColorParams, Layer, LayerParams};
    use crate::state::project::Project;
    use crate::state::track::{Track, TrackKind};
    use crate::state::transition::{Transition, TransitionKind};

    fn color_layer(start: TimeUs, end: TimeUs) -> Layer {
        Layer {
            id: new_id(),
            label: None,
            t_start_us: start,
            t_end_us: end,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            effects: imbl::Vector::new(),
            params: LayerParams::Color(ColorParams {
                color: Animated::Static(Rgba::BLACK),
                width: 1920,
                height: 1080,
            }),
        }
    }

    fn project_with_layers(duration_us: TimeUs, layers: Vec<Layer>) -> Project {
        let track = Track {
            id: new_id(),
            kind: TrackKind::Video,
            label: None,
            enabled: true,
            locked: false,
            removable: true,
            role: None,
            transient: false,
            height_px: 64,
            layers: layers.into_iter().collect(),
        };
        let mut p = Project::new_blank("seg-test");
        p.composition.duration_us = duration_us;
        p.tracks.clear();
        p.tracks.push_back(track);
        p
    }

    fn ranges(in_outs: &[(TimeUs, TimeUs)]) -> Vec<SegmentRange> {
        in_outs
            .iter()
            .map(|&(a, b)| SegmentRange { in_us: a, out_us: b })
            .collect()
    }

    #[test]
    fn empty_project_has_no_segments() {
        let p = Project::new_blank("empty");
        assert_eq!(compute_segment_boundaries(&p), Vec::<SegmentRange>::new());
    }

    #[test]
    fn zero_duration_returns_empty() {
        let mut p = Project::new_blank("zero");
        p.composition.duration_us = 0;
        assert_eq!(compute_segment_boundaries(&p), Vec::<SegmentRange>::new());
    }

    #[test]
    fn duration_below_max_with_no_layers_is_one_segment() {
        // 3s composition, no layers. One segment [0, 3s].
        let p = project_with_layers(3_000_000, vec![]);
        assert_eq!(
            compute_segment_boundaries(&p),
            ranges(&[(0, 3_000_000)]),
        );
    }

    #[test]
    fn longer_than_max_splits_at_fixed_step_offsets() {
        // 12s composition, no edits. Fixed-step splits at 5s intervals:
        // [0,5][5,10][10,12].
        let p = project_with_layers(12_000_000, vec![]);
        assert_eq!(
            compute_segment_boundaries(&p),
            ranges(&[(0, 5_000_000), (5_000_000, 10_000_000), (10_000_000, 12_000_000)]),
        );
    }

    #[test]
    fn duration_equal_to_max_does_not_split() {
        // Exactly MAX_SEGMENT_US → single segment.
        let p = project_with_layers(MAX_SEGMENT_US, vec![]);
        assert_eq!(
            compute_segment_boundaries(&p),
            ranges(&[(0, MAX_SEGMENT_US)]),
        );
    }

    #[test]
    fn clip_in_out_introduces_boundaries() {
        // 10s comp; one clip 1s–4s. Boundaries: 0, 1, 4, 10. Ranges:
        //   [0,1] (1s), [1,4] (3s), [4,10] (6s → splits into [4,9][9,10]).
        let clip = color_layer(1_000_000, 4_000_000);
        let p = project_with_layers(10_000_000, vec![clip]);
        assert_eq!(
            compute_segment_boundaries(&p),
            ranges(&[
                (0, 1_000_000),
                (1_000_000, 4_000_000),
                (4_000_000, 9_000_000),
                (9_000_000, 10_000_000),
            ]),
        );
    }

    #[test]
    fn transitions_collapse_interior_boundaries() {
        // Two clips with a 1s crossfade. Clip A: 0–3s, Clip B: 2–5s, transition
        // window [2,3]. Without transition handling we'd have boundaries
        // {0, 2, 3, 5} → ranges [0,2][2,3][3,5]; with handling, the {2,3}
        // boundaries stay (they ARE the transition's outer bounds) but any
        // boundary INSIDE (2,3) would be dropped. Verify no interior
        // boundary survives: add a third clip starting at 2.5 — its
        // boundary at 2.5 should be collapsed away.
        let a = color_layer(0, 3_000_000);
        let b = color_layer(2_000_000, 5_000_000);
        let mid = color_layer(2_500_000, 2_800_000);
        let a_id = a.id;
        let b_id = b.id;
        let mut p = project_with_layers(5_000_000, vec![a, mid, b]);
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a_id,
            to_layer: b_id,
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });

        let segs = compute_segment_boundaries(&p);
        // No interior boundary inside (2,3): 2_500_000 and 2_800_000 must
        // NOT appear as segment endpoints.
        for s in &segs {
            assert!(
                !(s.in_us > 2_000_000 && s.in_us < 3_000_000),
                "interior boundary {} survived collapse: {:?}",
                s.in_us,
                segs,
            );
            assert!(
                !(s.out_us > 2_000_000 && s.out_us < 3_000_000),
                "interior boundary {} survived collapse: {:?}",
                s.out_us,
                segs,
            );
        }
        // The transition window [2,3] must appear as one segment.
        assert!(
            segs.iter().any(|s| s.in_us == 2_000_000 && s.out_us == 3_000_000),
            "transition window [2,3] not preserved as segment: {:?}",
            segs,
        );
    }

    #[test]
    fn transition_exceeding_max_stays_atomic() {
        // 15s comp; transition spans [2, 9] (7s > MAX_SEGMENT_US). The
        // transition segment must NOT be split.
        let a = color_layer(0, 9_000_000);
        let b = color_layer(2_000_000, 15_000_000);
        let a_id = a.id;
        let b_id = b.id;
        let mut p = project_with_layers(15_000_000, vec![a, b]);
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a_id,
            to_layer: b_id,
            duration_us: 7_000_000,
            kind: TransitionKind::Crossfade,
        });

        let segs = compute_segment_boundaries(&p);
        // Find the segment with in_us=2_000_000; it must end at 9_000_000
        // (full transition window) despite being 7s long.
        let tr_seg = segs
            .iter()
            .find(|s| s.in_us == 2_000_000)
            .expect("transition start segment");
        assert_eq!(
            tr_seg.out_us, 9_000_000,
            "transition split despite atomicity: {:?}",
            segs
        );
    }

    #[test]
    fn output_is_contiguous_and_covers_full_duration() {
        // Property check across a non-trivial project.
        let a = color_layer(0, 3_500_000);
        let b = color_layer(7_200_000, 11_300_000);
        let c = color_layer(13_000_000, 14_000_000);
        let p = project_with_layers(20_000_000, vec![a, b, c]);

        let segs = compute_segment_boundaries(&p);
        assert!(!segs.is_empty());
        assert_eq!(segs.first().unwrap().in_us, 0);
        assert_eq!(segs.last().unwrap().out_us, 20_000_000);
        for w in segs.windows(2) {
            assert_eq!(
                w[0].out_us, w[1].in_us,
                "gap between segments: {:?} → {:?}",
                w[0], w[1],
            );
        }
        // No segment exceeds MAX_SEGMENT_US (no transitions in this project).
        for s in &segs {
            assert!(
                s.duration_us() <= MAX_SEGMENT_US,
                "segment over cap: {:?}",
                s
            );
            assert!(s.duration_us() > 0, "empty segment: {:?}", s);
        }
    }

    #[test]
    fn layers_outside_composition_are_clamped() {
        // Layer extending past composition.duration_us should not produce a
        // boundary past the composition end.
        let clip = color_layer(0, 100_000_000); // 100s
        let p = project_with_layers(5_000_000, vec![clip]);
        let segs = compute_segment_boundaries(&p);
        assert_eq!(segs.last().unwrap().out_us, 5_000_000);
    }

    #[test]
    fn dangling_transition_to_missing_layer_is_ignored() {
        // Transition referencing a layer that doesn't exist in the project's
        // tracks must not cause a panic or invalid boundary.
        let a = color_layer(0, 3_000_000);
        let a_id = a.id;
        let mut p = project_with_layers(3_000_000, vec![a]);
        p.transitions.push_back(Transition {
            id: new_id(),
            from_layer: a_id,
            to_layer: new_id(), // not in tracks
            duration_us: 1_000_000,
            kind: TransitionKind::Crossfade,
        });
        // Doesn't panic; produces a valid range list.
        let segs = compute_segment_boundaries(&p);
        assert_eq!(segs.last().unwrap().out_us, 3_000_000);
    }
}
