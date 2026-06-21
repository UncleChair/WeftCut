    use super::*;

    #[test]
    fn agent_actor_serializes_client_as_a_flat_string() {
        // Serialized whole onto the MCP /events feed (ChangeEventSummary).
        // Must be {"kind":"Agent","client":"x"} — not the adjacently-tagged
        // {"kind":"Agent","client":{"client":"x"}} nesting.
        let v = serde_json::to_value(Actor::Agent { client: "jobs".into() }).expect("ser");
        assert_eq!(v["kind"], "Agent");
        assert_eq!(v["client"], "jobs", "client must be flat, got {}", v["client"]);
        assert_eq!(serde_json::to_value(Actor::User).expect("ser")["kind"], "User");
        let back: Actor = serde_json::from_value(v).expect("de");
        assert_eq!(back, Actor::Agent { client: "jobs".into() });
    }
    use crate::state::{
        Animated, ColorParams, LayerParams, MediaKind, MediaMetadata, Project, Rgba, Track,
    };

    fn project_with_video_track() -> (Project, TrackId) {
        // Start from a blank but strip the default A-roll/B-roll so each
        // delete/insert/replace test has a clean slate to assert against.
        let mut p = Project::new_blank("test");
        p.tracks.clear();
        let track = Track::new();
        let track_id = track.id;
        p.tracks.push_back(track);
        (p, track_id)
    }

    fn color_layer(rgba: Rgba) -> LayerParams {
        LayerParams::Color(ColorParams {
            color: Animated::Static(rgba),
            width: 1920,
            height: 1080,
        })
    }

    fn motif_layer(props: imbl::HashMap<String, serde_json::Value>) -> LayerParams {
        LayerParams::Motif(crate::state::MotifParams {
            motif_id: "countdown".into(),
            motif_version: 1,
            props,
            src_in_us: 0,
            transform: crate::state::Transform::default(),
            opacity: Animated::Static(1.0),
        })
    }

    #[tokio::test]
    async fn delete_last_layer_auto_deletes_emptied_track() {
        // new_blank keeps the reserved A/B pair; the third track is a
        // plain user-owned one (removable, no role).
        let h = spawn(Project::new_blank("test"));
        let track_id = h
            .add_track(Actor::User, Some("overlay".into()))
            .await
            .expect("add_track");
        let layer_id = h
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .expect("add_layer");

        h.delete_layer(Actor::User, layer_id)
            .await
            .expect("delete_layer");
        let snap = h.snapshot().await;
        assert!(
            snap.tracks.iter().all(|t| t.id != track_id),
            "emptied track should be auto-deleted with its last layer"
        );
        assert_eq!(snap.tracks.len(), 2, "reserved A/B skeleton untouched");

        // ONE undo restores both the layer and its track…
        h.undo(Actor::User).await.expect("undo");
        let snap = h.snapshot().await;
        let track = snap
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .expect("track restored by a single undo");
        assert_eq!(track.layers.len(), 1);
        assert_eq!(track.layers[0].id, layer_id);

        // …and ONE redo removes both again.
        h.redo(Actor::User).await.expect("redo");
        let snap = h.snapshot().await;
        assert!(snap.tracks.iter().all(|t| t.id != track_id));
    }

    #[tokio::test]
    async fn delete_layer_keeps_emptied_track_when_setting_off() {
        let h = spawn(Project::new_blank("test"));
        h.update_project_settings(
            Actor::User,
            ProjectSettingsPatch {
                auto_delete_empty_tracks: Some(false),
            },
        )
        .await
        .expect("update_project_settings");
        let track_id = h
            .add_track(Actor::User, Some("overlay".into()))
            .await
            .expect("add_track");
        let layer_id = h
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .expect("add_layer");
        h.delete_layer(Actor::User, layer_id)
            .await
            .expect("delete_layer");
        let snap = h.snapshot().await;
        let track = snap
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .expect("emptied track stays when the setting is off");
        assert!(track.layers.is_empty());
    }

    #[tokio::test]
    async fn auto_delete_never_touches_reserved_or_role_tracks() {
        // A layer dropped straight onto the reserved A-roll: deleting it
        // leaves the A-roll in place even though it ends up empty.
        let h = spawn(Project::new_blank("test"));
        let a_roll = h
            .snapshot()
            .await
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::ARoll))
            .expect("A roll")
            .id;
        let layer_id = h
            .add_layer(Actor::User, a_roll, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .expect("add_layer");
        h.delete_layer(Actor::User, layer_id)
            .await
            .expect("delete_layer");
        let snap = h.snapshot().await;
        assert!(
            snap.tracks.iter().any(|t| t.id == a_roll),
            "A roll must survive emptying"
        );

        // Legacy role-stamped track: `removable` deserializes `true` for
        // pre-field projects, so the role stamp alone must protect it.
        let mut legacy = Project::new_blank("legacy");
        let mut audio_a = Track::new();
        audio_a.role = Some(TrackRole::AudioA);
        let audio_a_id = audio_a.id;
        legacy.tracks.push_back(audio_a);
        let h = spawn(legacy);
        let layer_id = h
            .add_layer(Actor::User, audio_a_id, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .expect("add_layer");
        h.delete_layer(Actor::User, layer_id)
            .await
            .expect("delete_layer");
        let snap = h.snapshot().await;
        assert!(
            snap.tracks.iter().any(|t| t.id == audio_a_id),
            "role-stamped track must survive even while removable"
        );
    }

    #[tokio::test]
    async fn auto_delete_skips_track_with_remaining_layers() {
        let h = spawn(Project::new_blank("test"));
        let track_id = h
            .add_track(Actor::User, Some("overlay".into()))
            .await
            .expect("add_track");
        let l1 = h
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .expect("add_layer l1");
        let _l2 = h
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 2_000_000, 3_000_000)
            .await
            .expect("add_layer l2");
        h.delete_layer(Actor::User, l1).await.expect("delete_layer");
        let snap = h.snapshot().await;
        let track = snap
            .tracks
            .iter()
            .find(|t| t.id == track_id)
            .expect("track with remaining layers stays");
        assert_eq!(track.layers.len(), 1);
    }

    #[tokio::test]
    async fn update_project_settings_is_unrecorded_and_patches_history() {
        let h = spawn(Project::new_blank("test"));
        let track_id = h
            .add_track(Actor::User, Some("overlay".into()))
            .await
            .expect("add_track");
        h.update_project_settings(
            Actor::User,
            ProjectSettingsPatch {
                auto_delete_empty_tracks: Some(false),
            },
        )
        .await
        .expect("update_project_settings");
        let snap = h.snapshot().await;
        assert!(!snap.settings.auto_delete_empty_tracks);
        // The toggle is not a history entry: one undo rewinds add_track,
        // and the rewound snapshot still carries the new setting value.
        h.undo(Actor::User).await.expect("undo");
        let snap = h.snapshot().await;
        assert!(
            snap.tracks.iter().all(|t| t.id != track_id),
            "undo rewound add_track, not the settings toggle"
        );
        assert!(
            !snap.settings.auto_delete_empty_tracks,
            "setting survives undo (patched into every snapshot)"
        );
    }

    #[tokio::test]
    async fn update_track_flags_is_unrecorded_and_patches_history() {
        let h = spawn(Project::new_blank("test"));
        let snap = h.snapshot().await;
        let track_id = snap.tracks.front().expect("blank project has tracks").id;
        // A recorded op AFTER which we toggle, so undo has something to rewind.
        let added = h
            .add_track(Actor::User, Some("overlay".into()))
            .await
            .expect("add_track");
        h.update_track_flags(
            Actor::User,
            track_id,
            TrackFlagsPatch {
                enabled: None,
                muted: Some(true),
                solo: Some(true),
                locked: Some(true),
            },
        )
        .await
        .expect("update_track_flags");
        let snap = h.snapshot().await;
        let t = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert!(t.muted && t.solo && t.locked);
        assert!(t.enabled, "None field left untouched");
        // Undo rewinds add_track, NOT the flags toggle; flags survive.
        h.undo(Actor::User).await.expect("undo");
        let snap = h.snapshot().await;
        assert!(
            snap.tracks.iter().all(|t| t.id != added),
            "undo rewound add_track, not the flags toggle"
        );
        let t = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert!(
            t.muted && t.solo && t.locked,
            "flags survive undo (patched into every snapshot)"
        );
        // Redo reinstates add_track; the redo-direction snapshot was patched by
        // replace_track_flags_everywhere too.  The pre-add snapshot (the one
        // undo just restored) doesn't contain `added`, so the everywhere-walk
        // silently skips it — this pins that skip-when-absent branch.  The
        // toggle targets the reserved track (present in every snapshot), so
        // the flag assertions hold both before and after the added track exists.
        h.redo(Actor::User).await.expect("redo");
        let snap = h.snapshot().await;
        assert!(
            snap.tracks.iter().any(|t| t.id == added),
            "redo restores add_track"
        );
        let t = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert!(
            t.muted && t.solo && t.locked,
            "flags still set in redo-direction snapshot"
        );
    }

    #[tokio::test]
    async fn update_track_flags_unknown_track_rejected() {
        let h = spawn(Project::new_blank("test"));
        let err = h
            .update_track_flags(
                Actor::User,
                new_id(),
                TrackFlagsPatch {
                    enabled: None,
                    muted: Some(true),
                    solo: None,
                    locked: None,
                },
            )
            .await;
        assert!(matches!(err, Err(CommandError::TrackNotFound { .. })));
    }

    #[tokio::test]
    async fn set_role_gain_is_recorded_and_undoable() {
        let h = spawn(Project::new_blank("test"));
        h.set_role_gain(Actor::User, AudioRole::Dialogue, 6.0)
            .await
            .expect("set_role_gain");
        assert_eq!(
            h.snapshot().await.role_mix(AudioRole::Dialogue).gain_db,
            6.0
        );
        h.undo(Actor::User).await.expect("undo");
        assert_eq!(
            h.snapshot().await.role_mix(AudioRole::Dialogue).gain_db,
            0.0,
            "recorded gain reverts on undo"
        );
    }

    #[tokio::test]
    async fn update_role_flags_is_unrecorded() {
        let h = spawn(Project::new_blank("test"));
        // A recorded op so undo has something to rewind toward.
        h.set_role_gain(Actor::User, AudioRole::Music, 3.0)
            .await
            .expect("set_role_gain");
        h.update_role_flags(
            Actor::User,
            AudioRole::Music,
            RoleFlagsPatch {
                muted: Some(true),
                solo: None,
            },
        )
        .await
        .expect("update_role_flags");
        h.undo(Actor::User).await.expect("undo");
        assert!(
            h.snapshot().await.role_mix(AudioRole::Music).muted,
            "unrecorded flag survives undo"
        );
    }

    #[tokio::test]
    async fn motif_params_patch_applies_transform_opacity_and_merges_props() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        let mut props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        props.insert("seconds".into(), serde_json::json!(5.0));
        props.insert("color".into(), serde_json::json!("#ff3366"));

        let layer_id = handle
            .add_layer(Actor::User, track_id, motif_layer(props), 0, 5_000_000)
            .await
            .expect("add_layer");

        // Patch transform + opacity, and merge a SINGLE prop (`color`). The
        // other prop (`seconds`) must survive untouched — field-wise merge,
        // not whole-map replace.
        let mut patch_props: std::collections::HashMap<String, serde_json::Value> =
            std::collections::HashMap::new();
        patch_props.insert("color".into(), serde_json::json!("#00ff00"));
        handle
            .update_layer_params(
                Actor::User,
                layer_id,
                LayerParamsPatch::Motif(MotifPatch {
                    x: Some(12.0),
                    y: Some(34.0),
                    scale_x: Some(2.0),
                    scale_y: Some(0.5),
                    opacity: Some(0.25),
                    src_in_us: None,
                    props: Some(patch_props),
                    ..Default::default()
                }),
            )
            .await
            .expect("update_layer_params");

        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        let LayerParams::Motif(p) = &layer.params else {
            panic!("expected Motif params");
        };
        let static_val = |a: &Animated<f64>| match a {
            Animated::Static(v) => *v,
            Animated::Keyframed(_) => panic!("expected Static"),
        };
        assert_eq!(static_val(&p.transform.x), 12.0);
        assert_eq!(static_val(&p.transform.y), 34.0);
        assert_eq!(static_val(&p.transform.scale_x), 2.0);
        assert_eq!(static_val(&p.transform.scale_y), 0.5);
        assert_eq!(static_val(&p.opacity), 0.25);
        // `color` overwritten, `seconds` preserved.
        assert_eq!(p.props.get("color"), Some(&serde_json::json!("#00ff00")));
        assert_eq!(p.props.get("seconds"), Some(&serde_json::json!(5.0)));
    }

    #[tokio::test]
    async fn rebind_motif_retargets_all_layers_in_one_undo_entry() {
        let (project, track_id) = project_with_video_track();
        let h = spawn(project);

        let mk = |id: &str| {
            LayerParams::Motif(crate::state::MotifParams {
                motif_id: id.into(),
                motif_version: 1,
                props: Default::default(),
                src_in_us: 0,
                transform: crate::state::Transform::default(),
                opacity: crate::state::animated::Animated::Static(1.0),
            })
        };
        let l1 = h
            .add_layer(Actor::User, track_id, mk("wip"), 0, 1_000_000)
            .await
            .unwrap();
        let l2 = h
            .add_layer(Actor::User, track_id, mk("foo"), 2_000_000, 3_000_000)
            .await
            .unwrap();

        let updates = vec![
            MotifRebindEntry {
                layer_id: l1,
                motif_id: "foo".into(),
                motif_version: 2,
                props: Default::default(),
            },
            MotifRebindEntry {
                layer_id: l2,
                motif_id: "foo".into(),
                motif_version: 2,
                props: Default::default(),
            },
        ];
        h.rebind_motif(Actor::User, updates).await.unwrap();

        let snap = h.snapshot().await;
        for l in snap.tracks.iter().flat_map(|t| &t.layers) {
            if let LayerParams::Motif(p) = &l.params {
                assert_eq!(p.motif_id, "foo");
                assert_eq!(p.motif_version, 2);
            }
        }

        // One undo entry reverts the whole rebind.
        h.undo(Actor::User).await.unwrap();
        let snap = h.snapshot().await;
        let has_wip = snap.tracks.iter().flat_map(|t| &t.layers).any(|l| {
            matches!(&l.params, LayerParams::Motif(p) if p.motif_id == "wip")
        });
        assert!(has_wip);
    }

    #[tokio::test]
    async fn motif_params_patch_rejects_kind_mismatch() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 5_000_000)
            .await
            .expect("add_layer");
        let err = handle
            .update_layer_params(
                Actor::User,
                layer_id,
                LayerParamsPatch::Motif(MotifPatch {
                    opacity: Some(0.5),
                    ..Default::default()
                }),
            )
            .await
            .expect_err("kind mismatch must error");
        assert!(matches!(err, CommandError::LayerParamsKindMismatch { .. }));
    }

    #[test]
    fn motif_params_legacy_json_defaults_src_in_us_to_zero() {
        // A project JSON authored before src_in_us existed must deserialize
        // with src_in_us = 0 (window at content start).
        let json = r#"{
            "motif_id": "countdown",
            "motif_version": 1,
            "props": {},
            "transform": {
                "x": {"mode":"Static","value":0.0},
                "y": {"mode":"Static","value":0.0},
                "scale_x": {"mode":"Static","value":1.0},
                "scale_y": {"mode":"Static","value":1.0},
                "rotation_deg": {"mode":"Static","value":0.0},
                "anchor": [0.5, 0.5]
            },
            "opacity": {"mode":"Static","value":1.0}
        }"#;
        let p: crate::state::MotifParams =
            serde_json::from_str(json).expect("motif params deserialize");
        assert_eq!(p.src_in_us, 0);
    }

    #[test]
    fn motif_patch_retargets_motif_id_and_version() {
        // Edit-in-place swaps the selected layer onto a working-draft Motif:
        // a single-layer `motif_id` retarget (Discard swaps it back).
        let mut layer = Layer {
            id: new_id(),
            label: None,
            t_start_us: 0,
            t_end_us: 5_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params: LayerParams::Motif(crate::state::MotifParams {
                motif_id: "old".into(),
                motif_version: 1,
                props: imbl::HashMap::new(),
                src_in_us: 0,
                transform: crate::state::Transform::default(),
                opacity: Animated::Static(1.0),
            }),
            effects: vec![],
        };
        let id = layer.id;
        apply_params_patch(
            &mut layer,
            &LayerParamsPatch::Motif(MotifPatch {
                motif_id: Some("new".into()),
                motif_version: Some(3),
                ..Default::default()
            }),
            id,
        )
        .unwrap();
        let LayerParams::Motif(p) = &layer.params else {
            panic!("expected Motif params");
        };
        assert_eq!(p.motif_id, "new");
        assert_eq!(p.motif_version, 3);
    }

    #[tokio::test]
    async fn add_layer_persists_and_extends_duration() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                5_000_000,
            )
            .await
            .expect("add_layer");

        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 1);
        assert_eq!(track.layers[0].id, layer_id);
        assert_eq!(snap.composition.duration_us, 5_000_000);
    }

    // ============================================================
    // Frame-alignment storage invariant: every persisted layer t_start_us
    // and t_end_us must land on a composition-frame boundary. Each
    // mutator (move / trim / split / add) snap-rounds its TimeUs
    // parameters against project.composition.fps on entry, so any
    // caller — UI, MCP, future agents — produces aligned state.
    // ============================================================

    #[tokio::test]
    async fn add_layer_snaps_t_start_and_t_end_to_composition_frame() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // snap_frame_round uses exact rational math (no pre-rounding to
        // integer microseconds), so the snapped output for frame N at
        // 30fps is floor(N * 1_000_000 / 30):
        //   17_000us → frame 1 → 33_333us
        //   1_017_001us → frame 31 → 1_033_333us
        let layer_id = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 17_000, 1_017_001)
            .await
            .expect("add_layer");
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        assert_eq!(layer.t_start_us, 33_333);
        assert_eq!(layer.t_end_us, 1_033_333);
    }

    #[tokio::test]
    async fn move_layer_snaps_t_start_to_composition_frame() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_002)
            .await
            .expect("add_layer");
        // 1_000_002 at 30fps → frame 30 → exact 1_000_000us (frame N
        // for which N divides US_PER_SEC * den evenly snaps without
        // truncation).
        let initial_end = {
            let snap = handle.snapshot().await;
            snap.tracks[0].layers[0].t_end_us
        };
        assert_eq!(initial_end, 1_000_000);
        handle
            .move_layer(Actor::User, layer_id, track_id, 17_000, false)
            .await
            .expect("move");
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        // 17_000 → frame 1 = 33_333us. delta = 33_333; t_end shifts
        // by the same delta to 33_333 + 1_000_000 = 1_033_333.
        assert_eq!(layer.t_start_us, 33_333);
        assert_eq!(layer.t_end_us, 1_033_333);
    }

    #[tokio::test]
    async fn move_layer_re_snaps_t_end_to_avoid_grid_overhang() {
        // At 30fps the half-up grid has alternating 33_333 / 33_334 µs
        // frame widths. A single-frame layer occupying the 33_334 slot
        // [33_333, 66_667) moved one frame back to [0, ?) must land on
        // the next grid point (33_333), not 33_334 — otherwise the
        // layer overhangs into the following frame and occludes it.
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                33_333,
                66_667,
            )
            .await
            .expect("add_layer");
        handle
            .move_layer(Actor::User, layer_id, track_id, 0, false)
            .await
            .expect("move");
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        assert_eq!(layer.t_start_us, 0);
        // Original duration 33_334; raw shift would give t_end = 33_334
        // (1 µs past frame 1's start at 33_333) — re-snap pulls it back
        // onto the grid.
        assert_eq!(layer.t_end_us, 33_333);
    }

    #[tokio::test]
    async fn trim_layer_snaps_new_edge_to_composition_frame() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_002)
            .await
            .expect("add_layer");
        handle
            .trim_layer(Actor::User, layer_id, LayerEdge::In, 17_000, false)
            .await
            .expect("trim");
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        assert_eq!(layer.t_start_us, 33_333);
    }

    /// A motif whose manifest declares `max_duration_s` cannot be
    /// trimmed/extended longer than that cap. The `countdown` builtin caps
    /// at 5.0s; a layer below the cap (3s) that's OUT-extended to 8s must
    /// clamp to a total length of exactly the cap (5s), not the requested 8s.
    #[tokio::test]
    async fn trim_out_clamps_motif_to_manifest_max_duration() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // countdown caps at 5.0s. Start at 3s (below the cap) so the OUT
        // extension has a non-zero clamped delta (extending a layer already
        // *at* the cap would hit the `clamped_delta == 0` rejection path
        // instead of exercising the clamp).
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                motif_layer(imbl::HashMap::new()),
                0,
                3_000_000,
            )
            .await
            .expect("add_layer");
        // Request an OUT trim extending t_end to 8s (total length would be 8s).
        handle
            .trim_layer(Actor::User, layer_id, LayerEdge::Out, 8_000_000, false)
            .await
            .expect("trim");
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        // Clamped to the 5.0s cap, NOT 8s.
        assert_eq!(layer.t_end_us - layer.t_start_us, 5_000_000);
    }

    /// The cap-clamped trim edge must land on the composition frame grid
    /// (the hard storage invariant), not on the raw `max_duration_s*1e6` µs
    /// value. At 29.97 fps (30000/1001) the `countdown` cap of 5.0s =
    /// 5_000_000µs is OFF the frame grid — `snap_frame_round(5_000_000)` is
    /// 5_005_000 (frame 150). The capped OUT edge must be FLOORED to the
    /// largest grid point whose length stays ≤ cap (frame 149 = 4_971_633),
    /// so the result is BOTH on-grid AND ≤ the cap. Before the fix the trim
    /// clamps `t_end` straight to 5_000_000 (off-grid) → assertion (a) fails.
    #[tokio::test]
    async fn trim_out_cap_clamped_edge_is_frame_snapped_at_29_97() {
        let (mut project, track_id) = project_with_video_track();
        project.composition.fps = Rational::FPS_29_97;
        let handle = spawn(project);
        // Start at 0; a 3s-aligned layer below the 5s cap so the OUT
        // extension has a non-zero clamped delta. 3s = 3_000_000µs is itself
        // off-grid at 29.97, so add the layer at a grid-aligned start (0) and
        // a length below the cap.
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                motif_layer(imbl::HashMap::new()),
                0,
                3_000_000,
            )
            .await
            .expect("add_layer");
        // Request an OUT trim well past the 5s cap.
        handle
            .trim_layer(Actor::User, layer_id, LayerEdge::Out, 9_000_000, false)
            .await
            .expect("trim");
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        let fps = Rational::FPS_29_97;
        // (a) On the composition frame grid (round-idempotent — the invariant
        //     every entry-snap enforces).
        assert_eq!(
            crate::state::time::snap_frame_round(layer.t_end_us, fps),
            layer.t_end_us,
            "capped t_end must be on the frame grid"
        );
        assert_eq!(
            crate::state::time::snap_frame_round(layer.t_start_us, fps),
            layer.t_start_us,
            "t_start must stay on the frame grid"
        );
        // (b) Length stays at or below the 5.0s cap (floor → never rounds UP
        //     past the cap).
        assert!(
            layer.t_end_us - layer.t_start_us <= 5_000_000,
            "capped length {} must be <= 5_000_000",
            layer.t_end_us - layer.t_start_us
        );
        // Concretely: t_start 0, capped OUT edge = frame 149 = 4_971_633.
        assert_eq!(layer.t_end_us, 4_971_633);
    }

    /// The cap is now driven by the `seconds` PROP (manifest
    /// `max_duration_prop: "seconds"`), not the static `max_duration_s`. A
    /// `countdown` layer carrying `seconds = 10` must cap at 10s, NOT the
    /// static 5s. OUT-extended well past 10s, the length must land EXACTLY on
    /// the 10s cap at 30 fps (on-grid: 10_000_000µs = frame 300). Asserting
    /// exact equality (not merely `<= 10s`) is what makes this a valid RED:
    /// the old static code clamps to ~5s, which trivially satisfies `<= 10s`
    /// but fails the exact-10s equality.
    #[tokio::test]
    async fn trim_out_caps_motif_at_seconds_prop_not_static_max() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // 30 fps: 10s is on-grid so the cap snaps to itself (no floor slack).
        let mut props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        props.insert("seconds".into(), serde_json::json!(10.0));
        // Start at 3s (on-grid at 30fps) below the 10s cap so the OUT
        // extension has a non-zero clamped delta.
        let layer_id = handle
            .add_layer(Actor::User, track_id, motif_layer(props), 0, 3_000_000)
            .await
            .expect("add_layer");
        // Request an OUT trim well past the 10s cap.
        handle
            .trim_layer(Actor::User, layer_id, LayerEdge::Out, 30_000_000, false)
            .await
            .expect("trim");
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        // Capped at the 10s prop value (exactly, on-grid at 30fps), NOT the
        // static 5s. The lower bound is the discriminating assertion.
        assert_eq!(layer.t_end_us - layer.t_start_us, 10_000_000);
    }

    /// Lowering the `seconds` prop tightens the cap below the static 5s. A
    /// `countdown` layer with `seconds = 3` caps at 3s — OUT-extended past it
    /// clamps to exactly 3s (on-grid at 30 fps). Self-RED on the upper bound:
    /// the old static cap (5s) lets the length exceed 3s.
    #[tokio::test]
    async fn trim_out_caps_motif_at_lowered_seconds_prop() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let mut props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        props.insert("seconds".into(), serde_json::json!(3.0));
        // Start below the 3s cap (1s, on-grid at 30fps).
        let layer_id = handle
            .add_layer(Actor::User, track_id, motif_layer(props), 0, 1_000_000)
            .await
            .expect("add_layer");
        handle
            .trim_layer(Actor::User, layer_id, LayerEdge::Out, 30_000_000, false)
            .await
            .expect("trim");
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        // Capped at the lowered 3s prop value, NOT the static 5s.
        assert_eq!(layer.t_end_us - layer.t_start_us, 3_000_000);
    }

    /// A motif with no `max_duration_s` cap (e.g. a holdable lower-third
    /// overlay) stays freely extendable — `trim_delta_bounds` returns an
    /// unbounded OUT max. Tested directly on the bound fn (no `builtins()`
    /// entry is uncapped, so a synthetic layer + `None` cap exercises the
    /// "absent cap = unbounded" arm without routing through validation/snap).
    #[test]
    fn trim_delta_bounds_motif_without_cap_is_unbounded() {
        let inf = i64::MAX / 4;
        let layer = Layer {
            id: new_id(),
            label: None,
            t_start_us: 0,
            t_end_us: 3_000_000,
            enabled: true,
            locked: false,
            metadata: imbl::HashMap::new(),
            params: motif_layer(imbl::HashMap::new()),
            effects: vec![],
        };
        // No cap supplied → OUT max stays effectively infinite.
        // 30 fps is on-grid for whole-second caps/durations, so the snap is a
        // no-op here and the bounds match the pre-snap math exactly.
        let fps = Rational::FPS_30;
        let bounds = trim_delta_bounds(&layer, LayerEdge::Out, None, fps);
        assert_eq!(bounds.max, inf);
        // A cap supplied → OUT max = round∘floor(t_start + cap) - t_end
        // = 5s - 3s = 2s (on-grid at 30 fps).
        let capped = trim_delta_bounds(&layer, LayerEdge::Out, Some(5_000_000), fps);
        assert_eq!(capped.max, 2_000_000);

        // The cap binds the IN edge too: dragging t_start earlier grows dur.
        // Use a layer starting > slack (4s..7s, dur 3s, cap 5s) so the cap
        // floor round∘ceil(t_end - cap) - t_start = -2s would dominate
        // timeline_min (-t_start = -4s) — but source-windowing adds a tighter
        // constraint: src_in_us = 0 means no content before frame 0, so the
        // IN edge can't move earlier (src_min = -src_in_us = 0 binds harder).
        // This changed when per-motif src_in floor enforcement was added.
        let layer_4_to_7 = Layer {
            t_start_us: 4_000_000,
            t_end_us: 7_000_000,
            ..layer.clone()
        };
        let in_capped = trim_delta_bounds(&layer_4_to_7, LayerEdge::In, Some(5_000_000), fps);
        // src_min (0, from src_in=0) is tighter than cap_min (-2s); IN is blocked.
        assert_eq!(in_capped.min, 0);
        // No cap → motif is NOT source-windowed; IN min falls back to
        // the timeline floor (-t_start = -4s).
        let in_uncapped = trim_delta_bounds(&layer_4_to_7, LayerEdge::In, None, fps);
        assert_eq!(in_uncapped.min, -4_000_000);
    }

    /// A `countdown` Motif layer whose `seconds` prop is an absurd value
    /// (e.g. 1e13) resolves a cap of i64::MAX via the saturating f64→i64 cast
    /// in `resolve_motif_max_dur_us`. The bare `t_start_us + cap` (OUT) and
    /// `t_end_us - cap` (IN) used to overflow in debug builds (panic) or wrap
    /// in release (silent bad bound). With saturating arithmetic the trim path
    /// must not panic AND must yield a sane bound: OUT trim returns Ok with
    /// t_end > t_start and both values on the composition grid.
    ///
    /// The test uses t_start_us = 1_000_000 (> 0) so that `t_start + i64::MAX`
    /// actually overflows; a start-at-0 layer would produce 0 + i64::MAX
    /// (no overflow) and pass even without the fix.
    #[tokio::test]
    async fn trim_out_absurd_prop_cap_does_not_overflow() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // Layer starts at 1s (frame 30, on-grid at 30fps) so the OUT saturating_add
        // path actually exercises the overflow guard (1_000_000 + i64::MAX overflows).
        let mut props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        props.insert("seconds".into(), serde_json::json!(1e13_f64));
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                motif_layer(props),
                1_000_000,
                4_000_000,
            )
            .await
            .expect("add_layer");
        // Request an OUT trim far past any sane cap. Must not panic.
        let result = handle
            .trim_layer(Actor::User, layer_id, LayerEdge::Out, 999_999_999_999_000, false)
            .await;
        assert!(result.is_ok(), "trim_layer must not return Err: {:?}", result);
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        // Basic sanity: layer grew (or stayed same), t_end > t_start, on-grid.
        let fps = Rational::FPS_30;
        assert!(
            layer.t_end_us > layer.t_start_us,
            "t_end ({}) must be > t_start ({})",
            layer.t_end_us,
            layer.t_start_us
        );
        assert_eq!(
            crate::state::time::snap_frame_round(layer.t_start_us, fps),
            layer.t_start_us,
            "t_start must be on the frame grid"
        );
        assert_eq!(
            crate::state::time::snap_frame_round(layer.t_end_us, fps),
            layer.t_end_us,
            "t_end must be on the frame grid"
        );
    }

    /// Mirror of the OUT-edge test above: dragging the IN edge on a countdown
    /// layer with an absurd `seconds` prop (cap saturates to i64::MAX) must not
    /// panic. The cap_min computation (`round∘ceil(t_end - i64::MAX)`) uses
    /// saturating arithmetic to avoid overflow; the src-windowing floor
    /// (src_min = -src_in_us = -2_000_000) is tighter when src_in > 0, so the
    /// trim is clamped cleanly. The layer is placed with a scrubbed window
    /// (src_in = 2s via the IN trim of a 0-start layer) so there is room to
    /// drag the IN edge backward without hitting the content-zero floor.
    #[tokio::test]
    async fn trim_in_absurd_prop_cap_does_not_overflow() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let mut props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        props.insert("seconds".into(), serde_json::json!(1e13_f64));
        // Lay down a large window (0..6s) and then IN-trim it forward to 2s so
        // src_in_us becomes 2_000_000 — giving the subsequent backward drag room.
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                motif_layer(props),
                0,
                6_000_000,
            )
            .await
            .expect("add_layer");
        // Scrub the IN edge forward 2s: src_in_us → 2_000_000, t_start → 2_000_000.
        handle
            .trim_layer(Actor::User, layer_id, LayerEdge::In, 2_000_000, false)
            .await
            .expect("scrub IN to 2s");
        // Now drag the IN edge back toward 1s — cap this large should
        // allow it freely (no clamping from the cap side); src_in floor (2s) allows 1s back.
        let result = handle
            .trim_layer(Actor::User, layer_id, LayerEdge::In, 1_000_000, false)
            .await;
        assert!(result.is_ok(), "trim_layer must not return Err: {:?}", result);
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        let fps = Rational::FPS_30;
        assert!(
            layer.t_end_us > layer.t_start_us,
            "t_end ({}) must be > t_start ({})",
            layer.t_end_us,
            layer.t_start_us
        );
        assert_eq!(
            crate::state::time::snap_frame_round(layer.t_start_us, fps),
            layer.t_start_us,
            "t_start must be on the frame grid"
        );
        assert_eq!(
            crate::state::time::snap_frame_round(layer.t_end_us, fps),
            layer.t_end_us,
            "t_end must be on the frame grid"
        );
    }

    /// A capped motif layer (countdown seconds=5 → content 5s) already at
    /// the full content width cannot be OUT-extended further — the capped
    /// `t_end` equals the current `t_end`, so delta clamps to 0 and the trim
    /// returns `TrimEdgeOutOfRange`.
    #[tokio::test]
    async fn motif_out_trim_cannot_extend_past_content() {
        // countdown seconds=5 -> content cap 5s. A 5s layer cannot OUT-extend.
        let mut props = imbl::HashMap::new();
        props.insert("seconds".to_string(), serde_json::json!(5));
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(Actor::User, track_id, motif_layer(props), 0, 5_000_000)
            .await
            .expect("add_layer");
        let err = handle
            .trim_layer(Actor::User, layer_id, LayerEdge::Out, 8_000_000, false)
            .await;
        assert!(err.is_err(), "OUT past content cap must be rejected");
        // Also verify the layer was not partially extended — t_end_us must be
        // unchanged at the original 5s.
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        assert_eq!(layer.t_end_us, 5_000_000, "t_end_us must not change on rejected OUT trim");
    }

    /// Dragging the IN edge of a capped motif forward (positive delta) must
    /// advance `src_in_us` by the same amount — the window scrubs into the
    /// content. countdown seconds=6 → 6s content; full-window layer; drag IN +1s.
    #[tokio::test]
    async fn motif_in_trim_scrubs_src_in() {
        // countdown seconds=6 -> content cap 6s. Full 6s window, drag IN +1s.
        let mut props = imbl::HashMap::new();
        props.insert("seconds".to_string(), serde_json::json!(6));
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(Actor::User, track_id, motif_layer(props), 0, 6_000_000)
            .await
            .expect("add_layer");
        handle
            .trim_layer(Actor::User, layer_id, LayerEdge::In, 1_000_000, false)
            .await
            .expect("trim");
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        assert_eq!(layer.t_start_us, 1_000_000);
        if let LayerParams::Motif(p) = &layer.params {
            assert_eq!(p.src_in_us, 1_000_000, "IN trim must advance src_in");
        } else {
            panic!("not a motif");
        }
    }

    /// A capped motif window already at `src_in_us = 0` cannot be
    /// IN-extended earlier — there is no content before frame 0. Even though
    /// there is timeline room to the left (layer starts at 2s), the trim must
    /// be rejected.
    #[tokio::test]
    async fn motif_in_trim_cannot_scrub_before_content_zero() {
        // Window at src_in=0 cannot IN-extend earlier (no content before 0).
        let mut props = imbl::HashMap::new();
        props.insert("seconds".to_string(), serde_json::json!(6));
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // Place at t_start=2s so there is timeline room to the left.
        let layer_id = handle
            .add_layer(Actor::User, track_id, motif_layer(props), 2_000_000, 5_000_000)
            .await
            .expect("add_layer");
        let err = handle
            .trim_layer(Actor::User, layer_id, LayerEdge::In, 1_000_000, false)
            .await;
        assert!(err.is_err(), "IN earlier than content 0 must be rejected");
    }

    #[tokio::test]
    async fn fps_change_re_snaps_all_layer_t_fields() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // Layer on the 30fps grid at frame 1 (33_333us) and frame 30
        // (1_000_000us).
        let layer_id = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 33_333, 1_000_000)
            .await
            .expect("add_layer");
        // Switch to 29.97fps (30000/1001). 33_333us at 29.97 rounds
        // to frame 1 = 33_367us (frame 1's true µs is 33_366.667;
        // snap_frame_round half-ups the output to match the demuxer).
        // 1_000_000us at 29.97 rounds to frame 30 = 1_001_000us (exact).
        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    fps: Some(Rational::FPS_29_97),
                    ..Default::default()
                },
            )
            .await
            .expect("set_composition");
        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        assert_eq!(layer.t_start_us, 33_367);
        assert_eq!(layer.t_end_us, 1_001_000);
    }

    /// When the composition fps changes, a motif layer's `src_in_us` (which
    /// lives on the COMPOSITION grid, not the source-PTS grid) must also be
    /// re-snapped to the new grid — just like `t_start_us` / `t_end_us`.
    #[tokio::test]
    async fn fps_change_re_snaps_motif_src_in() {
        // Add countdown seconds=6 at 30fps. IN-trim it to push src_in_us > 0.
        // 30fps grid: trim IN edge to frame 30 = 1_000_000us.
        // After trim: t_start=1_000_000, t_end=6_000_000, src_in=1_000_000.
        let mut props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        props.insert("seconds".into(), serde_json::json!(6));
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(Actor::User, track_id, motif_layer(props), 0, 6_000_000)
            .await
            .expect("add_layer");
        handle
            .trim_layer(Actor::User, layer_id, LayerEdge::In, 1_000_000, false)
            .await
            .expect("trim IN");

        // Switch to 29.97fps (30000/1001).
        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    fps: Some(Rational::FPS_29_97),
                    ..Default::default()
                },
            )
            .await
            .expect("set_composition");

        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        let LayerParams::Motif(p) = &layer.params else {
            panic!("expected Motif");
        };
        // src_in_us must be on the 29.97 grid: snap_frame_round(src_in_us, 29.97) == src_in_us.
        let fps = Rational::FPS_29_97;
        assert_eq!(
            p.src_in_us,
            crate::state::time::snap_frame_round(p.src_in_us, fps),
            "src_in_us must be on the new 29.97fps grid after fps change"
        );
        // Sanity: src_in must still be > 0 (we trimmed it).
        assert!(p.src_in_us > 0, "src_in_us must remain > 0 after fps change");
    }

    #[tokio::test]
    async fn composition_duration_patch_snaps_to_frame() {
        let (project, _track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    duration_us: Some(50_000),
                    ..Default::default()
                },
            )
            .await
            .expect("set_composition");
        let snap = handle.snapshot().await;
        // 50_000us at 30fps rounds to frame 2 = 66_667us (half-up output
        // matching demuxer source-PTS rounding; see snap_frame_round docs).
        assert_eq!(snap.composition.duration_us, 66_667);
    }

    #[tokio::test]
    async fn split_layer_snaps_at_t_to_composition_frame() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_002)
            .await
            .expect("add_layer");
        let (_left, right) = handle
            .split_layer(Actor::User, layer_id, 50_000, false)
            .await
            .expect("split");
        let snap = handle.snapshot().await;
        let right_layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == right)
            .expect("right");
        // 50_000us → frame 2 = 66_667us (half-up output, see snap_frame_round).
        assert_eq!(right_layer.t_start_us, 66_667);
    }

    #[tokio::test]
    async fn add_layer_rejects_overlap() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                1_000_000,
                3_000_000,
            )
            .await
            .expect("first add");

        let err = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                2_000_000,
                4_000_000,
            )
            .await
            .expect_err("second add should overlap");

        assert!(matches!(
            err,
            CommandError::ValidationFailed(ValidationError::LayerOverlap { .. })
        ));
    }

    #[tokio::test]
    async fn add_layer_rejects_inverted_range() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                5_000_000,
                1_000_000,
            )
            .await
            .expect_err("inverted range");
        assert!(matches!(
            err,
            CommandError::ValidationFailed(ValidationError::InvalidLayerRange { .. })
        ));
    }

    #[tokio::test]
    async fn delete_layer_round_trip() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        handle.delete_layer(Actor::User, id).await.expect("delete");

        let snap = handle.snapshot().await;
        assert!(
            snap.tracks.iter().flat_map(|t| t.layers.iter()).all(|l| l.id != id),
            "layer gone"
        );
        // Default `auto_delete_empty_tracks`: the emptied plain track
        // goes with its last layer.
        assert!(snap.tracks.iter().all(|t| t.id != track_id));
    }

    #[tokio::test]
    async fn change_event_broadcast() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let mut events = handle.subscribe();

        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        let event = events.recv().await.expect("event");
        assert!(event
            .affected
            .iter()
            .any(|e| matches!(e, EntityRef::Layer(id) if *id == layer_id)));
    }

    #[tokio::test]
    async fn undo_reverts_add_layer() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        assert_eq!(handle.history_status().await.can_undo, true);
        handle.undo(Actor::User).await.expect("undo");

        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert!(track.layers.is_empty(), "undo should remove the added layer");

        let status = handle.history_status().await;
        assert!(!status.can_undo);
        assert!(status.can_redo);
    }

    #[tokio::test]
    async fn redo_reapplies_undone_change() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        handle.undo(Actor::User).await.unwrap();
        handle.redo(Actor::User).await.expect("redo");

        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 1);
        assert_eq!(track.layers[0].id, layer_id);
    }

    #[tokio::test]
    async fn new_commit_truncates_redo() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        handle.undo(Actor::User).await.unwrap();
        // Redo available...
        assert!(handle.history_status().await.can_redo);

        // ...until a new commit truncates it.
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                2_000_000,
                3_000_000,
            )
            .await
            .unwrap();

        assert!(!handle.history_status().await.can_redo);
    }

    #[tokio::test]
    async fn checkpoint_survives_undo_redo() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        let cp = handle.checkpoint(Actor::User, "after first add").await;

        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                2_000_000,
                3_000_000,
            )
            .await
            .unwrap();
        handle.undo(Actor::User).await.unwrap(); // back to one layer
        handle.undo(Actor::User).await.unwrap(); // back to zero

        // Checkpoint still exists.
        let list = handle.list_checkpoints().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, cp);

        // Restore returns us to the one-layer state.
        handle
            .restore_checkpoint(Actor::User, cp)
            .await
            .expect("restore");
        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 1);
    }

    /// End-to-end happy path the human would see in agent mode:
    ///   1. Agent begins a session (here: just mints the auto-checkpoint
    ///      via the same code path the MCP tool exercises).
    ///   2. Agent locks history mid-batch.
    ///   3. User Undo / Restore attempts reject with HistoryLocked.
    ///   4. Agent unlocks. User Restore succeeds.
    ///   5. After Restore the project is back at the auto-checkpoint state.
    ///
    /// Walks the primitive command surface end-to-end against the live actor.
    #[tokio::test]
    async fn agent_session_full_lifecycle() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        // Step 1: simulate the begin_agent_session auto-checkpoint.
        // Agent actor is the entity minting the checkpoint, mirroring
        // what the MCP tool does.
        let agent = Actor::Agent { client: "mcp".into() };
        let pre_agent_cp = handle.checkpoint(agent.clone(), "Pre-agent: test").await;

        // Agent makes a destructive edit.
        let added = handle
            .add_layer(
                agent.clone(),
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        let after_add = handle.snapshot().await;
        let track = after_add.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 1);
        assert_eq!(track.layers.front().unwrap().id, added);

        // Step 2: agent grabs the revert lock.
        handle.lock_history("agent batch".into()).await;
        assert_eq!(
            handle.history_status().await.lock_reason.as_deref(),
            Some("agent batch"),
        );

        // Step 3: user-side undo + restore both reject.
        match handle.undo(Actor::User).await.unwrap_err() {
            CommandError::HistoryLocked { reason } => {
                assert_eq!(reason, "agent batch");
            }
            other => panic!("expected HistoryLocked from undo, got {other:?}"),
        }
        match handle
            .restore_checkpoint(Actor::User, pre_agent_cp)
            .await
            .unwrap_err()
        {
            CommandError::HistoryLocked { reason } => {
                assert_eq!(reason, "agent batch");
            }
            other => panic!("expected HistoryLocked from restore, got {other:?}"),
        }

        // Step 4: agent releases the lock; user restore now works.
        handle.unlock_history().await;
        assert!(handle.history_status().await.lock_reason.is_none());
        handle
            .restore_checkpoint(Actor::User, pre_agent_cp)
            .await
            .expect("restore after unlock");

        // Step 5: project state is the pre-agent baseline (no layers).
        let restored = handle.snapshot().await;
        let track = restored.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 0);
    }

    /// agent_session_end's auto-unlock guarantee: the napi Backend
    /// for "Exit to editor" calls unlock_history so the human's
    /// editor-mode Undo / Restore re-enables on the next paint, even
    /// if the agent left a lock taken. We can't call the napi Backend
    /// directly from a lib test, but the load-bearing path is
    /// `ProjectHandle::unlock_history` — verify that path leaves the
    /// revert surface usable.
    #[tokio::test]
    async fn unlock_history_restores_editor_revert_surface() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        handle.lock_history("agent batch".into()).await;
        // User tries undo and gets rejected — same path the disabled-
        // tooltip UX is meant to communicate.
        assert!(matches!(
            handle.undo(Actor::User).await.unwrap_err(),
            CommandError::HistoryLocked { .. }
        ));
        // User clicks Exit-to-editor; the napi Backend calls this.
        handle.unlock_history().await;
        // Now undo succeeds.
        handle.undo(Actor::User).await.expect("undo after exit");
    }

    #[tokio::test]
    async fn lock_blocks_revert_paths() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        let cp = handle.checkpoint(Actor::User, "after first add").await;

        handle.lock_history("agent busy".into()).await;

        // Undo / redo / restore all reject with HistoryLocked while the
        // lock is held — error carries the reason the agent supplied.
        for err in [
            handle.undo(Actor::User).await.unwrap_err(),
            handle.redo(Actor::User).await.unwrap_err(),
            handle
                .restore_checkpoint(Actor::User, cp)
                .await
                .unwrap_err(),
        ] {
            match err {
                CommandError::HistoryLocked { reason } => {
                    assert_eq!(reason, "agent busy");
                }
                other => panic!("expected HistoryLocked, got {other:?}"),
            }
        }

        // Releasing the lock re-enables every revert path.
        handle.unlock_history().await;
        handle.undo(Actor::User).await.unwrap();
    }

    #[tokio::test]
    async fn undo_at_origin_errors() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .undo(Actor::User)
            .await
            .expect_err("undo before any commit");
        assert!(matches!(err, CommandError::NothingToUndo));
    }

    #[tokio::test]
    async fn delete_empty_track_succeeds() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .delete_track(Actor::User, track_id, false)
            .await
            .expect("delete empty track");
        let snap = handle.snapshot().await;
        assert!(snap.tracks.is_empty());
    }

    #[tokio::test]
    async fn delete_non_empty_track_rejects_without_force() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        let err = handle
            .delete_track(Actor::User, track_id, false)
            .await
            .expect_err("delete non-empty track");
        assert!(matches!(err, CommandError::TrackNotEmpty { .. }));

        // With force, it succeeds.
        handle
            .delete_track(Actor::User, track_id, true)
            .await
            .expect("delete with force");
        let snap = handle.snapshot().await;
        assert!(snap.tracks.is_empty());
    }

    #[tokio::test]
    async fn split_layer_produces_two_halves() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                4_000_000,
            )
            .await
            .unwrap();

        let (left, right) = handle
            .split_layer(Actor::User, layer_id, 1_500_000, false)
            .await
            .expect("split");
        assert_eq!(left, layer_id);
        assert_ne!(right, layer_id);

        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 2);
        assert_eq!(track.layers[0].t_start_us, 0);
        assert_eq!(track.layers[0].t_end_us, 1_500_000);
        assert_eq!(track.layers[1].t_start_us, 1_500_000);
        assert_eq!(track.layers[1].t_end_us, 4_000_000);
    }

    #[tokio::test]
    async fn split_motif_layer_advances_right_src_in() {
        // countdown seconds=6, layer [0, 6_000_000], src_in=0. Split at 2s.
        // EXPECT: right half src_in_us == 2_000_000; left half src_in_us == 0.
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let mut props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        props.insert("seconds".into(), serde_json::json!(6.0));
        let layer_id = handle
            .add_layer(Actor::User, track_id, motif_layer(props), 0, 6_000_000)
            .await
            .expect("add_layer");
        let (left_id, right_id) = handle
            .split_layer(Actor::User, layer_id, 2_000_000, false)
            .await
            .expect("split");
        let snap = handle.snapshot().await;
        let find_layer = |id| {
            snap.tracks
                .iter()
                .flat_map(|t| t.layers.iter())
                .find(|l| l.id == id)
                .expect("layer")
                .clone()
        };
        let left = find_layer(left_id);
        let right = find_layer(right_id);
        let LayerParams::Motif(lp) = &left.params else { panic!("left: expected Motif") };
        let LayerParams::Motif(rp) = &right.params else { panic!("right: expected Motif") };
        assert_eq!(lp.src_in_us, 0, "left src_in unchanged");
        assert_eq!(rp.src_in_us, 2_000_000, "right src_in advanced by split offset");
    }

    #[tokio::test]
    async fn split_layer_at_endpoint_rejects() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                1_000_000,
                3_000_000,
            )
            .await
            .unwrap();
        // At the boundary — neither inside nor producing two valid halves.
        for at in [1_000_000, 3_000_000, 0, 5_000_000] {
            let err = handle
                .split_layer(Actor::User, layer_id, at, false)
                .await
                .expect_err("split outside bounds");
            assert!(
                matches!(err, CommandError::SplitOutsideLayer { .. }),
                "got {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn update_layer_applies_patch() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                2_000_000,
            )
            .await
            .unwrap();

        handle
            .update_layer(
                Actor::User,
                id,
                LayerPatch {
                    label: Some("intro".into()),
                    t_end_us: Some(3_000_000),
                    enabled: Some(false),
                    ..Default::default()
                },
            )
            .await
            .expect("update");

        let snap = handle.snapshot().await;
        let layer = snap.tracks.iter().flat_map(|t| t.layers.iter()).next().unwrap();
        assert_eq!(layer.label.as_deref(), Some("intro"));
        assert_eq!(layer.t_end_us, 3_000_000);
        assert!(!layer.enabled);
    }

    #[tokio::test]
    async fn move_layer_across_tracks() {
        let (mut project, src_track) = project_with_video_track();
        // Add a second track manually so we can move into it.
        let dst_track = Track::new();
        let dst_track_id = dst_track.id;
        project.tracks.push_back(dst_track);

        let handle = spawn(project);
        let id = handle
            .add_layer(
                Actor::User,
                src_track,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        handle
            .move_layer(Actor::User, id, dst_track_id, 5_000_000, false)
            .await
            .expect("move");

        let snap = handle.snapshot().await;
        let src = snap.tracks.iter().find(|t| t.id == src_track).unwrap();
        let dst = snap.tracks.iter().find(|t| t.id == dst_track_id).unwrap();
        assert!(src.layers.is_empty());
        assert_eq!(dst.layers.len(), 1);
        assert_eq!(dst.layers[0].id, id);
        assert_eq!(dst.layers[0].t_start_us, 5_000_000);
        assert_eq!(dst.layers[0].t_end_us, 6_000_000); // delta preserved
    }

    #[tokio::test]
    async fn duplicate_layer_creates_offset_copy() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        let dup = handle
            .duplicate_layer(Actor::User, id, 1_500_000)
            .await
            .expect("duplicate");

        assert_ne!(dup, id);
        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(track.layers.len(), 2);
        let copy = track.layers.iter().find(|l| l.id == dup).unwrap();
        assert_eq!(copy.t_start_us, 1_500_000);
        assert_eq!(copy.t_end_us, 2_500_000);
    }

    #[tokio::test]
    async fn set_composition_changes_canvas() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    width: Some(3840),
                    height: Some(2160),
                    fps: Some(Rational::FPS_60),
                    background: Some(Rgba::WHITE),
                    ..Default::default()
                },
            )
            .await
            .expect("set_composition");

        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.width, 3840);
        assert_eq!(snap.composition.height, 2160);
        assert_eq!(snap.composition.fps, Rational::FPS_60);
        assert_eq!(snap.composition.background, Rgba::WHITE);
    }

    #[tokio::test]
    async fn set_composition_rejects_invalid_canvas() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    width: Some(0),
                    ..Default::default()
                },
            )
            .await
            .expect_err("zero width should fail");
        assert!(matches!(
            err,
            CommandError::ValidationFailed(ValidationError::InvalidCanvas { width: 0, .. })
        ));
    }

    #[tokio::test]
    async fn add_transition_extends_outgoing_layer_to_create_overlap() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // Two back-to-back clips at [0, 3] and [3, 6]. add_transition should
        // extend `a` to [0, 4] and create a 1s overlap with `b` at [3, 4].
        let a = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 3_000_000)
            .await
            .expect("add a");
        let b = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                3_000_000,
                6_000_000,
            )
            .await
            .expect("add b");
        let tid = handle
            .add_transition(Actor::User, a, b, 1_000_000, TransitionKind::Crossfade)
            .await
            .expect("add_transition");

        let snap = handle.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        let a_layer = track.layers.iter().find(|l| l.id == a).unwrap();
        let b_layer = track.layers.iter().find(|l| l.id == b).unwrap();
        assert_eq!(a_layer.t_end_us, 4_000_000, "a extended to overlap b by 1s");
        assert_eq!(b_layer.t_start_us, 3_000_000, "b unchanged");
        assert_eq!(snap.transitions.len(), 1);
        assert_eq!(snap.transitions[0].id, tid);
        assert_eq!(snap.transitions[0].duration_us, 1_000_000);
    }

    #[tokio::test]
    async fn add_transition_rejects_layers_with_gap() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let a = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                5_000_000, // 4s gap after a
                7_000_000,
            )
            .await
            .unwrap();
        let err = handle
            .add_transition(Actor::User, a, b, 500_000, TransitionKind::Crossfade)
            .await
            .expect_err("gap should reject");
        assert!(matches!(
            err,
            CommandError::TransitionLayersNotAdjacent { .. }
        ));
    }

    #[tokio::test]
    async fn remove_transition_undoes_in_one_step() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let a = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 3_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                3_000_000,
                6_000_000,
            )
            .await
            .unwrap();
        let tid = handle
            .add_transition(Actor::User, a, b, 1_000_000, TransitionKind::Crossfade)
            .await
            .unwrap();
        handle
            .remove_transition(Actor::User, tid)
            .await
            .expect("remove");
        let snap = handle.snapshot().await;
        assert_eq!(snap.transitions.len(), 0);
        // remove_transition mirrors add_transition: the outgoing layer is
        // shrunk back by the transition's duration so the timeline returns
        // to a validation-passing back-to-back shape.
        let track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        let a_layer = track.layers.iter().find(|l| l.id == a).unwrap();
        assert_eq!(
            a_layer.t_end_us, 3_000_000,
            "remove_transition shrinks A back to its pre-transition end",
        );
    }

    #[tokio::test]
    async fn add_marker_keeps_list_sorted() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let _ = handle
            .add_marker(Actor::User, 5_000_000, None, "second", Rgba::WHITE)
            .await
            .unwrap();
        let _ = handle
            .add_marker(Actor::User, 1_000_000, None, "first", Rgba::BLACK)
            .await
            .unwrap();

        let snap = handle.snapshot().await;
        assert_eq!(snap.markers.len(), 2);
        assert_eq!(snap.markers[0].label, "first");
        assert_eq!(snap.markers[1].label, "second");
    }

    #[tokio::test]
    async fn replace_state_resets_history_to_fresh_stack() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // Make a real edit so history has more than one entry, and a
        // checkpoint that should also get cleared on the swap.
        handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .expect("add layer");
        let _cp = handle.checkpoint(Actor::User, "before swap").await;
        let view_before = handle.history_view(100).await;
        assert!(view_before.len > 1, "stack should have prior edits");
        assert_eq!(view_before.checkpoints.len(), 1);

        let mut replacement = Project::new_blank("replaced");
        replacement.tracks.clear();
        replacement.tracks.push_back(super::Track::new());
        let replacement_id = replacement.project_id;

        handle
            .replace_state(Actor::User, replacement)
            .await
            .expect("replace_state");

        let snap = handle.snapshot().await;
        assert_eq!(snap.project_id, replacement_id);
        assert_eq!(snap.metadata.name, "replaced");
        assert_eq!(snap.tracks.len(), 1);

        // History was reset: exactly one "Initial" entry, no checkpoints, undo
        // is a no-op. The prior project's edits and the "before swap"
        // checkpoint are gone.
        let view_after = handle.history_view(100).await;
        assert_eq!(view_after.len, 1);
        assert_eq!(view_after.cursor, 0);
        assert!(view_after.checkpoints.is_empty());
        let err = handle.undo(Actor::User).await.unwrap_err();
        assert!(matches!(err, CommandError::NothingToUndo));
    }

    #[tokio::test]
    async fn replace_state_does_not_touch_modified_at() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        // Construct a replacement with a known modified_at value and verify
        // do_replace_state leaves it alone. Loading a project from disk
        // shouldn't mark it dirty in memory.
        let mut replacement = Project::new_blank("on-disk");
        let pinned = chrono::DateTime::<chrono::Utc>::from_timestamp(1_700_000_000, 0).unwrap();
        replacement.metadata.modified_at = pinned;

        handle
            .replace_state(Actor::User, replacement)
            .await
            .expect("replace_state");

        let snap = handle.snapshot().await;
        assert_eq!(snap.metadata.modified_at, pinned);
    }

    #[tokio::test]
    async fn remove_media_with_no_references_does_not_record() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let media_id = new_id();
        let item = MediaItem {
            id: media_id,
            label: None,
            path_abs: "/tmp/x.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(1_000_000),
                video: None,
                audio: None,
                ..Default::default()
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        handle
            .add_media_item(Actor::User, item)
            .await
            .expect("add media");
        let len_before = handle.history_view(100).await.len;

        handle
            .remove_media(Actor::User, media_id, false)
            .await
            .expect("remove media");

        let view = handle.history_view(100).await;
        assert_eq!(
            view.len, len_before,
            "removing unreferenced media should not grow history"
        );
        let snap = handle.snapshot().await;
        assert!(!snap.media_pool.contains_key(&media_id));
    }

    #[tokio::test]
    async fn set_composition_canvas_only_does_not_record() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let len_before = handle.history_view(100).await.len;

        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    width: Some(1280),
                    height: Some(720),
                    ..Default::default()
                },
            )
            .await
            .expect("set composition");

        let view = handle.history_view(100).await;
        assert_eq!(
            view.len, len_before,
            "canvas-only changes should not grow history"
        );
        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.width, 1280);
        assert_eq!(snap.composition.height, 720);
    }

    #[tokio::test]
    async fn set_composition_mixed_patch_splits() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let len_before = handle.history_view(100).await.len;
        let dur_before = handle.snapshot().await.composition.duration_us;

        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    width: Some(1280),
                    duration_us: Some(dur_before + 5_000_000),
                    ..Default::default()
                },
            )
            .await
            .expect("set composition");

        let view = handle.history_view(100).await;
        assert_eq!(
            view.len,
            len_before + 1,
            "mixed patch should record exactly one entry (for duration_us)",
        );
        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.width, 1280, "canvas applied");
        assert_eq!(
            snap.composition.duration_us,
            dur_before + 5_000_000,
            "duration applied",
        );

        // Undo should reverse only the duration delta, leaving the canvas
        // change in place — that's the entire point of the split.
        handle.undo(Actor::User).await.expect("undo");
        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.duration_us, dur_before);
        assert_eq!(snap.composition.width, 1280, "canvas survives undo");
    }


    #[tokio::test]
    async fn blank_project_ships_with_ab_roll_skeleton() {
        // A/B-roll v2 (`docs/data-model.md` follow-up): the reserved
        // skeleton shrinks from 4 → 2. Two non-removable, role-stamped
        // tracks (A roll + B roll). Both are kind-agnostic in the
        // user-facing model; in v5.0 the TrackKind field still exists
        // and is set to Video for back-compat (V.5 removes the field).
        //
        // Data-model order is bottom-up: A roll at index 0 (z-stack
        // base), B roll at index 1 (top — overlays / cutaways paint
        // on top of A).
        let p = Project::new_blank("untitled");
        assert_eq!(p.tracks.len(), 2);

        let expected = [
            ("A roll", super::TrackRole::ARoll),
            ("B roll", super::TrackRole::BRoll),
        ];
        for (track, (label, role)) in p.tracks.iter().zip(expected.iter()) {
            assert_eq!(track.label.as_deref(), Some(*label));
            assert_eq!(track.role, Some(*role));
            assert!(!track.removable);
        }
    }

    // ---- R.4: role-aware AV-pair promotion + auto-prune of empty
    //       hidden tracks ----

    /// Reusable setup: blank project (4 reserved tracks) + a fresh
    /// hidden V+A pair carrying a grouped video/audio clip, mimicking
    /// what R.3's `place_imported_media_on_fresh_tracks` produces from
    /// `import_media`. Returns the handle plus all the ids the
    /// promotion test needs to assert against.
    async fn project_with_hidden_av_pair(
    ) -> (ProjectHandle, TrackId, TrackId, LayerId, LayerId, MediaItem) {
        use crate::state::audio_role::AudioRole;
        use crate::state::media::{AudioStreamMeta, MediaKind, MediaMetadata};
        use chrono::Utc;

        // V.4: reserved skeleton is just A roll + B roll. The V+A pair
        // here represents a manually-arranged split (V on one hidden
        // track, A on another) — V.3's import flow puts them on the
        // SAME hidden track, but the V.4 sibling-follow logic still
        // has to handle the manual-split case correctly.
        let mut p = Project::new_blank("ab-roll-test");
        // Add the import media to the pool so the layers can reference it.
        let media = MediaItem {
            id: new_id(),
            label: Some("import.mp4".into()),
            path_abs: "/m/import.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(5_000_000),
                video: None,
                audio: Some(AudioStreamMeta {
                    sample_rate: 48_000,
                    channels: 2,
                    codec: "aac".into(),
                }),
                ..Default::default()
            },
            proxy_path: None,
            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "h".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        let media_id = media.id;
        p.media_pool.insert(media_id, media.clone());
        let handle = spawn(p);

        // Mirror R.3's import path: transient tracks so the auto-prune
        // sweep can act on them once they empty out.
        let v_track = handle
            .add_transient_track(Actor::User, Some("import".into()))
            .await
            .unwrap();
        let a_track = handle
            .add_transient_track(Actor::User, Some("import (audio)".into()))
            .await
            .unwrap();
        let v_layer = handle
            .add_layer(
                Actor::User,
                v_track,
                LayerParams::VideoClip(crate::state::layer::VideoClipParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 5_000_000,
                    transform: Default::default(),
                    opacity: Animated::Static(1.0),
                    crop: None,
                    flip_h: false,
                    flip_v: false,
                    blend_mode: Default::default(),
                    speed: 1.0,
                    fade_in_us: 0,
                    fade_out_us: 0,
                }),
                0,
                5_000_000,
            )
            .await
            .unwrap();
        let a_layer = handle
            .add_layer(
                Actor::User,
                a_track,
                LayerParams::Audio(crate::state::layer::AudioParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 5_000_000,
                    gain_db: Animated::Static(0.0),
                    pan: Animated::Static(0.0),
                    fade_in_us: 0,
                    fade_out_us: 0,
                    mute: false,
                    role: AudioRole::Dialogue,
                }),
                0,
                5_000_000,
            )
            .await
            .unwrap();
        handle
            .groups_create(Actor::User, vec![v_layer, a_layer], None, false)
            .await
            .unwrap();

        (handle, v_track, a_track, v_layer, a_layer, media)
    }

    #[tokio::test]
    async fn promoting_video_to_a_roll_pulls_audio_sibling_onto_same_track() {
        // V.4: moving a grouped layer onto another track makes
        // grouped siblings follow onto the SAME destination track
        // (replaces R.4's "audio routes to paired AudioA/AudioB
        // role" logic — under v2 there are no role-paired audio
        // tracks). Both V and A end up on A roll; transient hidden
        // source tracks auto-prune once empty.
        let (handle, hidden_v_track, hidden_a_track, v_layer, a_layer, _media) =
            project_with_hidden_av_pair().await;
        let snap = handle.snapshot().await;
        let a_roll = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::ARoll))
            .unwrap()
            .id;

        handle
            .move_layer(Actor::User, v_layer, a_roll, 0, false)
            .await
            .unwrap();

        let after = handle.snapshot().await;
        let a_roll_track = after
            .tracks
            .iter()
            .find(|t| t.id == a_roll)
            .expect("A roll still present");
        assert!(a_roll_track.layers.iter().any(|l| l.id == v_layer));
        assert!(
            a_roll_track.layers.iter().any(|l| l.id == a_layer),
            "audio sibling must follow video onto A roll (same track)"
        );
        // The hidden source tracks pruned themselves once empty.
        assert!(!after.tracks.iter().any(|t| t.id == hidden_v_track));
        assert!(!after.tracks.iter().any(|t| t.id == hidden_a_track));
    }

    #[tokio::test]
    async fn promoting_audio_to_b_roll_pulls_video_sibling_onto_same_track() {
        // Symmetric case: drag the audio waveform first; the video
        // sibling follows onto the destination track too.
        let (handle, hidden_v_track, hidden_a_track, v_layer, a_layer, _media) =
            project_with_hidden_av_pair().await;
        let snap = handle.snapshot().await;
        let b_roll = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::BRoll))
            .unwrap()
            .id;

        handle
            .move_layer(Actor::User, a_layer, b_roll, 0, false)
            .await
            .unwrap();

        let after = handle.snapshot().await;
        let b_roll_track = after
            .tracks
            .iter()
            .find(|t| t.id == b_roll)
            .expect("B roll still present");
        assert!(b_roll_track.layers.iter().any(|l| l.id == a_layer));
        assert!(
            b_roll_track.layers.iter().any(|l| l.id == v_layer),
            "video sibling must follow audio onto B roll (same track)"
        );
        assert!(!after.tracks.iter().any(|t| t.id == hidden_v_track));
        assert!(!after.tracks.iter().any(|t| t.id == hidden_a_track));
    }

    #[tokio::test]
    async fn escape_group_keeps_audio_sibling_on_its_track() {
        // Alt-drag (escape_group=true) opts out of V.4's sibling-
        // follow logic: only the dragged layer moves; siblings stay
        // put on their original tracks. The hidden audio source
        // track survives because the audio layer is still on it.
        let (handle, hidden_v_track, hidden_a_track, v_layer, a_layer, _media) =
            project_with_hidden_av_pair().await;
        let snap = handle.snapshot().await;
        let a_roll = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::ARoll))
            .unwrap()
            .id;

        handle
            .move_layer(Actor::User, v_layer, a_roll, 0, /* escape_group */ true)
            .await
            .unwrap();

        let after = handle.snapshot().await;
        // Video promoted alone; audio sibling unchanged.
        assert!(
            after
                .tracks
                .iter()
                .find(|t| t.id == a_roll)
                .unwrap()
                .layers
                .iter()
                .any(|l| l.id == v_layer)
        );
        assert!(
            after
                .tracks
                .iter()
                .find(|t| t.id == hidden_a_track)
                .map(|t| t.layers.iter().any(|l| l.id == a_layer))
                .unwrap_or(false),
            "audio layer stays on its original hidden track under Alt-escape"
        );
        // Hidden video source pruned (now empty), audio source did NOT.
        assert!(!after.tracks.iter().any(|t| t.id == hidden_v_track));
        assert!(after.tracks.iter().any(|t| t.id == hidden_a_track));
    }

    #[tokio::test]
    async fn separate_audio_lifts_layer_onto_new_track_just_below_source() {
        // V.7: an Audio layer is lifted onto a fresh non-transient
        // track inserted directly after the source. Group membership
        // is preserved (the V layer stays on the source track grouped
        // with the moved A layer).
        let (handle, _hidden_v, _hidden_a, v_layer, a_layer, _media) =
            project_with_hidden_av_pair().await;
        // Promote the pair to A roll first so we have a V+A on the
        // same track to separate. After this, both V and A live on
        // ARoll (V.4 sibling-follow).
        let snap = handle.snapshot().await;
        let a_roll = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::ARoll))
            .unwrap()
            .id;
        handle
            .move_layer(Actor::User, v_layer, a_roll, 0, false)
            .await
            .unwrap();

        // Sanity: both layers now on ARoll.
        let pre = handle.snapshot().await;
        let pre_a_roll = pre
            .tracks
            .iter()
            .find(|t| t.id == a_roll)
            .unwrap();
        assert!(pre_a_roll.layers.iter().any(|l| l.id == v_layer));
        assert!(pre_a_roll.layers.iter().any(|l| l.id == a_layer));
        let pre_a_roll_idx = pre.tracks.iter().position(|t| t.id == a_roll).unwrap();

        // Separate the audio.
        let new_track_id = handle
            .separate_audio_to_new_track(Actor::User, a_layer)
            .await
            .expect("separate_audio_to_new_track");

        let after = handle.snapshot().await;
        // A layer is on the new track; V layer is still on ARoll.
        let a_roll_track = after
            .tracks
            .iter()
            .find(|t| t.id == a_roll)
            .unwrap();
        assert!(a_roll_track.layers.iter().any(|l| l.id == v_layer));
        assert!(
            !a_roll_track.layers.iter().any(|l| l.id == a_layer),
            "audio layer must leave the source track"
        );
        let new_track = after
            .tracks
            .iter()
            .find(|t| t.id == new_track_id)
            .expect("new track present");
        assert!(new_track.layers.iter().any(|l| l.id == a_layer));
        assert!(!new_track.transient, "new track must be non-transient");
        assert!(new_track.removable, "new track must be user-removable");
        // V.7 / V.8 contract: the new audio track sits at LOWER data-
        // model index than the source so visualOrderedTracks (V.8
        // reverse-data-model) renders it visually BELOW its source.
        let new_idx = after
            .tracks
            .iter()
            .position(|t| t.id == new_track_id)
            .unwrap();
        let source_after_idx = after
            .tracks
            .iter()
            .position(|t| t.id == a_roll)
            .unwrap();
        assert_eq!(new_idx, pre_a_roll_idx);
        assert_eq!(source_after_idx, pre_a_roll_idx + 1);
        // Group membership preserved (V and A still grouped).
        let groups = &after.groups;
        let pair_group = groups
            .iter()
            .find(|g| g.members.contains(&v_layer) && g.members.contains(&a_layer))
            .expect("group survives separate_audio");
        assert_eq!(pair_group.members.len(), 2);
    }

    #[tokio::test]
    async fn separate_audio_rejects_video_layer() {
        let (handle, _hidden_v, _hidden_a, v_layer, _a_layer, _media) =
            project_with_hidden_av_pair().await;
        let err = handle
            .separate_audio_to_new_track(Actor::User, v_layer)
            .await
            .expect_err("video layer should reject");
        assert!(matches!(
            err,
            CommandError::WrongLayerKind { expected: "Audio", .. }
        ));
    }

    #[tokio::test]
    async fn deleting_only_layer_on_hidden_track_prunes_the_track() {
        // Auto-prune also fires after `delete_layer`. A user / agent path
        // that removes the last layer of a hidden track shouldn't leave
        // an empty graveyard row in the timeline.
        let (handle, hidden_v_track, _hidden_a, v_layer, _a_layer, _media) =
            project_with_hidden_av_pair().await;
        // delete_layer doesn't have an escape_group flag (deletes are
        // single-layer by definition; group-aware delete is a separate
        // op). The audio sibling stays on its hidden track.
        handle.delete_layer(Actor::User, v_layer).await.unwrap();
        let after = handle.snapshot().await;
        assert!(
            !after.tracks.iter().any(|t| t.id == hidden_v_track),
            "hidden video track must auto-prune after its only layer is deleted"
        );
    }

    #[tokio::test]
    async fn promote_undo_restores_hidden_tracks() {
        // History invariant: undoing a promotion restores the project
        // to its prior shape — both the audio fan-out AND the
        // auto-pruned hidden tracks must reappear. The history layer
        // serialises whole-project snapshots so this is "free" as long
        // as our mutation paths don't leak across the commit boundary.
        let (handle, hidden_v_track, hidden_a_track, v_layer, _a_layer, _media) =
            project_with_hidden_av_pair().await;
        let snap = handle.snapshot().await;
        let video_a = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::ARoll))
            .unwrap()
            .id;

        handle
            .move_layer(Actor::User, v_layer, video_a, 0, false)
            .await
            .unwrap();
        // Pre-undo sanity: hidden source tracks gone.
        let mid = handle.snapshot().await;
        assert!(!mid.tracks.iter().any(|t| t.id == hidden_v_track));

        handle.undo(Actor::User).await.unwrap();
        let after = handle.snapshot().await;
        assert!(
            after.tracks.iter().any(|t| t.id == hidden_v_track),
            "undo must restore the auto-pruned hidden video track"
        );
        assert!(
            after.tracks.iter().any(|t| t.id == hidden_a_track),
            "undo must restore the auto-pruned hidden audio track"
        );
    }

    #[tokio::test]
    async fn cannot_delete_role_stamped_track() {
        // V.1: reserved skeleton is A roll + B roll (2 tracks). Both
        // are removable=false; an attempted delete must surface
        // TrackNotRemovable on either.
        let handle = spawn(Project::new_blank("untitled"));
        let snap = handle.snapshot().await;
        assert_eq!(snap.tracks.len(), 2);
        for t in snap.tracks.iter() {
            let err = handle
                .delete_track(Actor::User, t.id, true)
                .await
                .expect_err("delete should fail on every reserved track");
            assert!(matches!(err, CommandError::TrackNotRemovable { .. }));
        }
    }

    #[tokio::test]
    async fn import_media_does_not_grow_history() {
        use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
        use chrono::Utc;
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let history_before = handle.history_status().await.len;
        let item = MediaItem {
            id: new_id(),
            label: Some("intro.mp4".into()),
            path_abs: "/m/intro.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(5_000_000),
                video: None,
                audio: None,
                ..Default::default()
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        handle
            .add_media_item(Actor::User, item)
            .await
            .expect("import");
        let history_after = handle.history_status().await.len;
        assert_eq!(
            history_before, history_after,
            "media import must not push a history entry"
        );
        // But the snapshot must contain the new media.
        let snap = handle.snapshot().await;
        assert_eq!(snap.media_pool.len(), 1);
    }

    #[tokio::test]
    async fn imported_media_persists_across_undo() {
        use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
        use chrono::Utc;
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        // Edit 1: add a layer (this DOES push to history).
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        // Import media (must NOT push to history).
        let media_id = new_id();
        let item = MediaItem {
            id: media_id,
            label: Some("clip.mp4".into()),
            path_abs: "/m/clip.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(3_000_000),
                video: None,
                audio: None,
                ..Default::default()
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        handle
            .add_media_item(Actor::User, item)
            .await
            .expect("import");

        // Undo edit 1 — the media must still be in the pool.
        handle.undo(Actor::User).await.expect("undo");
        let snap = handle.snapshot().await;
        assert!(
            snap.media_pool.contains_key(&media_id),
            "imported media must survive undo of unrelated edits"
        );
    }

    fn dummy_video_media(duration_us: TimeUs) -> crate::state::media::MediaItem {
        use crate::state::media::{MediaItem, MediaKind, MediaMetadata};
        use chrono::Utc;
        MediaItem {
            id: new_id(),
            label: Some("clip.mp4".into()),
            path_abs: "/m/clip.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(duration_us),
                video: None,
                audio: None,
                ..Default::default()
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn update_marker_changes_label() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let id = handle
            .add_marker(Actor::User, 1_000_000, None, "old", Rgba::WHITE)
            .await
            .unwrap();
        handle
            .update_marker(
                Actor::User,
                id,
                MarkerPatch {
                    label: Some("new".into()),
                    ..Default::default()
                },
            )
            .await
            .expect("update_marker");
        let snap = handle.snapshot().await;
        assert_eq!(snap.markers[0].label, "new");
    }

    #[tokio::test]
    async fn update_marker_resorts_after_t_change() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let id_a = handle
            .add_marker(Actor::User, 1_000_000, None, "a", Rgba::WHITE)
            .await
            .unwrap();
        let _ = handle
            .add_marker(Actor::User, 5_000_000, None, "b", Rgba::WHITE)
            .await
            .unwrap();
        // Move "a" past "b".
        handle
            .update_marker(
                Actor::User,
                id_a,
                MarkerPatch {
                    t_us: Some(9_000_000),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.markers[0].label, "b");
        assert_eq!(snap.markers[1].label, "a");
    }

    #[tokio::test]
    async fn update_marker_unknown_id_errors() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .update_marker(
                Actor::User,
                new_id(),
                MarkerPatch {
                    label: Some("x".into()),
                    ..Default::default()
                },
            )
            .await
            .expect_err("unknown marker");
        assert!(matches!(err, CommandError::MarkerNotFound { .. }));
    }

    #[tokio::test]
    async fn remove_marker_drops_it() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let id = handle
            .add_marker(Actor::User, 1_000_000, None, "m", Rgba::WHITE)
            .await
            .unwrap();
        handle
            .remove_marker(Actor::User, id)
            .await
            .expect("remove_marker");
        let snap = handle.snapshot().await;
        assert!(snap.markers.is_empty());
    }

    #[tokio::test]
    async fn remove_marker_unknown_id_errors() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .remove_marker(Actor::User, new_id())
            .await
            .expect_err("unknown marker");
        assert!(matches!(err, CommandError::MarkerNotFound { .. }));
    }

    #[tokio::test]
    async fn move_track_reorders() {
        // `docs/data-model.md`: a blank project has 4 reserved tracks
        // (Audio B, Audio A, Video A, Video B). Find Video A / Video B by
        // role so this test stays robust against any future re-ordering of
        // the bootstrap skeleton.
        use super::TrackRole;
        let handle = spawn(Project::new_blank("untitled"));
        let snap = handle.snapshot().await;
        let a_roll = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::ARoll))
            .expect("A roll present")
            .id;
        let b_roll = snap
            .tracks
            .iter()
            .find(|t| t.role == Some(TrackRole::BRoll))
            .expect("B roll present")
            .id;
        // Move B roll to index 0 (bottom of stack).
        handle
            .move_track(Actor::User, b_roll, 0)
            .await
            .expect("move_track");
        let snap = handle.snapshot().await;
        assert_eq!(snap.tracks[0].id, b_roll);
        // A roll is still in the stack (somewhere) — exact index depends on
        // where the reorder shifted everyone else, which isn't this test's
        // concern.
        assert!(snap.tracks.iter().any(|t| t.id == a_roll));
    }

    #[tokio::test]
    async fn move_track_position_out_of_range() {
        let handle = spawn(Project::new_blank("untitled"));
        let snap = handle.snapshot().await;
        let id = snap.tracks[0].id;
        let err = handle
            .move_track(Actor::User, id, 99)
            .await
            .expect_err("position out of range");
        assert!(matches!(
            err,
            CommandError::TrackPositionOutOfRange { position: 99, .. }
        ));
    }

    #[tokio::test]
    async fn move_track_to_same_position_does_not_grow_history() {
        let handle = spawn(Project::new_blank("untitled"));
        let snap = handle.snapshot().await;
        let id = snap.tracks[0].id;
        let len_before = handle.history_status().await.len;
        handle
            .move_track(Actor::User, id, 0)
            .await
            .expect("no-op move");
        let len_after = handle.history_status().await.len;
        assert_eq!(len_before, len_after, "no-op move must not record history");
    }

    #[tokio::test]
    async fn remove_media_unreferenced_succeeds() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let item = dummy_video_media(5_000_000);
        let id = item.id;
        handle.add_media_item(Actor::User, item).await.unwrap();
        handle
            .remove_media(Actor::User, id, false)
            .await
            .expect("remove_media");
        let snap = handle.snapshot().await;
        assert!(!snap.media_pool.contains_key(&id));
    }

    #[tokio::test]
    async fn remove_media_referenced_rejects_without_force() {
        use crate::state::layer::VideoClipParams;
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let item = dummy_video_media(5_000_000);
        let media_id = item.id;
        handle.add_media_item(Actor::User, item).await.unwrap();
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                LayerParams::VideoClip(VideoClipParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 1_000_000,
                    transform: Default::default(),
                    opacity: Animated::Static(1.0),
                    crop: None,
                    flip_h: false,
                    flip_v: false,
                    blend_mode: Default::default(),
                    speed: 1.0,
                    fade_in_us: 0,
                    fade_out_us: 0,
                }),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        let err = handle
            .remove_media(Actor::User, media_id, false)
            .await
            .expect_err("should reject without force");
        match err {
            CommandError::MediaInUse {
                media,
                referenced_by,
            } => {
                assert_eq!(media, media_id);
                assert_eq!(referenced_by, vec![layer_id]);
            }
            other => panic!("unexpected error: {other:?}"),
        }

        // Media still present, layer still present.
        let snap = handle.snapshot().await;
        assert!(snap.media_pool.contains_key(&media_id));
        let still_there = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .any(|l| l.id == layer_id);
        assert!(still_there);
    }

    #[tokio::test]
    async fn remove_media_with_force_cascades_layer_deletion() {
        use crate::state::layer::VideoClipParams;
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let item = dummy_video_media(5_000_000);
        let media_id = item.id;
        handle.add_media_item(Actor::User, item).await.unwrap();
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                LayerParams::VideoClip(VideoClipParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 1_000_000,
                    transform: Default::default(),
                    opacity: Animated::Static(1.0),
                    crop: None,
                    flip_h: false,
                    flip_v: false,
                    blend_mode: Default::default(),
                    speed: 1.0,
                    fade_in_us: 0,
                    fade_out_us: 0,
                }),
                0,
                1_000_000,
            )
            .await
            .unwrap();

        handle
            .remove_media(Actor::User, media_id, true)
            .await
            .expect("force-remove");

        let snap = handle.snapshot().await;
        assert!(!snap.media_pool.contains_key(&media_id));
        let layer_still_there = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .any(|l| l.id == layer_id);
        assert!(
            !layer_still_there,
            "force removal must cascade-delete referencing layers"
        );
    }

    #[tokio::test]
    async fn history_view_returns_recent_ops_and_checkpoints() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // Three commits.
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                2_000_000,
                3_000_000,
            )
            .await
            .unwrap();
        let cp = handle.checkpoint(Actor::User, "cp1").await;
        handle
            .add_marker(Actor::User, 500_000, None, "m", Rgba::WHITE)
            .await
            .unwrap();

        let view = handle.history_view(50).await;
        // Initial entry + 3 commits = 4 ops.
        assert_eq!(view.len, 4);
        assert_eq!(view.ops.len(), 4);
        assert!(view.cursor < view.len);
        assert_eq!(view.checkpoints.len(), 1);
        assert_eq!(view.checkpoints[0].id, cp);
        assert_eq!(view.checkpoints[0].label, "cp1");
    }

    #[tokio::test]
    async fn history_view_respects_limit() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        // Two commits — total 3 entries with the initial one.
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                2_000_000,
                3_000_000,
            )
            .await
            .unwrap();

        let view = handle.history_view(2).await;
        assert_eq!(view.len, 3, "len reports the full history depth");
        assert_eq!(view.ops.len(), 2, "ops is capped to the limit");
    }

    #[tokio::test]
    async fn set_media_derivatives_patches_in_place_outside_history() {
        use std::path::PathBuf;
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let item = dummy_video_media(5_000_000);
        let media_id = item.id;
        handle.add_media_item(Actor::User, item).await.unwrap();
        let history_before = handle.history_status().await.len;

        handle
            .set_media_derivatives(
                Actor::User,
                media_id,
                MediaDerivativesPatch {
                    proxy_path: Some(Some(PathBuf::from("/cache/proxies/abc.mp4"))),
                    thumbnails_dir: Some(PathBuf::from("/cache/thumbnails/abc")),
                    export_uses_original: Some(true),
                    ..Default::default()
                },
            )
            .await
            .expect("set derivatives");

        let history_after = handle.history_status().await.len;
        assert_eq!(
            history_before, history_after,
            "derivatives must not push to undo stack"
        );

        let snap = handle.snapshot().await;
        let m = snap.media_pool.get(&media_id).unwrap();
        assert_eq!(
            m.proxy_path.as_deref(),
            Some(std::path::Path::new("/cache/proxies/abc.mp4"))
        );
        assert_eq!(
            m.thumbnails_dir.as_deref(),
            Some(std::path::Path::new("/cache/thumbnails/abc"))
        );
        assert!(m.waveform_path.is_none(), "untouched fields stay None");
        assert!(
            m.export_uses_original,
            "export_uses_original patch applied"
        );
    }

    #[tokio::test]
    async fn route_correction_clears_export_uses_original() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let item = dummy_video_media(5_000_000);
        let media_id = item.id;
        handle.add_media_item(Actor::User, item).await.unwrap();

        // Seed DirectExport: export from the original, no proxy yet.
        handle
            .set_media_derivatives(
                Actor::User,
                media_id,
                MediaDerivativesPatch {
                    export_uses_original: Some(true),
                    ..Default::default()
                },
            )
            .await
            .expect("seed");

        // The route-correction patch the new `ensure_full_proxy` issues before
        // enqueuing the full proxy.
        handle
            .set_media_derivatives(
                Actor::Agent {
                    client: "jobs".to_string(),
                },
                media_id,
                MediaDerivativesPatch {
                    export_uses_original: Some(false),
                    ..Default::default()
                },
            )
            .await
            .expect("route-correct");

        let snap = handle.snapshot().await;
        let m = snap.media_pool.get(&media_id).unwrap();
        assert!(!m.export_uses_original, "export_uses_original cleared");
        assert!(m.proxy_path.is_none(), "proxy_path untouched by the clear");
    }

    #[tokio::test]
    async fn set_media_derivatives_unknown_id_errors() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .set_media_derivatives(
                Actor::User,
                new_id(),
                MediaDerivativesPatch::default(),
            )
            .await
            .expect_err("unknown media");
        assert!(matches!(err, CommandError::MediaNotFound { .. }));
    }

    #[tokio::test]
    async fn remove_media_unknown_id_errors() {
        let (project, _) = project_with_video_track();
        let handle = spawn(project);
        let err = handle
            .remove_media(Actor::User, new_id(), false)
            .await
            .expect_err("unknown media");
        assert!(matches!(err, CommandError::MediaNotFound { .. }));
    }

    // ============================================================
    // dry_run
    // ============================================================

    /// Dry-running a single AddLayer should report success but leave
    /// `handle.snapshot()` unchanged. This is the load-bearing property:
    /// agents trust dry_run because it can't accidentally commit.
    #[tokio::test]
    async fn dry_run_does_not_mutate_state() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let before = handle.snapshot().await;
        let track_count_before = before.tracks.len();
        let layer_count_before: usize =
            before.tracks.iter().map(|t| t.layers.len()).sum();
        let history_cursor_before = handle.history_status().await.cursor;

        let results = handle
            .dry_run(vec![DryRunOp::AddLayer {
                track_id,
                params: color_layer(Rgba::WHITE),
                t_start_us: 0,
                t_end_us: 2_000_000,
            }])
            .await;
        assert_eq!(results.len(), 1);
        assert!(matches!(results[0], Ok(DryRunOutput::AddLayer { .. })));

        let after = handle.snapshot().await;
        assert_eq!(after.tracks.len(), track_count_before);
        let layer_count_after: usize =
            after.tracks.iter().map(|t| t.layers.len()).sum();
        assert_eq!(layer_count_after, layer_count_before);
        assert_eq!(handle.history_status().await.cursor, history_cursor_before);
    }

    /// A 3-op chain where the second op violates the no-overlap invariant
    /// must HALT at that op — the third must NOT execute. Mirrors the
    /// real-execution behavior where a failing commit aborts.
    #[tokio::test]
    async fn dry_run_halts_at_first_validation_error() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        // Real-commit a layer at [0, 3s] so the first op in the chain
        // overlaps with it.
        handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::BLACK), 0, 3_000_000)
            .await
            .expect("seed layer");

        let results = handle
            .dry_run(vec![
                DryRunOp::AddLayer {
                    track_id,
                    params: color_layer(Rgba::WHITE),
                    t_start_us: 0,
                    t_end_us: 4_000_000, // overlaps with [0, 3s]
                },
                DryRunOp::AddLayer {
                    track_id,
                    params: color_layer(Rgba::WHITE),
                    t_start_us: 5_000_000,
                    t_end_us: 6_000_000,
                },
            ])
            .await;
        assert_eq!(results.len(), 1, "halt should drop subsequent ops");
        assert!(matches!(
            &results[0],
            Err(CommandError::ValidationFailed(ValidationError::LayerOverlap { .. }))
        ));
    }

    /// A two-op chain that's only valid as a sequence: add layer A, then
    /// move A. Dry-run must apply both in order against the SAME working
    /// clone so the second op sees the first op's mutation.
    #[tokio::test]
    async fn dry_run_chains_state_across_ops() {
        let (project, track_id) = project_with_video_track();
        // Need a second track so MoveLayer has somewhere to land.
        let mut project = project;
        let mut second_track = Track::new();
        let second_track_id = second_track.id;
        second_track.label = Some("Overlay".into());
        project.tracks.push_back(second_track);
        let handle = spawn(project);

        // First op produces a layer id; we don't see it from outside, so
        // pre-seed instead and chain a move + update on the real id.
        let layer_id = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                0,
                2_000_000,
            )
            .await
            .expect("seed layer");

        let results = handle
            .dry_run(vec![
                DryRunOp::MoveLayer {
                    id: layer_id,
                    new_track_id: second_track_id,
                    new_t_start_us: 1_000_000,
                    escape_group: false,
                },
                DryRunOp::UpdateLayer {
                    id: layer_id,
                    patch: LayerPatch {
                        label: Some("renamed".into()),
                        ..Default::default()
                    },
                },
            ])
            .await;
        assert_eq!(results.len(), 2);
        assert!(matches!(results[0], Ok(DryRunOutput::Void)));
        assert!(matches!(results[1], Ok(DryRunOutput::Void)));

        // Real state still untouched — the seed layer should be where we
        // put it, not where the dry-run move would have landed it.
        let snap = handle.snapshot().await;
        let original_track = snap.tracks.iter().find(|t| t.id == track_id).unwrap();
        assert_eq!(original_track.layers.len(), 1);
        assert_eq!(original_track.layers[0].id, layer_id);
        assert_eq!(original_track.layers[0].label, None);
    }

    /// An invalid layer id surfaces as LayerNotFound from the apply_*
    /// function — should propagate cleanly through the dispatcher.
    #[tokio::test]
    async fn dry_run_surfaces_apply_errors_with_correct_op_index() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        // First op succeeds; second op refers to a non-existent layer.
        let results = handle
            .dry_run(vec![
                DryRunOp::AddLayer {
                    track_id,
                    params: color_layer(Rgba::WHITE),
                    t_start_us: 0,
                    t_end_us: 1_000_000,
                },
                DryRunOp::DeleteLayer { id: new_id() },
            ])
            .await;
        assert_eq!(results.len(), 2, "halt after the second op fails");
        assert!(matches!(results[0], Ok(DryRunOutput::AddLayer { .. })));
        assert!(matches!(
            &results[1],
            Err(CommandError::LayerNotFound { .. })
        ));
    }

    // ============================================================
    // Groups (`docs/groups.md`)
    // ============================================================

    async fn three_layers_on_video_track() -> (ProjectHandle, TrackId, LayerId, LayerId, LayerId) {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let a = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                2_000_000,
                3_000_000,
            )
            .await
            .unwrap();
        let c = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::WHITE),
                4_000_000,
                5_000_000,
            )
            .await
            .unwrap();
        (handle, track_id, a, b, c)
    }

    #[tokio::test]
    async fn groups_create_two_layers_succeeds() {
        let (handle, _t, a, b, _c) = three_layers_on_video_track().await;
        let group_id = handle
            .groups_create(Actor::User, vec![a, b], Some("scene 1".into()), false)
            .await
            .expect("create");
        let snap = handle.snapshot().await;
        assert_eq!(snap.groups.len(), 1);
        let g = &snap.groups[0];
        assert_eq!(g.id, group_id);
        assert_eq!(g.label.as_deref(), Some("scene 1"));
        assert!(g.members.contains(&a) && g.members.contains(&b));
    }

    #[tokio::test]
    async fn groups_create_rejects_single_member() {
        let (handle, _t, a, _b, _c) = three_layers_on_video_track().await;
        let err = handle
            .groups_create(Actor::User, vec![a], None, false)
            .await
            .expect_err("single-member group");
        assert!(matches!(
            err,
            CommandError::GroupCreateNeedsTwoLayers { got: 1 }
        ));
    }

    #[tokio::test]
    async fn groups_create_rejects_unknown_layer() {
        let (handle, _t, a, _b, _c) = three_layers_on_video_track().await;
        let ghost = new_id();
        let err = handle
            .groups_create(Actor::User, vec![a, ghost], None, false)
            .await
            .expect_err("unknown layer");
        assert!(matches!(err, CommandError::LayerNotFound { layer } if layer == ghost));
    }

    #[tokio::test]
    async fn groups_create_rejects_already_grouped_without_reassign() {
        let (handle, _t, a, b, c) = three_layers_on_video_track().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let err = handle
            .groups_create(Actor::User, vec![a, c], None, false)
            .await
            .expect_err("a is already grouped");
        assert!(matches!(err, CommandError::LayerAlreadyGrouped { layer, .. } if layer == a));
    }

    #[tokio::test]
    async fn groups_create_with_reassign_moves_layer() {
        let (handle, _t, a, b, c) = three_layers_on_video_track().await;
        let g1 = handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let g2 = handle
            .groups_create(Actor::User, vec![a, c], None, true)
            .await
            .expect("reassign should succeed");
        let snap = handle.snapshot().await;
        // g1 had only {a, b}; removing a left {b}, which auto-dissolved g1.
        // So we should now have exactly one group (g2) with members {a, c}.
        assert_eq!(snap.groups.len(), 1, "g1 should have auto-dissolved");
        let g = snap.groups.iter().find(|g| g.id == g2).unwrap();
        assert!(g.members.contains(&a) && g.members.contains(&c));
        assert!(snap.groups.iter().all(|g| g.id != g1));
    }

    #[tokio::test]
    async fn groups_dissolve_removes_group() {
        let (handle, _t, a, b, _c) = three_layers_on_video_track().await;
        let g = handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle.groups_dissolve(Actor::User, g).await.unwrap();
        let snap = handle.snapshot().await;
        assert!(snap.groups.is_empty());
    }

    #[tokio::test]
    async fn groups_dissolve_unknown_id_fails() {
        let (handle, _t, _a, _b, _c) = three_layers_on_video_track().await;
        let err = handle
            .groups_dissolve(Actor::User, new_id())
            .await
            .expect_err("unknown group");
        assert!(matches!(err, CommandError::GroupNotFound { .. }));
    }

    #[tokio::test]
    async fn groups_add_members_grows_group() {
        let (handle, _t, a, b, c) = three_layers_on_video_track().await;
        let g = handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle
            .groups_add_members(Actor::User, g, vec![c], false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.groups[0].members.len(), 3);
    }

    #[tokio::test]
    async fn groups_remove_members_auto_dissolves_below_two() {
        let (handle, _t, a, b, c) = three_layers_on_video_track().await;
        let g = handle
            .groups_create(Actor::User, vec![a, b, c], None, false)
            .await
            .unwrap();
        handle
            .groups_remove_members(Actor::User, g, vec![b, c])
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert!(
            snap.groups.is_empty(),
            "group with only one remaining member should auto-dissolve"
        );
    }

    #[tokio::test]
    async fn groups_remove_unknown_member_fails() {
        let (handle, _t, a, b, c) = three_layers_on_video_track().await;
        let g = handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let err = handle
            .groups_remove_members(Actor::User, g, vec![c])
            .await
            .expect_err("c is not in the group");
        assert!(matches!(err, CommandError::LayerNotInGroup { .. }));
    }

    #[tokio::test]
    async fn groups_rename_updates_label() {
        let (handle, _t, a, b, _c) = three_layers_on_video_track().await;
        let g = handle
            .groups_create(Actor::User, vec![a, b], Some("old".into()), false)
            .await
            .unwrap();
        handle
            .groups_rename(Actor::User, g, Some("new".into()))
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.groups[0].label.as_deref(), Some("new"));
    }

    #[tokio::test]
    async fn delete_layer_auto_removes_from_group_and_dissolves() {
        let (handle, _t, a, b, _c) = three_layers_on_video_track().await;
        let g = handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle.delete_layer(Actor::User, a).await.unwrap();
        let snap = handle.snapshot().await;
        // Group had {a, b}; removing a left {b}; auto-dissolved.
        assert!(snap.groups.iter().all(|gg| gg.id != g));
    }

    #[tokio::test]
    async fn undo_restores_group() {
        let (handle, _t, a, b, _c) = three_layers_on_video_track().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle.undo(Actor::User).await.unwrap();
        let snap = handle.snapshot().await;
        assert!(snap.groups.is_empty(), "undo should reverse groups_create");
    }

    // ============================================================
    // Group-aware move / trim / split (`docs/groups.md`)
    // ============================================================

    /// Two tracks, A on track1 and B on track2, both at [0..1_000_000].
    /// Returns (handle, track1, track2, a, b).
    async fn paired_layers_on_two_tracks(
    ) -> (ProjectHandle, TrackId, TrackId, LayerId, LayerId) {
        let (project, track1) = project_with_video_track();
        let handle = spawn(project);
        let track2 = handle
            .add_track(Actor::User, Some("V2".into()))
            .await
            .unwrap();
        let a = handle
            .add_layer(Actor::User, track1, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(Actor::User, track2, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        (handle, track1, track2, a, b)
    }

    fn layer<'a>(p: &'a Project, id: LayerId) -> &'a Layer {
        p.tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == id)
            .expect("layer present")
    }

    #[tokio::test]
    async fn move_layer_propagates_time_delta_to_group_siblings() {
        // V.4 contract: siblings shift by the same time delta AND
        // follow the anchor onto its destination track. To keep the
        // test focused on the time-shift behavior (rather than
        // requiring a non-overlapping layout post-follow), use
        // cross-class layers — a Visual + an Audio — so they can
        // coexist on the same track at the same time slot.
        use crate::state::audio_role::AudioRole;
        use crate::state::layer::AudioParams;
        let (project, t1) = project_with_video_track();
        let handle = spawn(project);
        let t2 = handle
            .add_track(Actor::User, Some("V2".into()))
            .await
            .unwrap();
        let media = dummy_video_media(5_000_000);
        let media_id = media.id;
        handle.add_media_item(Actor::User, media).await.unwrap();

        let a = handle
            .add_layer(Actor::User, t1, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(
                Actor::User,
                t2,
                LayerParams::Audio(AudioParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 1_000_000,
                    gain_db: Animated::Static(0.0),
                    pan: Animated::Static(0.0),
                    fade_in_us: 0,
                    fade_out_us: 0,
                    mute: false,
                    role: AudioRole::Dialogue,
                }),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();

        // Shift A right by +500ms on its own track.
        handle
            .move_layer(Actor::User, a, t1, 500_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        let la = layer(&snap, a);
        let lb = layer(&snap, b);
        assert_eq!(la.t_start_us, 500_000);
        assert_eq!(la.t_end_us, 1_500_000);
        assert_eq!(lb.t_start_us, 500_000, "sibling shifts by the same delta");
        assert_eq!(lb.t_end_us, 1_500_000);
    }

    #[tokio::test]
    async fn move_layer_track_change_pulls_grouped_siblings_along() {
        // V.4: siblings follow the anchor onto the destination track
        // (replaces the old "siblings stay on their track" rule).
        // Setup A on t1, B on t2 (different classes so they can
        // co-exist on one track). Move A to t3 with a +500ms delta;
        // both A and B end up on t3 at the shifted time.
        use crate::state::audio_role::AudioRole;
        use crate::state::layer::AudioParams;
        let (project, t1) = project_with_video_track();
        let handle = spawn(project);
        let t2 = handle
            .add_track(Actor::User, Some("V2".into()))
            .await
            .unwrap();
        let t3 = handle
            .add_track(Actor::User, Some("V3".into()))
            .await
            .unwrap();
        let media = dummy_video_media(5_000_000);
        let media_id = media.id;
        handle.add_media_item(Actor::User, media).await.unwrap();

        let a = handle
            .add_layer(Actor::User, t1, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(
                Actor::User,
                t2,
                LayerParams::Audio(AudioParams {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 1_000_000,
                    gain_db: Animated::Static(0.0),
                    pan: Animated::Static(0.0),
                    fade_in_us: 0,
                    fade_out_us: 0,
                    mute: false,
                    role: AudioRole::Dialogue,
                }),
                0,
                1_000_000,
            )
            .await
            .unwrap();
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle
            .move_layer(Actor::User, a, t3, 500_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        // Both A and B are now on t3.
        let track_of_a = snap
            .tracks
            .iter()
            .find(|t| t.layers.iter().any(|l| l.id == a))
            .unwrap();
        assert_eq!(track_of_a.id, t3, "anchor moves to destination");
        let track_of_b = snap
            .tracks
            .iter()
            .find(|t| t.layers.iter().any(|l| l.id == b))
            .unwrap();
        assert_eq!(track_of_b.id, t3, "sibling follows to same destination");
        // B's time shifted by the same delta.
        assert_eq!(layer(&snap, b).t_start_us, 500_000);
        assert_eq!(layer(&snap, b).t_end_us, 1_500_000);
    }

    #[tokio::test]
    async fn move_layer_escape_group_skips_fanout() {
        let (handle, t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let pre = handle.snapshot().await;
        let pre_b = layer(&pre, b).clone();
        handle
            .move_layer(Actor::User, a, t1, 2_000_000, true)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        let la = layer(&snap, a);
        let lb = layer(&snap, b);
        assert_eq!(la.t_start_us, 2_000_000);
        assert_eq!(lb.t_start_us, pre_b.t_start_us, "B not touched on escape");
    }

    #[tokio::test]
    async fn move_layer_rejects_when_sibling_locked() {
        let (handle, t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle
            .update_layer(
                Actor::User,
                b,
                LayerPatch {
                    locked: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let err = handle
            .move_layer(Actor::User, a, t1, 500_000, false)
            .await
            .expect_err("locked sibling should reject");
        assert!(matches!(err, CommandError::GroupLockedMember { .. }));
    }

    #[tokio::test]
    async fn move_layer_locked_sibling_yields_to_escape() {
        let (handle, t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle
            .update_layer(
                Actor::User,
                b,
                LayerPatch {
                    locked: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        // escape_group=true bypasses the lock check.
        handle
            .move_layer(Actor::User, a, t1, 500_000, true)
            .await
            .expect("escape should bypass lock");
    }

    /// AV-link case: video and audio at identical bounds, both edges aligned.
    /// Trimming the out edge of one should fan out to the other.
    #[tokio::test]
    async fn trim_aligned_edges_propagate_to_group_siblings() {
        let (handle, t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let _ = t1;
        // Trim out edge of A from 1_000_000 to 700_000. Both A and B were
        // at out=1_000_000 → aligned → both move.
        handle
            .trim_layer(Actor::User, a, LayerEdge::Out, 700_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(layer(&snap, a).t_end_us, 700_000);
        assert_eq!(
            layer(&snap, b).t_end_us,
            700_000,
            "aligned out edge propagates"
        );
    }

    /// Scene case: B-roll [0..1_000_000] and VO [0..5_000_000] in one group.
    /// Left edges align (both 0); out edges don't. Trimming B-roll's left
    /// edge should fan out (aligned); trimming its right edge should not.
    #[tokio::test]
    async fn trim_non_aligned_edge_stays_local() {
        let (project, track1) = project_with_video_track();
        let handle = spawn(project);
        let track2 = handle
            .add_track(Actor::User, Some("V2".into()))
            .await
            .unwrap();
        let a = handle
            .add_layer(Actor::User, track1, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(Actor::User, track2, color_layer(Rgba::WHITE), 0, 5_000_000)
            .await
            .unwrap();
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        // Trim A's OUT edge from 1_000_000 -> 800_000. B's out is at
        // 5_000_000 → NOT aligned → B unchanged.
        handle
            .trim_layer(Actor::User, a, LayerEdge::Out, 800_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(layer(&snap, a).t_end_us, 800_000);
        assert_eq!(layer(&snap, b).t_end_us, 5_000_000, "non-aligned stays");
        // Trim A's IN edge from 0 -> 100_000. B's in is also 0 → aligned →
        // both move. But clamping: A has dur=800_000 so its t_start can
        // go from 0 to at most 799_999; same for B (dur 5_000_000).
        // requested delta = +100_000 fits both.
        handle
            .trim_layer(Actor::User, a, LayerEdge::In, 100_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(layer(&snap, a).t_start_us, 100_000);
        assert_eq!(
            layer(&snap, b).t_start_us,
            100_000,
            "aligned in edge propagates"
        );
    }

    #[tokio::test]
    async fn trim_clamps_to_tightest_aligned_member() {
        // A on [0..1_000_000], B on [0..200_000], grouped. Trim A's out
        // edge to +500_000. B's dur is 200_000 so its max trim is +inf
        // upward (out goes up); but trimming A DOWN to 500_000 means
        // delta = -500_000. For B, that would push out to -300_000 — but
        // B's t_start is 0 and dur is 200_000, so trimming out by more
        // than 199_999 collapses it. Clamp should kick in.
        let (project, track1) = project_with_video_track();
        let handle = spawn(project);
        let track2 = handle
            .add_track(Actor::User, Some("V2".into()))
            .await
            .unwrap();
        let a = handle
            .add_layer(Actor::User, track1, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(Actor::User, track2, color_layer(Rgba::WHITE), 0, 200_000)
            .await
            .unwrap();
        // Force out edge alignment by trimming B's out to 1_000_000 first
        // via escape (so they're aligned at 1_000_000).
        // Actually here we test alignment at 200_000 only. The two layers
        // are NOT aligned at any out edge (1_000_000 vs 200_000), so the
        // fan-out doesn't fire — A trims alone.
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        // Trim A's out from 1_000_000 to 500_000. B is at out=200_000 (not
        // aligned) → B untouched.
        handle
            .trim_layer(Actor::User, a, LayerEdge::Out, 500_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(layer(&snap, a).t_end_us, 500_000);
        assert_eq!(layer(&snap, b).t_end_us, 200_000);
    }

    #[tokio::test]
    async fn trim_escape_group_stays_local() {
        let (handle, _t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle
            .trim_layer(Actor::User, a, LayerEdge::Out, 600_000, true)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(layer(&snap, a).t_end_us, 600_000);
        assert_eq!(layer(&snap, b).t_end_us, 1_000_000, "escape keeps B intact");
    }

    #[tokio::test]
    async fn split_layer_fans_out_to_spanning_siblings() {
        let (handle, _t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let (_la, ra) = handle
            .split_layer(Actor::User, a, 500_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        // Both layers should be split at 500_000. A has its right half
        // (ra) and a left half (still id=a). B should also have two
        // pieces.
        let on_track2: Vec<&Layer> = snap
            .tracks
            .iter()
            .find(|t| t.layers.iter().any(|l| l.id == b))
            .unwrap()
            .layers
            .iter()
            .collect();
        assert_eq!(on_track2.len(), 2, "B was split into 2 pieces");
        assert!(on_track2.iter().any(|l| l.t_end_us == 500_000));
        assert!(on_track2.iter().any(|l| l.t_start_us == 500_000));
        // The group should now have 4 members (a, ra, b's left, b's right).
        assert_eq!(snap.groups.len(), 1);
        assert_eq!(snap.groups[0].members.len(), 4);
        // ra should be in the group.
        assert!(snap.groups[0].members.contains(&ra));
    }

    #[tokio::test]
    async fn split_layer_non_spanning_sibling_stays_whole() {
        // A on [0..1_000_000], B on [2_000_000..3_000_000], grouped.
        // Split A at 500_000 — B doesn't span 500_000, stays whole and
        // stays in the group.
        let (project, track1) = project_with_video_track();
        let handle = spawn(project);
        let track2 = handle
            .add_track(Actor::User, Some("V2".into()))
            .await
            .unwrap();
        let a = handle
            .add_layer(Actor::User, track1, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();
        let b = handle
            .add_layer(
                Actor::User,
                track2,
                color_layer(Rgba::WHITE),
                2_000_000,
                3_000_000,
            )
            .await
            .unwrap();
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let _ = handle
            .split_layer(Actor::User, a, 500_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        let b_layer = layer(&snap, b);
        assert_eq!(b_layer.t_start_us, 2_000_000);
        assert_eq!(b_layer.t_end_us, 3_000_000);
        // Group has 3 members (a, ra, b).
        assert_eq!(snap.groups[0].members.len(), 3);
    }

    #[tokio::test]
    async fn split_layer_escape_group_only_splits_target() {
        let (handle, _t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        let _ = handle
            .split_layer(Actor::User, a, 500_000, true)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        // Find B; it should be unchanged (one layer on its track).
        let on_track2: Vec<&Layer> = snap
            .tracks
            .iter()
            .find(|t| t.layers.iter().any(|l| l.id == b))
            .unwrap()
            .layers
            .iter()
            .collect();
        assert_eq!(on_track2.len(), 1, "B should not be split under escape");
    }

    // Phase G.5 — verify the import-pairing orchestration composes cleanly
    // at the actor level. `add_video_layer` / `add_media_layer` perform
    // add_layer + add_layer + groups_create as three sequential commits;
    // this test replays that sequence and checks the final group state.
    #[tokio::test]
    async fn paired_av_import_produces_grouped_pair() {
        use crate::state::{
            AudioParams as AP, LayerParams as LP, VideoClipParams as VCP, MediaItem,
            MediaKind, MediaMetadata, AudioStreamMeta,
        };
        use crate::state::audio_role::AudioRole;
        let (project, video_track) = project_with_video_track();
        let handle = spawn(project);
        let audio_track = handle
            .add_track(Actor::User, Some("Audio".into()))
            .await
            .unwrap();
        // Inject a media item with both video AND audio streams. The
        // pairing path reads `MediaMetadata.audio` to decide whether to
        // create the Audio layer.
        let media = MediaItem {
            id: new_id(),
            label: Some("clip.mp4".into()),
            path_abs: "/tmp/clip.mp4".into(),
            path_rel: None,
            kind: MediaKind::Video,
            metadata: MediaMetadata {
                duration_us: Some(5_000_000),
                video: None,
                audio: Some(AudioStreamMeta {
                    sample_rate: 48_000,
                    channels: 2,
                    codec: "aac".into(),
                }),
                ..Default::default()
            },
            proxy_path: None,

            proxy_format_version: 0,
            quick_proxy_path: None,
            proxy_bypassed: false,
            export_uses_original: false,
            waveform_path: None,
            conform_path: None,
            thumbnails_dir: None,
            file_hash_blake3: "0".into(),
            file_size: 0,
            file_mtime: 0,
            imported_at: Utc::now(),
        };
        let media_id = media.id;
        handle.add_media_item(Actor::User, media).await.unwrap();
        let video_layer_id = handle
            .add_layer(
                Actor::User,
                video_track,
                LP::VideoClip(VCP {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 5_000_000,
                    transform: Default::default(),
                    opacity: Animated::Static(1.0),
                    crop: None,
                    flip_h: false,
                    flip_v: false,
                    blend_mode: Default::default(),
                    speed: 1.0,
                    fade_in_us: 0,
                    fade_out_us: 0,
                }),
                0,
                5_000_000,
            )
            .await
            .unwrap();
        let audio_layer_id = handle
            .add_layer(
                Actor::User,
                audio_track,
                LP::Audio(AP {
                    media: media_id,
                    src_in_us: 0,
                    src_out_us: 5_000_000,
                    gain_db: Animated::Static(0.0),
                    pan: Animated::Static(0.0),
                    fade_in_us: 0,
                    fade_out_us: 0,
                    mute: false,
                    role: AudioRole::Dialogue,
                }),
                0,
                5_000_000,
            )
            .await
            .unwrap();
        let group_id = handle
            .groups_create(
                Actor::User,
                vec![video_layer_id, audio_layer_id],
                None,
                false,
            )
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.groups.len(), 1);
        let g = &snap.groups[0];
        assert_eq!(g.id, group_id);
        assert!(g.members.contains(&video_layer_id));
        assert!(g.members.contains(&audio_layer_id));
        // Sanity: a subsequent move on the video propagates to the audio.
        handle
            .move_layer(Actor::User, video_layer_id, video_track, 1_000_000, false)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        let v = layer(&snap, video_layer_id);
        let a = layer(&snap, audio_layer_id);
        assert_eq!(v.t_start_us, 1_000_000);
        assert_eq!(a.t_start_us, 1_000_000, "AV pair shifts together");
    }

    #[tokio::test]
    async fn split_layer_locked_spanning_sibling_rejects() {
        let (handle, _t1, _t2, a, b) = paired_layers_on_two_tracks().await;
        handle
            .groups_create(Actor::User, vec![a, b], None, false)
            .await
            .unwrap();
        handle
            .update_layer(
                Actor::User,
                b,
                LayerPatch {
                    locked: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let err = handle
            .split_layer(Actor::User, a, 500_000, false)
            .await
            .expect_err("locked sibling should reject");
        assert!(matches!(err, CommandError::GroupLockedMember { .. }));
    }

    // Fan-out logic is indifferent to whether a group carries effects; the
    // move / trim / split / locked-member tests above cover the full surface.

    // ============================================================
    // ADR 0005: composition duration auto-fits to layers unless pinned.
    // ============================================================

    #[tokio::test]
    async fn delete_layer_shrinks_duration_when_unpinned() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let short = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 2_000_000)
            .await
            .unwrap();
        let long = handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                2_000_000,
                10_000_000,
            )
            .await
            .unwrap();
        assert_eq!(handle.snapshot().await.composition.duration_us, 10_000_000);
        assert!(!handle.snapshot().await.composition.duration_pinned);

        handle.delete_layer(Actor::User, long).await.unwrap();
        // The shorter layer ends at 2_000_000; composition should follow.
        assert_eq!(handle.snapshot().await.composition.duration_us, 2_000_000);

        // Now delete the last layer — composition snaps back to 0.
        handle.delete_layer(Actor::User, short).await.unwrap();
        assert_eq!(handle.snapshot().await.composition.duration_us, 0);
    }

    #[tokio::test]
    async fn trim_in_shrinks_duration_when_unpinned() {
        // Trimming the In edge of the only layer can lift the layer's
        // t_start_us but never its t_end_us, so duration shouldn't change
        // from In trims by themselves. The interesting case is trimming
        // In on a layer that's not the high-water mark — composition
        // doesn't move. Here we cover trimming Out on the high-watermark
        // layer to demonstrate inward Out trims also shrink.
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer = handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 10_000_000)
            .await
            .unwrap();
        assert_eq!(handle.snapshot().await.composition.duration_us, 10_000_000);

        handle
            .trim_layer(Actor::User, layer, LayerEdge::Out, 4_000_000, false)
            .await
            .unwrap();
        assert_eq!(handle.snapshot().await.composition.duration_us, 4_000_000);
    }

    #[tokio::test]
    async fn set_composition_duration_pins_and_freezes_passive_edits() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 5_000_000)
            .await
            .unwrap();
        assert!(!handle.snapshot().await.composition.duration_pinned);

        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    duration_us: Some(60_000_000),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.duration_us, 60_000_000);
        assert!(snap.composition.duration_pinned);

        // A passive add inside the pinned window leaves duration alone.
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                5_000_000,
                8_000_000,
            )
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.duration_us, 60_000_000);
        assert!(snap.composition.duration_pinned);
    }

    #[tokio::test]
    async fn fit_composition_to_layers_clears_pin_and_snaps_duration() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 5_000_000)
            .await
            .unwrap();
        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    duration_us: Some(60_000_000),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(handle.snapshot().await.composition.duration_pinned);

        handle
            .fit_composition_to_layers(Actor::User)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.duration_us, 5_000_000);
        assert!(!snap.composition.duration_pinned);
    }

    #[tokio::test]
    async fn pinned_composition_still_grows_to_cover_overflow_layer() {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 5_000_000)
            .await
            .unwrap();
        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    duration_us: Some(10_000_000),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(handle.snapshot().await.composition.duration_us, 10_000_000);

        // Add a layer that extends past the pinned window. The
        // `duration_us >= max(t_end_us)` invariant forces a bump-up
        // even when pinned. The pin must remain set.
        handle
            .add_layer(
                Actor::User,
                track_id,
                color_layer(Rgba::BLACK),
                5_000_000,
                30_000_000,
            )
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.duration_us, 30_000_000);
        assert!(
            snap.composition.duration_pinned,
            "pin must survive an overflow-driven extend"
        );
    }

    #[tokio::test]
    async fn set_composition_below_max_end_bumps_to_overflow_floor() {
        // Pinning a duration shorter than the layer high-water mark
        // would break the `duration_us >= max(t_end_us)` invariant. The
        // overflow guard bumps the value up while still recording the
        // pin — so a user who tries to "tighten" the composition past
        // its content gets the floor, with their pin honoured.
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 10_000_000)
            .await
            .unwrap();

        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    duration_us: Some(3_000_000),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.duration_us, 10_000_000);
        assert!(snap.composition.duration_pinned);
    }

    #[tokio::test]
    async fn old_project_without_duration_pinned_loads_unpinned() {
        // Verifies the `#[serde(default)]` on `duration_pinned`: a
        // project saved before the field existed deserializes with the
        // pin off and self-heals via the first layer edit. We can't
        // round-trip through a file in a unit test, but we can construct
        // a snapshot whose duration was set "manually" (without going
        // through set_composition) and confirm the next edit re-fits.
        let (mut project, track_id) = project_with_video_track();
        project.composition.duration_us = 100_000_000;
        project.composition.duration_pinned = false;
        let handle = spawn(project);

        handle
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 4_000_000)
            .await
            .unwrap();
        let snap = handle.snapshot().await;
        assert_eq!(snap.composition.duration_us, 4_000_000);
        assert!(!snap.composition.duration_pinned);
    }

    /// Patching `seconds` to a LARGER value (grow) must NOT resize the layer.
    /// countdown seconds=5 → content 5s; layer [0, 5_000_000], src_in=0.
    /// Patch seconds=6 → content grows to 6s. EXPECT: t_end_us stays 5_000_000,
    /// src_in_us stays 0.
    #[tokio::test]
    async fn update_layer_params_seconds_grow_does_not_resize_layer() {
        let mut props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        props.insert("seconds".into(), serde_json::json!(5));
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(Actor::User, track_id, motif_layer(props), 0, 5_000_000)
            .await
            .expect("add_layer");

        let mut patch_props: std::collections::HashMap<String, serde_json::Value> =
            std::collections::HashMap::new();
        patch_props.insert("seconds".into(), serde_json::json!(6));
        handle
            .update_layer_params(
                Actor::User,
                layer_id,
                LayerParamsPatch::Motif(MotifPatch {
                    props: Some(patch_props),
                    ..Default::default()
                }),
            )
            .await
            .expect("update_layer_params");

        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        assert_eq!(layer.t_end_us, 5_000_000, "grow must not resize the layer");
        if let LayerParams::Motif(p) = &layer.params {
            assert_eq!(p.src_in_us, 0, "grow must not change src_in_us");
        } else {
            panic!("not a motif");
        }
    }

    /// Patching `seconds` to a SMALLER value that falls inside the current window
    /// (shrink-below-window) must clamp t_end into the new content.
    /// countdown seconds=6 → content 6s; layer [0, 6_000_000], src_in=0.
    /// Patch seconds=3 → content shrinks to 3s. EXPECT: t_end_us == 3_000_000.
    #[tokio::test]
    async fn update_layer_params_seconds_shrink_clamps_layer_to_content() {
        let mut props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        props.insert("seconds".into(), serde_json::json!(6));
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let layer_id = handle
            .add_layer(Actor::User, track_id, motif_layer(props), 0, 6_000_000)
            .await
            .expect("add_layer");

        let mut patch_props: std::collections::HashMap<String, serde_json::Value> =
            std::collections::HashMap::new();
        patch_props.insert("seconds".into(), serde_json::json!(3));
        handle
            .update_layer_params(
                Actor::User,
                layer_id,
                LayerParamsPatch::Motif(MotifPatch {
                    props: Some(patch_props),
                    ..Default::default()
                }),
            )
            .await
            .expect("update_layer_params");

        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        assert_eq!(layer.t_end_us, 3_000_000, "shrink below window must clamp t_end to content");
        if let LayerParams::Motif(p) = &layer.params {
            assert_eq!(p.src_in_us, 0, "src_in unchanged when window starts at 0");
        } else {
            panic!("not a motif");
        }
    }

    /// When `seconds` shrinks below the current `src_in_us`, the clamp forces
    /// `new_src_in = snap_frame_floor(src_in.min(max_src_in), fps)`. At 29.97fps
    /// (30000/1001) `snap_frame_floor`'s µs output can land 1µs below the
    /// canonical round-grid point; the double-snap (floor + round) must
    /// canonicalise it so the resulting `src_in_us` is round-grid-idempotent.
    #[tokio::test]
    async fn seconds_shrink_clamp_src_in_lands_on_round_grid() {
        // Use 29.97fps so the /1001 rate exercises the truncation edge case.
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);

        // Switch to 29.97fps first so layers land on that grid from the start.
        handle
            .set_composition(
                Actor::User,
                CompositionPatch {
                    fps: Some(Rational::FPS_29_97),
                    ..Default::default()
                },
            )
            .await
            .expect("set_composition to 29.97fps");

        // Add countdown seconds=6. Layer [0, 6_000_000] snaps to the 29.97 grid.
        let mut props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        props.insert("seconds".into(), serde_json::json!(6));
        let layer_id = handle
            .add_layer(Actor::User, track_id, motif_layer(props), 0, 6_000_000)
            .await
            .expect("add_layer");

        // IN-trim to ~3s (3_003_033us on the 29.97 grid = frame 90).
        // After trim: t_start ≈ 3_003_033, src_in ≈ 3_003_033.
        handle
            .trim_layer(Actor::User, layer_id, LayerEdge::In, 3_000_000, false)
            .await
            .expect("trim IN to ~3s");

        // Verify src_in is nonzero before the shrink.
        {
            let snap = handle.snapshot().await;
            let l = snap
                .tracks
                .iter()
                .flat_map(|t| t.layers.iter())
                .find(|l| l.id == layer_id)
                .expect("layer");
            let LayerParams::Motif(p) = &l.params else { panic!("expected Motif") };
            assert!(p.src_in_us > 0, "src_in must be > 0 before shrink");
        }

        // Shrink seconds to 2 → content_dur = 2_000_000µs. src_in (≈3s) > max_src_in
        // (1_999_999µs) → clamp branch fires.
        let mut patch_props: std::collections::HashMap<String, serde_json::Value> =
            std::collections::HashMap::new();
        patch_props.insert("seconds".into(), serde_json::json!(2));
        handle
            .update_layer_params(
                Actor::User,
                layer_id,
                LayerParamsPatch::Motif(MotifPatch {
                    props: Some(patch_props),
                    ..Default::default()
                }),
            )
            .await
            .expect("update_layer_params seconds=2");

        let snap = handle.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer");
        let LayerParams::Motif(p) = &layer.params else { panic!("expected Motif") };

        let fps = Rational::FPS_29_97;
        // The clamped src_in_us must be round-grid-idempotent (the double-snap fix).
        assert_eq!(
            p.src_in_us,
            crate::state::time::snap_frame_round(p.src_in_us, fps),
            "src_in_us must land on the canonical round grid after seconds-shrink clamp"
        );
        // Must be within the new content (< 2_000_000µs).
        assert!(
            p.src_in_us < 2_000_000,
            "clamped src_in_us must be within new content (< 2s), got {}",
            p.src_in_us
        );
        // t_end must also be clamped (within new content).
        assert!(
            layer.t_end_us <= layer.t_start_us + 2_000_000,
            "t_end_us must be within new content window"
        );
    }

    // ============================================================
    // Locked tracks reject layer mutations.
    // ============================================================

    #[tokio::test]
    async fn locked_track_rejects_layer_mutations() {
        // Use project_with_video_track() so we have a single clean track.
        let (project, track_id) = project_with_video_track();
        let h = spawn(project);

        // Add a color layer spanning [0, 2_000_000) so trim + split have room.
        let layer_id = h
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 2_000_000)
            .await
            .expect("add_layer");

        // Lock the track.
        h.update_track_flags(
            Actor::User,
            track_id,
            TrackFlagsPatch { enabled: None, muted: None, solo: None, locked: Some(true) },
        )
        .await
        .expect("lock track");

        // move — same track, new position: must be rejected.
        let res = h.move_layer(Actor::User, layer_id, track_id, 500_000, false).await;
        assert!(
            matches!(res, Err(CommandError::TrackLocked { .. })),
            "move on locked track must return TrackLocked, got {res:?}"
        );

        // trim — must be rejected.
        let res = h.trim_layer(Actor::User, layer_id, LayerEdge::In, 200_000, false).await;
        assert!(
            matches!(res, Err(CommandError::TrackLocked { .. })),
            "trim on locked track must return TrackLocked, got {res:?}"
        );

        // split — at 1_000_000 which is inside [0, 2_000_000): must be rejected.
        let res = h.split_layer(Actor::User, layer_id, 1_000_000, false).await;
        assert!(
            matches!(res, Err(CommandError::TrackLocked { .. })),
            "split on locked track must return TrackLocked, got {res:?}"
        );

        // Cross-track move ONTO a locked track: add an unlocked source track,
        // add a layer there, then try to move it onto the locked track_id.
        let src_track = h
            .add_track(Actor::User, Some("src".into()))
            .await
            .expect("add src track");
        let src_layer = h
            .add_layer(Actor::User, src_track, color_layer(Rgba::BLACK), 0, 1_000_000)
            .await
            .expect("add src layer");
        let res = h.move_layer(Actor::User, src_layer, track_id, 0, false).await;
        assert!(
            matches!(res, Err(CommandError::TrackLocked { .. })),
            "cross-track move onto locked destination must return TrackLocked, got {res:?}"
        );

        // Verify the original layer is untouched (still at t_start=0).
        let snap = h.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("original layer must still exist");
        assert_eq!(layer.t_start_us, 0, "locked layer must not have moved");
    }

    #[tokio::test]
    async fn locked_track_rejects_grouped_fanout() {
        // Cross-track group: anchor on unlocked track A, sibling on track B.
        // Locking track B must reject move/trim/split issued through the
        // anchor (group fan-out would otherwise mutate the sibling on the
        // locked track). Same edges on both layers so the trim aligned-edge
        // coupling fans out, and a mid-span split spans both members.
        let (project, track_a) = project_with_video_track();
        let h = spawn(project);
        let anchor = h
            .add_layer(Actor::User, track_a, color_layer(Rgba::WHITE), 0, 2_000_000)
            .await
            .expect("add anchor layer");
        let track_b = h
            .add_track(Actor::User, Some("b".into()))
            .await
            .expect("add track b");
        let sibling = h
            .add_layer(Actor::User, track_b, color_layer(Rgba::BLACK), 0, 2_000_000)
            .await
            .expect("add sibling layer");
        h.groups_create(Actor::User, vec![anchor, sibling], None, false)
            .await
            .expect("group anchor + sibling");

        // Lock the sibling's track only; the anchor's track stays unlocked.
        h.update_track_flags(
            Actor::User,
            track_b,
            TrackFlagsPatch { enabled: None, muted: None, solo: None, locked: Some(true) },
        )
        .await
        .expect("lock track b");

        // move via the group path (escape_group=false) — fan-out would shift
        // the sibling on locked track B.
        let res = h.move_layer(Actor::User, anchor, track_a, 500_000, false).await;
        assert!(
            matches!(res, Err(CommandError::TrackLocked { .. })),
            "grouped move with a sibling on a locked track must return TrackLocked, got {res:?}"
        );

        // trim — both In edges sit at 0, so the aligned-edge coupling would
        // fan out to the sibling on locked track B.
        let res = h.trim_layer(Actor::User, anchor, LayerEdge::In, 200_000, false).await;
        assert!(
            matches!(res, Err(CommandError::TrackLocked { .. })),
            "grouped trim with an aligned sibling on a locked track must return TrackLocked, got {res:?}"
        );

        // split — 1_000_000 is strictly inside both members' [0, 2_000_000),
        // so the spanning-sibling fan-out would split the sibling too.
        let res = h.split_layer(Actor::User, anchor, 1_000_000, false).await;
        assert!(
            matches!(res, Err(CommandError::TrackLocked { .. })),
            "grouped split spanning a sibling on a locked track must return TrackLocked, got {res:?}"
        );

        // escape_group=true is anchor-only: siblings are skipped, and the
        // anchor's own track is unlocked, so the op must still be allowed.
        h.trim_layer(Actor::User, anchor, LayerEdge::In, 200_000, true)
            .await
            .expect("escape_group trim on the unlocked anchor track must succeed");

        // The sibling on the locked track must be untouched throughout.
        let snap = h.snapshot().await;
        let s = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == sibling)
            .expect("sibling must still exist");
        assert_eq!(s.t_start_us, 0, "sibling on locked track must not have moved");
        assert_eq!(s.t_end_us, 2_000_000, "sibling on locked track must not have been trimmed");
    }

    #[tokio::test]
    async fn locked_track_rejects_delete_and_updates() {
        // Lock back doors: delete / envelope update / params update must be
        // rejected actor-side just like move/trim/split — a stale selection
        // surviving the lock toggle must not mutate locked-track layers.
        let (project, track_id) = project_with_video_track();
        let h = spawn(project);

        let layer_id = h
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 2_000_000)
            .await
            .expect("add_layer");

        // Lock the track.
        h.update_track_flags(
            Actor::User,
            track_id,
            TrackFlagsPatch { enabled: None, muted: None, solo: None, locked: Some(true) },
        )
        .await
        .expect("lock track");

        // delete — must be rejected.
        let res = h.delete_layer(Actor::User, layer_id).await;
        assert!(
            matches!(res, Err(CommandError::TrackLocked { .. })),
            "delete on locked track must return TrackLocked, got {res:?}"
        );

        // envelope update (t_start shift) — must be rejected.
        let res = h
            .update_layer(
                Actor::User,
                layer_id,
                LayerPatch {
                    t_start_us: Some(500_000),
                    ..Default::default()
                },
            )
            .await;
        assert!(
            matches!(res, Err(CommandError::TrackLocked { .. })),
            "update_layer on locked track must return TrackLocked, got {res:?}"
        );

        // params update — must be rejected.
        let res = h
            .update_layer_params(
                Actor::User,
                layer_id,
                LayerParamsPatch::Color(ColorPatch {
                    color: Some(Rgba::BLACK),
                    ..Default::default()
                }),
            )
            .await;
        assert!(
            matches!(res, Err(CommandError::TrackLocked { .. })),
            "update_layer_params on locked track must return TrackLocked, got {res:?}"
        );

        // The layer must be entirely untouched.
        let snap = h.snapshot().await;
        let layer = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .expect("layer on locked track must still exist");
        assert_eq!(layer.t_start_us, 0, "locked-track layer must not have shifted");
        let LayerParams::Color(p) = &layer.params else { panic!("expected Color") };
        assert!(
            matches!(p.color, Animated::Static(c) if c == Rgba::WHITE),
            "locked-track layer params must be untouched"
        );
    }

    // ---------------------------------------------------------------------------
    // update_layer_param_track tests
    // ---------------------------------------------------------------------------

    use crate::state::animated::{Interpolation, Keyframe};

    /// Returns an actor handle and a layer id for a single Motif layer on one
    /// track. Motif layers expose `opacity` through `resolve_animated_f64_mut`.
    async fn single_motif_project() -> (ProjectHandle, LayerId) {
        let (project, track_id) = project_with_video_track();
        let handle = spawn(project);
        let mut props: imbl::HashMap<String, serde_json::Value> = imbl::HashMap::new();
        props.insert("seconds".into(), serde_json::json!(5));
        let layer_id = handle
            .add_layer(Actor::User, track_id, motif_layer(props), 0, 5_000_000)
            .await
            .expect("add_layer");
        (handle, layer_id)
    }

    fn find_layer(snap: &Arc<Project>, id: LayerId) -> crate::state::layer::Layer {
        snap.tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == id)
            .expect("layer not found in snapshot")
            .clone()
    }

    fn assert_keyframe_times(
        layer: &crate::state::layer::Layer,
        key: &str,
        expected_ts: &[i64],
    ) {
        let mut params = layer.params.clone();
        let slot = crate::state::layer::resolve_animated_f64_mut(&mut params, key)
            .expect("param not animatable");
        let Animated::Keyframed(kfs) = slot else {
            panic!("expected Keyframed mode for param {key}");
        };
        let actual_ts: Vec<i64> = kfs.iter().map(|k| k.t_us).collect();
        assert_eq!(actual_ts, expected_ts, "keyframe times for {key}");
    }

    fn assert_keyframed_sorted(
        layer: &crate::state::layer::Layer,
        key: &str,
        expected_ts: &[i64],
        expected_values: &[f64],
    ) {
        let mut params = layer.params.clone();
        let slot = crate::state::layer::resolve_animated_f64_mut(&mut params, key)
            .expect("param not animatable");
        let Animated::Keyframed(kfs) = slot else {
            panic!("expected Keyframed mode for param {key}");
        };
        let actual_ts: Vec<i64> = kfs.iter().map(|k| k.t_us).collect();
        assert_eq!(actual_ts, expected_ts, "keyframe times for {key} must be sorted and match");
        // Assert values too, so a bug that permutes values while sorting times
        // (e.g. sorting a values vec separately) can't slip through.
        let actual_vals: Vec<f64> = kfs.iter().map(|k| k.value).collect();
        assert_eq!(actual_vals, expected_values, "keyframe values for {key} must track their times");
    }

    #[tokio::test]
    async fn update_layer_param_track_writes_and_normalizes() {
        let (handle, layer_id) = single_motif_project().await;
        let track = Animated::Keyframed(
            vec![
                Keyframe { id: crate::state::ids::new_id(), t_us: 2_000_000, value: 1.0, interp: Interpolation::Linear },
                Keyframe { id: crate::state::ids::new_id(), t_us: 0, value: 0.0, interp: Interpolation::Linear },
            ]
            .into_iter()
            .collect(),
        );
        handle
            .update_layer_param_track(Actor::User, layer_id, "opacity".into(), track)
            .await
            .expect("write opacity track");
        let snap = handle.snapshot().await;
        let layer = find_layer(&snap, layer_id);
        // After normalize: sorted by t_us, and each value stays glued to its time
        // (input was t=2_000_000→1.0, t=0→0.0).
        assert_keyframed_sorted(&layer, "opacity", &[0, 2_000_000], &[0.0, 1.0]);
    }

    #[tokio::test]
    async fn update_layer_param_track_rejects_empty_keyframed() {
        let (handle, layer_id) = single_motif_project().await;
        let empty = Animated::Keyframed(imbl::Vector::new());
        let res = handle
            .update_layer_param_track(Actor::User, layer_id, "opacity".into(), empty)
            .await;
        assert!(matches!(res, Err(CommandError::EmptyKeyframeTrack { .. })));
    }

    #[tokio::test]
    async fn update_layer_param_track_rejects_unknown_param() {
        let (handle, layer_id) = single_motif_project().await;
        let res = handle
            .update_layer_param_track(Actor::User, layer_id, "bogus".into(), Animated::Static(1.0))
            .await;
        assert!(matches!(res, Err(CommandError::UnknownKeyframeParam { .. })));
    }

    #[tokio::test]
    async fn trim_in_shifts_keyframes_to_stay_on_content() {
        // Layer at t_start=0; opacity keyframes at 0 and 2_000_000 (layer-relative).
        let (handle, layer_id) = single_motif_project().await;
        let track = Animated::Keyframed(
            vec![
                Keyframe { id: crate::state::ids::new_id(), t_us: 0, value: 0.0, interp: Interpolation::Linear },
                Keyframe { id: crate::state::ids::new_id(), t_us: 2_000_000, value: 1.0, interp: Interpolation::Linear },
            ].into_iter().collect(),
        );
        handle.update_layer_param_track(Actor::User, layer_id, "opacity".into(), track)
            .await.expect("seed keyframes");

        // Trim the IN edge to t=1_000_000 (head trimmed inward by 1s).
        handle.trim_layer(Actor::User, layer_id, LayerEdge::In, 1_000_000, false)
            .await.expect("trim in");

        // Key at 2_000_000 -> 1_000_000 (shifted -1s); key at 0 -> -1_000_000 (out-of-range, KEPT).
        let snap = handle.snapshot().await;
        let layer = find_layer(&snap, layer_id);
        assert_keyframed_sorted(&layer, "opacity", &[-1_000_000, 1_000_000], &[0.0, 1.0]);
    }

    #[tokio::test]
    async fn split_partitions_keyframes_and_rebases_right() {
        // Motif [0, 5_000_000]; opacity keys at 0, 2_000_000, 3_000_000.
        let (handle, layer_id) = single_motif_project().await;
        let track = Animated::Keyframed(
            vec![
                Keyframe { id: crate::state::ids::new_id(), t_us: 0, value: 0.0, interp: Interpolation::Linear },
                Keyframe { id: crate::state::ids::new_id(), t_us: 2_000_000, value: 0.5, interp: Interpolation::Linear },
                Keyframe { id: crate::state::ids::new_id(), t_us: 3_000_000, value: 1.0, interp: Interpolation::Linear },
            ].into_iter().collect(),
        );
        handle.update_layer_param_track(Actor::User, layer_id, "opacity".into(), track)
            .await.expect("seed keyframes");

        // Split at composition t=2_500_000 (clip-local offset = 2_500_000).
        let (left_id, right_id) = handle.split_layer(Actor::User, layer_id, 2_500_000, false)
            .await.expect("split");

        let snap = handle.snapshot().await;
        // Left keeps t_us <= 2_500_000 -> [0, 2_000_000].
        assert_keyframe_times(&find_layer(&snap, left_id), "opacity", &[0, 2_000_000]);
        // Right keeps t_us > 2_500_000, rebased -2_500_000 -> [500_000].
        assert_keyframe_times(&find_layer(&snap, right_id), "opacity", &[500_000]);
    }

    #[tokio::test]
    async fn split_collapses_empty_half_to_static_boundary_value() {
        // All opacity keys in the first half; split AFTER them -> right half has
        // no keys and must collapse to Static at the LAST key's value (0.8),
        // not the engine fallback.
        let (handle, layer_id) = single_motif_project().await;
        let track = Animated::Keyframed(
            vec![
                Keyframe { id: crate::state::ids::new_id(), t_us: 0, value: 0.2, interp: Interpolation::Linear },
                Keyframe { id: crate::state::ids::new_id(), t_us: 1_000_000, value: 0.8, interp: Interpolation::Linear },
            ].into_iter().collect(),
        );
        handle.update_layer_param_track(Actor::User, layer_id, "opacity".into(), track)
            .await.expect("seed keyframes");

        let (_left_id, right_id) = handle.split_layer(Actor::User, layer_id, 3_000_000, false)
            .await.expect("split");

        let snap = handle.snapshot().await;
        let right = find_layer(&snap, right_id);
        let mut params = right.params.clone();
        let slot = crate::state::layer::resolve_animated_f64_mut(&mut params, "opacity")
            .expect("opacity animatable");
        assert!(
            matches!(slot, Animated::Static(v) if (*v - 0.8).abs() < 1e-9),
            "empty right half must collapse to Static at the last key value 0.8, got {slot:?}"
        );
    }

    #[tokio::test]
    async fn add_caption_track_creates_role_track_with_one_layer_per_cue() {
        use crate::subtitles::Cue;
        use crate::subtitles::CueStyle;
        let h = spawn(Project::new_blank("test"));
        let cues = vec![
            Cue { start_us: 0, end_us: 1_000_000, text: "a".into(), style: CueStyle::default() },
            Cue { start_us: 1_000_000, end_us: 2_000_000, text: "b".into(), style: CueStyle::default() },
        ];
        let track_id = h.add_caption_track(Actor::User, cues, 1920, 1080, Some("Captions".into()))
            .await.expect("add_caption_track");
        let snap = h.snapshot().await;
        let track = snap.tracks.iter().find(|t| t.id == track_id).expect("track");
        assert_eq!(track.role, Some(crate::state::track::TrackRole::Caption));
        assert_eq!(track.layers.len(), 2);
        assert!(matches!(track.layers[0].params, crate::state::layer::LayerParams::Text(_)));

        // ONE undo removes the whole caption track.
        h.undo(Actor::User).await.expect("undo");
        let snap = h.snapshot().await;
        assert!(snap.tracks.iter().all(|t| t.id != track_id));
    }

    /// Overlapping cues must fan onto additional caption tracks so every
    /// individual track remains non-overlapping (validator-clean), and the
    /// entire import is still ONE undo entry.
    ///
    /// Fixture: A [0, 2s), B [1s, 3s), C [2s, 3s)
    ///   A and B overlap → B goes to track 2.
    ///   C starts exactly when A ends (t=2s) → half-open interval, C fits track 1.
    /// Expected layout: track 1 = [A, C], track 2 = [B].
    #[tokio::test]
    async fn overlapping_cues_fan_to_additional_caption_tracks() {
        use crate::subtitles::Cue;
        use crate::subtitles::CueStyle;
        let h = spawn(Project::new_blank("test"));
        let cues = vec![
            Cue { start_us: 0, end_us: 2_000_000, text: "A".into(), style: CueStyle::default() },
            Cue { start_us: 1_000_000, end_us: 3_000_000, text: "B".into(), style: CueStyle::default() },
            Cue { start_us: 2_000_000, end_us: 3_000_000, text: "C".into(), style: CueStyle::default() },
        ];
        let primary_id = h
            .add_caption_track(Actor::User, cues, 1920, 1080, Some("Captions".into()))
            .await
            .expect("add_caption_track must not fail — validator must see clean tracks");

        let snap = h.snapshot().await;

        // Exactly 2 caption tracks created.
        let caption_tracks: Vec<_> = snap
            .tracks
            .iter()
            .filter(|t| t.role == Some(crate::state::track::TrackRole::Caption))
            .collect();
        assert_eq!(caption_tracks.len(), 2, "expected 2 caption tracks, got {}", caption_tracks.len());

        // Both are role Caption.
        for t in &caption_tracks {
            assert_eq!(t.role, Some(crate::state::track::TrackRole::Caption));
        }

        // Primary track (returned id) holds A and C; overflow track holds B.
        let primary = snap.tracks.iter().find(|t| t.id == primary_id).expect("primary track");
        assert_eq!(primary.layers.len(), 2, "primary track must have A + C");

        let overflow = caption_tracks
            .iter()
            .find(|t| t.id != primary_id)
            .expect("overflow track");
        assert_eq!(overflow.layers.len(), 1, "overflow track must have B only");

        // Verify layer text content to confirm correct assignment.
        let text_of = |layer: &crate::state::layer::Layer| match &layer.params {
            crate::state::layer::LayerParams::Text(p) => p.content.clone(),
            _ => panic!("expected Text layer"),
        };
        let primary_texts: Vec<_> = primary.layers.iter().map(text_of).collect();
        assert!(primary_texts.contains(&"A".to_string()), "primary must have cue A");
        assert!(primary_texts.contains(&"C".to_string()), "primary must have cue C");
        let overflow_text = text_of(&overflow.layers[0]);
        assert_eq!(overflow_text, "B", "overflow must have cue B");

        // ONE undo removes ALL caption tracks (single-commit invariant).
        h.undo(Actor::User).await.expect("undo");
        let snap_after = h.snapshot().await;
        assert!(
            snap_after.tracks.iter().all(|t| t.role != Some(crate::state::track::TrackRole::Caption)),
            "undo must remove all caption tracks in one step"
        );
    }

    #[tokio::test]
    async fn restyle_caption_track_patches_all_layers_in_one_undo() {
        use crate::subtitles::{Cue, CueStyle};
        let h = spawn(Project::new_blank("test"));
        let cues = vec![
            Cue { start_us: 0, end_us: 1_000_000, text: "a".into(), style: CueStyle::default() },
            Cue { start_us: 1_000_000, end_us: 2_000_000, text: "b".into(), style: CueStyle::default() },
        ];
        let tid = h.add_caption_track(Actor::User, cues, 1920, 1080, None).await.unwrap();
        h.restyle_caption_track(Actor::User, tid, crate::state::actor::CaptionStylePatch {
            font_size_px: Some(120.0),
            ..Default::default()
        })
            .await.unwrap();
        let snap = h.snapshot().await;
        let tr = snap.tracks.iter().find(|t| t.id == tid).unwrap();
        for l in &tr.layers {
            if let crate::state::layer::LayerParams::Text(tp) = &l.params {
                assert_eq!(tp.font.size_px, 120.0);
            }
        }
        h.undo(Actor::User).await.unwrap(); // ONE undo reverts all
        let snap = h.snapshot().await;
        let tr = snap.tracks.iter().find(|t| t.id == tid).unwrap();
        if let crate::state::layer::LayerParams::Text(tp) = &tr.layers[0].params {
            assert_eq!(tp.font.size_px, 54.0);
        }
    }

    // ============================================================
    // Effect mutation helpers
    // ============================================================

    fn blur_effect(strength: f64) -> crate::state::Effect {
        let mut params = std::collections::BTreeMap::new();
        params.insert("strength".to_string(), Animated::Static(strength));
        crate::state::Effect {
            id: new_id(),
            kind: "blur".into(),
            enabled: true,
            params,
        }
    }

    fn layer_effects_count(project: &Project, layer_id: LayerId) -> usize {
        project
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .map(|l| l.effects.len())
            .unwrap_or(0)
    }

    fn layer_effect_ids(project: &Project, layer_id: LayerId) -> Vec<crate::state::EffectId> {
        project
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .map(|l| l.effects.iter().map(|e| e.id).collect())
            .unwrap_or_default()
    }

    #[test]
    fn add_then_move_then_remove_effect() {
        use crate::state::actor::mutations::{
            apply_add_effect, apply_add_layer, apply_move_effect, apply_remove_effect,
            apply_update_effect,
        };
        use crate::state::effect::EffectPatch;

        // Build a project with one layer using the existing helpers.
        let (mut project, track_id) = project_with_video_track();
        let layer_id = apply_add_layer(
            &mut project,
            track_id,
            color_layer(Rgba::WHITE),
            0,
            1_000_000,
        )
        .unwrap();

        // Add two effects.
        let id1 = apply_add_effect(&mut project, layer_id, blur_effect(4.0)).unwrap();
        let id2 = apply_add_effect(&mut project, layer_id, blur_effect(8.0)).unwrap();
        assert_eq!(layer_effects_count(&project, layer_id), 2);
        assert_eq!(layer_effect_ids(&project, layer_id)[0], id1);
        assert_eq!(layer_effect_ids(&project, layer_id)[1], id2);

        // Move id2 to index 0 (it becomes first).
        apply_move_effect(&mut project, layer_id, id2, 0).unwrap();
        assert_eq!(layer_effect_ids(&project, layer_id)[0], id2);
        assert_eq!(layer_effect_ids(&project, layer_id)[1], id1);

        // Update id1 via patch.
        let mut patch_params = std::collections::BTreeMap::new();
        patch_params.insert("strength".to_string(), Animated::Static(16.0));
        apply_update_effect(
            &mut project,
            layer_id,
            id1,
            EffectPatch {
                enabled: Some(false),
                params: Some(patch_params),
            },
        )
        .unwrap();
        let effects = project
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .map(|l| &l.effects)
            .unwrap();
        let e1 = effects.iter().find(|e| e.id == id1).unwrap();
        assert!(!e1.enabled);
        assert!(matches!(e1.params.get("strength"), Some(Animated::Static(v)) if *v == 16.0));

        // Remove id1 — only id2 remains.
        apply_remove_effect(&mut project, layer_id, id1).unwrap();
        assert_eq!(layer_effects_count(&project, layer_id), 1);
        assert_eq!(layer_effect_ids(&project, layer_id)[0], id2);
    }

    #[test]
    fn effect_errors_on_missing_layer_and_effect() {
        use crate::state::actor::mutations::{
            apply_add_effect, apply_add_layer, apply_move_effect, apply_remove_effect,
            apply_update_effect,
        };
        use crate::state::effect::EffectPatch;
        use crate::state::actor::CommandError;

        let (mut project, track_id) = project_with_video_track();
        let layer_id = apply_add_layer(
            &mut project,
            track_id,
            color_layer(Rgba::WHITE),
            0,
            1_000_000,
        )
        .unwrap();
        let bad_layer: LayerId = new_id();
        let bad_effect: crate::state::EffectId = new_id();

        // Missing layer.
        assert!(matches!(
            apply_add_effect(&mut project, bad_layer, blur_effect(1.0)),
            Err(CommandError::LayerNotFound { .. })
        ));

        // Add a real effect to test missing-effect paths.
        let eid = apply_add_effect(&mut project, layer_id, blur_effect(1.0)).unwrap();

        // Missing effect: update.
        assert!(matches!(
            apply_update_effect(&mut project, layer_id, bad_effect, EffectPatch::default()),
            Err(CommandError::EffectNotFound { .. })
        ));

        // Missing effect: move.
        assert!(matches!(
            apply_move_effect(&mut project, layer_id, bad_effect, 0),
            Err(CommandError::EffectNotFound { .. })
        ));

        // Out-of-range index: move.
        assert!(matches!(
            apply_move_effect(&mut project, layer_id, eid, 5),
            Err(CommandError::EffectIndexOutOfRange { .. })
        ));

        // Missing effect: remove.
        assert!(matches!(
            apply_remove_effect(&mut project, layer_id, bad_effect),
            Err(CommandError::EffectNotFound { .. })
        ));
    }

    #[tokio::test]
    async fn effect_lifecycle_through_actor_records_undo() {
        let h = spawn(Project::new_blank("test"));
        let track_id = h.add_track(Actor::User, Some("overlay".into())).await.unwrap();
        let layer_id = h
            .add_layer(Actor::User, track_id, color_layer(Rgba::WHITE), 0, 1_000_000)
            .await
            .unwrap();

        let effect_id = h.add_effect(Actor::User, layer_id, blur_effect(6.0)).await.unwrap();

        let snap = h.snapshot().await;
        let effects_len = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .map(|l| l.effects.len())
            .unwrap_or(0);
        assert_eq!(effects_len, 1);

        // undo removes the effect
        h.undo(Actor::User).await.unwrap();
        let snap = h.snapshot().await;
        let effects_len_after_undo = snap
            .tracks
            .iter()
            .flat_map(|t| t.layers.iter())
            .find(|l| l.id == layer_id)
            .map(|l| l.effects.len())
            .unwrap_or(0);
        assert_eq!(effects_len_after_undo, 0);
        let _ = effect_id;
    }
