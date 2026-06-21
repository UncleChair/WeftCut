use super::*;

// ============================================================
// Pure mutation helpers — shared by `do_*` (real execution) and the
// `dry_run` dispatcher. These NEVER validate, record history, or
// broadcast events; that's the caller's responsibility. Each function
// either mutates `project` and returns its result, or short-circuits
// with a `CommandError` and leaves `project` in a partially-modified
// state — callers MUST clone the project first (or, for dry_run, drop
// the working clone on error).

/// Reconcile `composition.duration_us` against the layer high-water mark.
///
/// When `duration_pinned` is false (the default), the composition follows
/// `max(layer.t_end_us)` bidirectionally — growing on adds and **shrinking**
/// on deletes/inward trims. When pinned (set by an explicit
/// `set_composition { duration_us }`), the value is held except for an
/// overflow guard: if a new layer pushes past the pinned duration we still
/// extend (otherwise the `duration_us >= max(layer.t_end_us)` invariant
/// would break), but the pin stays set. `fit_composition_to_layers` is the
/// only way to clear the pin.
///
/// See `docs/adr/0005-composition-duration-auto-fits.md`. Callers in every
/// layer-shape mutation path (`apply_add_layer`, `apply_delete_layer`,
/// `apply_move_layer`, `apply_trim_layer`, `do_duplicate_layer`) invoke
/// this after the layer mutation; missing a site is the failure mode the
/// helper exists to prevent.
pub(crate) fn apply_duration_autofit(project: &mut Project) {
    let max_end = project
        .tracks
        .iter()
        .flat_map(|t| t.layers.iter().map(|l| l.t_end_us))
        .max()
        .unwrap_or(0);
    if project.composition.duration_pinned {
        if max_end > project.composition.duration_us {
            project.composition.duration_us = max_end;
        }
    } else {
        project.composition.duration_us = max_end;
    }
}

/// Mutation half of `do_add_layer`. Inserts a new layer on `track_id` at
/// the t-start-sorted position. Reconciles composition duration via
/// `apply_duration_autofit`.
pub(crate) fn apply_add_layer(
    project: &mut Project,
    track_id: TrackId,
    params: LayerParams,
    t_start_us: TimeUs,
    t_end_us: TimeUs,
) -> Result<LayerId, CommandError> {
    // Storage invariant: every persisted layer t_start_us/t_end_us is
    // on a composition-frame boundary. Snap on entry so every caller
    // — UI, MCP, future agents — produces aligned state without
    // duplicating the rule.
    let t_start_us = crate::state::time::snap_frame_round(t_start_us, project.composition.fps);
    let t_end_us = crate::state::time::snap_frame_round(t_end_us, project.composition.fps);
    let track_idx = project
        .tracks
        .iter()
        .position(|t| t.id == track_id)
        .ok_or(CommandError::TrackNotFound { track: track_id })?;
    let layer_id = new_id();
    let new_layer = Layer {
        id: layer_id,
        label: None,
        t_start_us,
        t_end_us,
        enabled: true,
        locked: false,
        metadata: imbl::HashMap::new(),
        params,
        effects: vec![],
    };
    let track = project
        .tracks
        .get_mut(track_idx)
        .expect("index just verified");
    let insert_at = track
        .layers
        .iter()
        .position(|l| l.t_start_us > t_start_us)
        .unwrap_or(track.layers.len());
    track.layers.insert(insert_at, new_layer);
    apply_duration_autofit(project);
    Ok(layer_id)
}

/// Reject if the track owning `id` is locked. Shared early guard for the
/// per-layer write paths — locked tracks are a hard "don't touch" promise
/// actor-side, so every mutation entry point (delete / envelope update /
/// params update, alongside the move/trim/split guards) must bounce before
/// touching anything. Maps a missing layer to `LayerNotFound`, matching the
/// callers' existing not-found semantics.
fn check_track_lock(project: &Project, id: LayerId) -> Result<(), CommandError> {
    let (ti, _) = locate_layer(project, id).ok_or(CommandError::LayerNotFound { layer: id })?;
    let track = &project.tracks[ti];
    if track.locked {
        return Err(CommandError::TrackLocked { track: track.id });
    }
    Ok(())
}

/// Mutation half of `do_delete_layer`. Also removes the layer from any
/// group it belongs to and auto-dissolves the group when its member count
/// drops below 2 (`docs/groups.md` invariant #3). Returns the id of the
/// track that the deletion emptied and `prune_emptied_track` removed (if
/// any) so the caller can fold it into the same history entry.
pub(crate) fn apply_delete_layer(
    project: &mut Project,
    id: LayerId,
) -> Result<Option<TrackId>, CommandError> {
    // Locked tracks reject deletion — guard before any mutation.
    check_track_lock(project, id)?;
    let mut source_track: Option<TrackId> = None;
    for track in project.tracks.iter_mut() {
        if let Some(idx) = track.layers.iter().position(|l| l.id == id) {
            track.layers.remove(idx);
            source_track = Some(track.id);
            break;
        }
    }
    let Some(source_track) = source_track else {
        return Err(CommandError::LayerNotFound { layer: id });
    };
    drop_layer_from_groups(project, id);
    // A deletion can orphan an empty import-created hidden track; prune it.
    // Reserved tracks survive via their role stamp.
    prune_empty_hidden_tracks(project);
    let pruned = prune_emptied_track(project, source_track);
    apply_duration_autofit(project);
    Ok(pruned)
}

/// `settings.auto_delete_empty_tracks`: drop the track a deletion just
/// emptied, within the same pending mutation, so layer + track land in one
/// history entry. Role-stamped tracks stay even when `removable` (legacy
/// projects predate the `removable` field and deserialize it `true`, so
/// the role stamp is the load-bearing guard for their A/B skeleton);
/// non-removable and locked tracks stay too. Transient tracks are already
/// gone via `prune_empty_hidden_tracks`.
fn prune_emptied_track(project: &mut Project, track_id: TrackId) -> Option<TrackId> {
    if !project.settings.auto_delete_empty_tracks {
        return None;
    }
    let idx = project.tracks.iter().position(|t| t.id == track_id)?;
    let track = &project.tracks[idx];
    if !track.layers.is_empty() || !track.removable || track.role.is_some() || track.locked {
        return None;
    }
    project.tracks.remove(idx);
    Some(track_id)
}

/// Remove `layer_id` from every group it appears in and auto-dissolve any
/// group whose member count drops below 2. Used by both `apply_delete_layer`
/// and the explicit `apply_groups_remove_members` reassignment path.
pub(crate) fn drop_layer_from_groups(project: &mut Project, layer_id: LayerId) {
    let mut i = 0;
    while i < project.groups.len() {
        let g = &mut project.groups[i];
        if g.members.contains(&layer_id) {
            g.members.remove(&layer_id);
            if g.members.len() < 2 {
                project.groups.remove(i);
                continue;
            }
        }
        i += 1;
    }
}

/// `docs/groups.md` — create a new group from the given layer ids.
/// Requires ≥2 distinct existing layers. If any target is already in
/// another group, fails with `LayerAlreadyGrouped` unless `reassign`,
/// which removes them from their prior group(s) (auto-dissolving below 2)
/// before creating the new group.
pub(crate) fn apply_groups_create(
    project: &mut Project,
    layer_ids: Vec<LayerId>,
    label: Option<String>,
    reassign: bool,
) -> Result<GroupId, CommandError> {
    let unique: imbl::OrdSet<LayerId> = layer_ids.into_iter().collect();
    if unique.len() < 2 {
        return Err(CommandError::GroupCreateNeedsTwoLayers { got: unique.len() });
    }
    let known = layer_id_set(project);
    for &m in unique.iter() {
        if !known.contains(&m) {
            return Err(CommandError::LayerNotFound { layer: m });
        }
    }
    let idx = crate::state::group::index_groups(&project.groups);
    for &m in unique.iter() {
        if let Some(&existing) = idx.get(&m) {
            if !reassign {
                return Err(CommandError::LayerAlreadyGrouped {
                    layer: m,
                    existing,
                });
            }
        }
    }
    if reassign {
        for &m in unique.iter() {
            drop_layer_from_groups(project, m);
        }
    }
    let id = new_id();
    project.groups.push_back(Group {
        id,
        label,
        members: unique,
    });
    Ok(id)
}

pub(crate) fn apply_groups_dissolve(
    project: &mut Project,
    id: GroupId,
) -> Result<(), CommandError> {
    let idx = project
        .groups
        .iter()
        .position(|g| g.id == id)
        .ok_or(CommandError::GroupNotFound { group: id })?;
    project.groups.remove(idx);
    Ok(())
}

pub(crate) fn apply_groups_add_members(
    project: &mut Project,
    id: GroupId,
    layer_ids: Vec<LayerId>,
    reassign: bool,
) -> Result<(), CommandError> {
    let known = layer_id_set(project);
    for &m in layer_ids.iter() {
        if !known.contains(&m) {
            return Err(CommandError::LayerNotFound { layer: m });
        }
    }
    let idx_map = crate::state::group::index_groups(&project.groups);
    for &m in layer_ids.iter() {
        if let Some(&existing) = idx_map.get(&m) {
            if existing == id {
                continue; // already a member of the target group
            }
            if !reassign {
                return Err(CommandError::LayerAlreadyGrouped {
                    layer: m,
                    existing,
                });
            }
        }
    }
    if reassign {
        for &m in layer_ids.iter() {
            if idx_map.get(&m).copied() != Some(id) {
                drop_layer_from_groups(project, m);
            }
        }
    }
    let gi = project
        .groups
        .iter()
        .position(|g| g.id == id)
        .ok_or(CommandError::GroupNotFound { group: id })?;
    let group = &mut project.groups[gi];
    for &m in layer_ids.iter() {
        group.members.insert(m);
    }
    Ok(())
}

pub(crate) fn apply_groups_remove_members(
    project: &mut Project,
    id: GroupId,
    layer_ids: Vec<LayerId>,
) -> Result<(), CommandError> {
    let gi = project
        .groups
        .iter()
        .position(|g| g.id == id)
        .ok_or(CommandError::GroupNotFound { group: id })?;
    {
        let group = &project.groups[gi];
        for &m in layer_ids.iter() {
            if !group.members.contains(&m) {
                return Err(CommandError::LayerNotInGroup { group: id, layer: m });
            }
        }
    }
    let group = &mut project.groups[gi];
    for &m in layer_ids.iter() {
        group.members.remove(&m);
    }
    if group.members.len() < 2 {
        project.groups.remove(gi);
    }
    Ok(())
}

pub(crate) fn apply_groups_rename(
    project: &mut Project,
    id: GroupId,
    label: Option<String>,
) -> Result<(), CommandError> {
    let gi = project
        .groups
        .iter()
        .position(|g| g.id == id)
        .ok_or(CommandError::GroupNotFound { group: id })?;
    project.groups[gi].label = label;
    Ok(())
}

fn layer_id_set(project: &Project) -> std::collections::HashSet<LayerId> {
    let mut s = std::collections::HashSet::new();
    for t in project.tracks.iter() {
        for l in t.layers.iter() {
            s.insert(l.id);
        }
    }
    s
}

/// Mutation half of `do_update_layer` — envelope-only patch.
pub(crate) fn apply_update_layer(
    project: &mut Project,
    id: LayerId,
    patch: &LayerPatch,
) -> Result<(), CommandError> {
    // Locked tracks reject envelope edits (incl. t_start/t_end) — guard
    // before any mutation.
    check_track_lock(project, id)?;
    for track in project.tracks.iter_mut() {
        if let Some(idx) = track.layers.iter().position(|l| l.id == id) {
            let layer = track.layers.get_mut(idx).expect("index just verified");
            if let Some(label) = patch.label.clone() {
                layer.label = Some(label);
            }
            if let Some(t_start) = patch.t_start_us {
                layer.t_start_us = t_start;
            }
            if let Some(t_end) = patch.t_end_us {
                layer.t_end_us = t_end;
            }
            if let Some(enabled) = patch.enabled {
                layer.enabled = enabled;
            }
            if let Some(locked) = patch.locked {
                layer.locked = locked;
            }
            return Ok(());
        }
    }
    Err(CommandError::LayerNotFound { layer: id })
}

/// Mutation half of `do_update_layer_params` — kind-specific patch.
/// `apply_params_patch` (below) is already a pure helper; this is a thin
/// locate-then-patch wrapper.
///
/// For Motif layers, after applying the patch, the content-window invariant
/// (`src_in + width <= content_dur`) is enforced. Growing the content cap never
/// resizes the layer; shrinking it below the current window clamps `src_in` and
/// `t_end` into the new content.
pub(crate) fn apply_update_layer_params(
    project: &mut Project,
    id: LayerId,
    patch: &LayerParamsPatch,
) -> Result<(), CommandError> {
    // Locked tracks reject params edits — guard before any mutation.
    check_track_lock(project, id)?;
    let fps = project.composition.fps;

    // Locate by index so the &mut borrow is released before apply_duration_autofit.
    let (ti, li) = project
        .tracks
        .iter()
        .enumerate()
        .find_map(|(ti, t)| t.layers.iter().position(|l| l.id == id).map(|li| (ti, li)))
        .ok_or(CommandError::LayerNotFound { layer: id })?;

    apply_params_patch(&mut project.tracks[ti].layers[li], patch, id)?;

    // Content-window model: editing the cap-driving prop (`seconds`) changes the
    // intrinsic content, NOT the layer geometry — EXCEPT when the content shrinks
    // below the current window, where we clamp src_in + t_end into the new
    // content (the longer content no longer exists). Growing never resizes.
    let mut geom_changed = false;
    {
        let layer = &mut project.tracks[ti].layers[li];
        let t_start = layer.t_start_us;
        let t_end = layer.t_end_us;

        let catalog = crate::motifs::catalog::builtins();
        let clamp: Option<(i64, i64)> = if let LayerParams::Motif(ref tp) = layer.params {
            motif_cap_us(&catalog, &layer.params)
                .and_then(|content_dur| {
                    let src_in = tp.src_in_us;
                    let width = t_end - t_start;
                    // src_out (derived) must fit in [0, content_dur].
                    if src_in + width <= content_dur {
                        return None; // grow / within content → no geometry change
                    }
                    // Clamp the window start into content (keep >= 0, < content_dur).
                    // Floor (not round) so new_src_in can never round UP toward
                    // content_dur on off-grid fractional-`seconds` caps. src_in is
                    // already grid-aligned; min() keeps it < content_dur.
                    let max_src_in = (content_dur - 1).max(0);
                    // Double-snap (floor then round) so new_src_in lands on the
                    // canonical round grid (Rust snap_frame_floor truncates its
                    // µs output and can sit 1µs below grid on /1001 rates). Floor
                    // first keeps it < content_dur; round canonicalises the µs.
                    let new_src_in = crate::state::time::snap_frame_round(
                        crate::state::time::snap_frame_floor(src_in.min(max_src_in), fps),
                        fps,
                    );
                    // Largest grid t_end whose derived src_out stays <= content_dur.
                    let capped_end = crate::state::time::snap_frame_round(
                        crate::state::time::snap_frame_floor(
                            t_start.saturating_add(content_dur.saturating_sub(new_src_in)),
                            fps,
                        ),
                        fps,
                    );
                    // Never collapse below a single µs (no frame_dur_us helper exists;
                    // snap_frame_round already guarantees grid alignment, and this floor
                    // only guards the degenerate content_dur <= 0 case).
                    let new_t_end = capped_end.max(t_start.saturating_add(1));
                    Some((new_src_in, new_t_end))
                })
        } else {
            None
        };

        if let Some((new_src_in, new_t_end)) = clamp {
            if let LayerParams::Motif(ref mut tp) = layer.params {
                tp.src_in_us = new_src_in;
            }
            layer.t_end_us = new_t_end;
            geom_changed = true;
        }
    }

    if geom_changed {
        apply_duration_autofit(project);
    }
    Ok(())
}

pub(crate) fn apply_update_layer_param_track(
    project: &mut Project,
    id: LayerId,
    param_key: &str,
    mut track: Animated<f64>,
) -> Result<(), CommandError> {
    // Locked tracks reject writes — guard before any mutation.
    check_track_lock(project, id)?;
    let fps = project.composition.fps;
    track.normalize_keyframes(|t| crate::state::time::snap_frame_round(t, fps))
        .map_err(|()| CommandError::EmptyKeyframeTrack { layer: id, param_key: param_key.to_string() })?;
    let (ti, li) = project
        .tracks
        .iter()
        .enumerate()
        .find_map(|(ti, t)| t.layers.iter().position(|l| l.id == id).map(|li| (ti, li)))
        .ok_or(CommandError::LayerNotFound { layer: id })?;
    let slot = crate::state::layer::resolve_animated_f64_mut(
        &mut project.tracks[ti].layers[li].params,
        param_key,
    )
    .ok_or_else(|| CommandError::UnknownKeyframeParam { layer: id, param_key: param_key.to_string() })?;
    *slot = track;
    // No `apply_duration_autofit`: writing a keyframe track to a param never
    // changes a layer's t_start/t_end, so composition duration can't shift.
    Ok(())
}

/// Mutation half of `do_move_layer`. Removes layer from its current track,
/// shifts its end time by the same delta as its start, inserts at the
/// t-sorted position on the destination track, and auto-extends composition
/// duration if needed. When the layer is in a group and `escape_group=false`,
/// also shifts every group sibling's `t_start_us` / `t_end_us` by the same
/// delta (`docs/groups.md` — move propagates time only, tracks stay
/// local). Locked siblings — or siblings on locked tracks — reject the
/// whole op.
pub(crate) fn apply_move_layer(
    project: &mut Project,
    id: LayerId,
    new_track_id: TrackId,
    new_t_start_us: TimeUs,
    escape_group: bool,
) -> Result<(), CommandError> {
    // Snap on entry — storage invariant per apply_add_layer.
    let new_t_start_us =
        crate::state::time::snap_frame_round(new_t_start_us, project.composition.fps);
    // Locate the target layer to compute the delta before we mutate anything.
    let (src_ti, src_li) =
        locate_layer(project, id).ok_or(CommandError::LayerNotFound { layer: id })?;
    let cur_start = project.tracks[src_ti].layers[src_li].t_start_us;
    // Reject if the source track is locked.
    {
        let src_track = &project.tracks[src_ti];
        if src_track.locked {
            return Err(CommandError::TrackLocked { track: src_track.id });
        }
    }
    // Reject if the destination track is locked (cross-track move).
    if new_track_id != project.tracks[src_ti].id {
        if let Some(dst) = project.tracks.iter().find(|t| t.id == new_track_id) {
            if dst.locked {
                return Err(CommandError::TrackLocked { track: new_track_id });
            }
        }
    }
    let delta = new_t_start_us - cur_start;

    // If grouped & not escaped, identify the sibling members we'll shift and
    // reject up-front on any locked member (including the target itself).
    let siblings: Vec<LayerId> = if escape_group {
        Vec::new()
    } else {
        group_siblings_excluding(project, id)
    };
    if !escape_group && !siblings.is_empty() {
        // Target counts as a "touched" layer for lock-check purposes.
        check_group_lock(project, id, std::iter::once(id).chain(siblings.iter().copied()))?;
    }

    // Move the target layer itself (existing behavior).
    let mut moved: Option<Layer> = None;
    for track in project.tracks.iter_mut() {
        if let Some(idx) = track.layers.iter().position(|l| l.id == id) {
            moved = Some(track.layers.remove(idx));
            break;
        }
    }
    let mut layer = moved.expect("layer existence already verified");
    layer.t_start_us = new_t_start_us;
    // Re-snap t_end_us to the comp-fps grid. At 30 fps the half-up grid
    // has alternating 33_333 / 33_334 µs frame widths, so shifting by a
    // raw delta can land t_end 1 µs past a grid point and overhang into
    // the next composition frame — symptom: an N-frame layer occludes
    // N+1 timeline frames after a move. Storage invariant per
    // apply_add_layer: both edges live on the grid.
    layer.t_end_us =
        crate::state::time::snap_frame_round(layer.t_end_us + delta, project.composition.fps);
    let dest_idx = project
        .tracks
        .iter()
        .position(|t| t.id == new_track_id)
        .ok_or(CommandError::TrackNotFound { track: new_track_id })?;
    let dest = project
        .tracks
        .get_mut(dest_idx)
        .expect("index just verified");
    let insert_at = dest
        .layers
        .iter()
        .position(|l| l.t_start_us > new_t_start_us)
        .unwrap_or(dest.layers.len());
    dest.layers.insert(insert_at, layer);

    // Group siblings FOLLOW to the destination track and shift by the same
    // delta — tracks are kind-agnostic, so a sibling lives on whichever track
    // the anchor was dragged onto. escape_group skips this; siblings stay put.
    if !escape_group {
        for &sid in siblings.iter() {
            let Some((ti, li)) = locate_layer(project, sid) else {
                continue;
            };
            let on_dest = project.tracks[ti].id == new_track_id;
            // Remove the sibling from its current track. If it's
            // already on the destination, we still need to lift +
            // reinsert so the time shift can be applied cleanly and
            // the in-track sort order stays correct.
            let mut s = project.tracks[ti].layers.remove(li);
            if delta != 0 {
                // Re-snap both edges after shift. The raw delta keeps
                // sibling edges integer-µs but can land 1 µs off the
                // half-up grid (frame widths alternate 33_333 / 33_334
                // at 30 fps) when the anchor and sibling sat on grid
                // points whose duration parity differs — same overhang
                // hazard fixed for the moved anchor above.
                let fps = project.composition.fps;
                s.t_start_us =
                    crate::state::time::snap_frame_round(s.t_start_us + delta, fps);
                s.t_end_us =
                    crate::state::time::snap_frame_round(s.t_end_us + delta, fps);
            }
            s.t_start_us = s.t_start_us.max(0);
            let dest_idx = project
                .tracks
                .iter()
                .position(|t| t.id == new_track_id)
                .expect("destination track verified above");
            let s_start = s.t_start_us;
            let insert_at = project.tracks[dest_idx]
                .layers
                .iter()
                .position(|l| l.t_start_us > s_start)
                .unwrap_or(project.tracks[dest_idx].layers.len());
            project.tracks[dest_idx].layers.insert(insert_at, s);
            // No-op note: `on_dest` is informational — we lift and
            // reinsert on the destination regardless to apply the
            // time delta uniformly.
            let _ = on_dest;
        }
    }

    apply_duration_autofit(project);

    // A/B-roll redesign R.4: prune empty hidden tracks left behind by the
    // move. Reserved (role-stamped) tracks survive (their `role.is_some()`).
    // Tracks marked non-removable also survive in case any future code
    // path stamps that without a role.
    prune_empty_hidden_tracks(project);

    Ok(())
}

/// Remove every `transient` track (the "fresh hidden track per import" path)
/// that has zero layers.
///
/// Scope is deliberately narrow — only import-spawned transient holding tracks.
/// Broadening to "any hidden empty track" would falsely prune caller-managed
/// auto-create paths like `ensure_audio_track`. Reserved (role-stamped) tracks
/// survive — the permanent skeleton; tracks a user or agent explicitly creates
/// survive too — their author owns the lifecycle.
pub(crate) fn prune_empty_hidden_tracks(project: &mut Project) {
    project.tracks.retain(|t| !(t.transient && t.layers.is_empty()));
}

/// Locate `(track_idx, layer_idx)` for a given LayerId. Returns None if
/// the layer doesn't exist in the project.
pub(crate) fn locate_layer(project: &Project, id: LayerId) -> Option<(usize, usize)> {
    for (ti, track) in project.tracks.iter().enumerate() {
        if let Some(li) = track.layers.iter().position(|l| l.id == id) {
            return Some((ti, li));
        }
    }
    None
}

/// All other members of `id`'s group (empty when ungrouped).
fn group_siblings_excluding(project: &Project, id: LayerId) -> Vec<LayerId> {
    let idx = crate::state::group::index_groups(&project.groups);
    let Some(&gid) = idx.get(&id) else {
        return Vec::new();
    };
    let Some(group) = project.groups.iter().find(|g| g.id == gid) else {
        return Vec::new();
    };
    group.members.iter().copied().filter(|&m| m != id).collect()
}

/// Reject if any of `touched` is `locked`, or lives on a locked track.
/// Used by group-aware ops to honour both `Layer.locked` and
/// `Track.locked` as hard "don't touch" promises — group fan-out must
/// never mutate a member on a locked track even when the anchor's own
/// track is unlocked (cross-track AV groups are the common case).
fn check_group_lock<I: IntoIterator<Item = LayerId>>(
    project: &Project,
    touched_anchor: LayerId,
    touched: I,
) -> Result<(), CommandError> {
    let idx = crate::state::group::index_groups(&project.groups);
    let gid = match idx.get(&touched_anchor) {
        Some(&g) => g,
        None => return Ok(()),
    };
    for id in touched {
        if let Some((ti, li)) = locate_layer(project, id) {
            let track = &project.tracks[ti];
            if track.locked {
                return Err(CommandError::TrackLocked { track: track.id });
            }
            let layer = &track.layers[li];
            if layer.locked {
                return Err(CommandError::GroupLockedMember {
                    group: gid,
                    locked_layer: id,
                    touched: touched_anchor,
                });
            }
        }
    }
    Ok(())
}

/// Mutation half of `do_split_layer`. Returns `(left_id, right_id)` — left
/// reuses the original layer id; right gets a freshly-allocated one.
///
/// When the layer is in a group and `escape_group=false`, every group
/// member whose interval strictly contains `at_t_us` is also split at
/// `at_t_us`, with both halves staying in the same group (`docs/groups.md`
/// — split spans, group survives). Locked spanning members
/// reject the whole op.
pub(crate) fn apply_split_layer(
    project: &mut Project,
    id: LayerId,
    at_t_us: TimeUs,
    escape_group: bool,
) -> Result<(LayerId, LayerId), CommandError> {
    // Snap on entry — storage invariant per apply_add_layer.
    let at_t_us = crate::state::time::snap_frame_round(at_t_us, project.composition.fps);
    // Pre-flight on the target: existence + valid split point + track not locked.
    {
        let (ti, li) = locate_layer(project, id).ok_or(CommandError::LayerNotFound { layer: id })?;
        // Reject if the owning track is locked.
        let track = &project.tracks[ti];
        if track.locked {
            return Err(CommandError::TrackLocked { track: track.id });
        }
        let l = &track.layers[li];
        if at_t_us <= l.t_start_us || at_t_us >= l.t_end_us {
            return Err(CommandError::SplitOutsideLayer { layer: id, at_t: at_t_us });
        }
    }

    // Identify spanning siblings (members whose interval strictly contains
    // `at_t_us`). Non-spanning members are unchanged.
    let spanning_siblings: Vec<LayerId> = if escape_group {
        Vec::new()
    } else {
        let siblings = group_siblings_excluding(project, id);
        siblings
            .into_iter()
            .filter(|&s| {
                locate_layer(project, s)
                    .map(|(ti, li)| {
                        let l = &project.tracks[ti].layers[li];
                        l.t_start_us < at_t_us && at_t_us < l.t_end_us
                    })
                    .unwrap_or(false)
            })
            .collect()
    };
    if !escape_group {
        check_group_lock(
            project,
            id,
            std::iter::once(id).chain(spanning_siblings.iter().copied()),
        )?;
    }

    // Split the target layer (and gather (left_id, right_id) to return).
    let (target_left, target_right) = split_single_layer(project, id, at_t_us)?;

    // Split each spanning sibling at the same time. Each gets a fresh
    // right-half LayerId; both halves are members of the same group, so
    // we patch the group's `members` set to add the right-half id (the
    // left-half keeps the original id, which is already in `members`).
    for &sid in spanning_siblings.iter() {
        let (_, right_id) = split_single_layer(project, sid, at_t_us)?;
        // Insert the new right-half into whichever group `sid` is in.
        let gidx = crate::state::group::index_groups(&project.groups);
        if let Some(&gid) = gidx.get(&sid) {
            if let Some(g) = project.groups.iter_mut().find(|g| g.id == gid) {
                g.members.insert(right_id);
            }
        }
    }
    // Also add the target's right-half to its group, if any.
    {
        let gidx = crate::state::group::index_groups(&project.groups);
        if let Some(&gid) = gidx.get(&target_left) {
            if let Some(g) = project.groups.iter_mut().find(|g| g.id == gid) {
                g.members.insert(target_right);
            }
        }
    }
    Ok((target_left, target_right))
}

/// Partition one `Animated<T>` track for a split at clip-local `split_offset`.
/// `right=false` (LEFT half): keep keys with `t_us <= split_offset`.
/// `right=true`  (RIGHT half): keep keys with `t_us > split_offset`, rebased
/// by `-split_offset`. If the half ends up an empty `Keyframed`, collapse it to
/// `Static` at the clamp-boundary value (LEFT→first key, RIGHT→last key) so the
/// half keeps the value the clip actually showed instead of the engine fallback.
fn split_track_half<T: Clone>(a: &mut Animated<T>, split_offset: TimeUs, right: bool) {
    let boundary = if right { a.last_keyframe_value() } else { a.first_keyframe_value() };
    if right {
        a.retain_keyframes(|t| t > split_offset);
        a.shift_keyframes(-split_offset);
    } else {
        a.retain_keyframes(|t| t <= split_offset);
    }
    let emptied = matches!(a, Animated::Keyframed(kfs) if kfs.is_empty());
    if emptied {
        if let Some(v) = boundary {
            *a = Animated::Static(v);
        }
    }
}

/// Single-layer split helper — the part that doesn't know about groups.
/// Returns `(left_id, right_id)`; left reuses the original LayerId.
fn split_single_layer(
    project: &mut Project,
    id: LayerId,
    at_t_us: TimeUs,
) -> Result<(LayerId, LayerId), CommandError> {
    // Snap on entry — idempotent with apply_split_layer's snap so other
    // callers (group spanning splits) hit the invariant too.
    let at_t_us = crate::state::time::snap_frame_round(at_t_us, project.composition.fps);
    let (ti, li) = locate_layer(project, id).ok_or(CommandError::LayerNotFound { layer: id })?;
    let original = project.tracks[ti].layers[li].clone();
    if at_t_us <= original.t_start_us || at_t_us >= original.t_end_us {
        return Err(CommandError::SplitOutsideLayer { layer: id, at_t: at_t_us });
    }
    let split_offset = at_t_us - original.t_start_us;
    let catalog = crate::motifs::catalog::builtins();
    let mut right = original.clone();
    right.id = new_id();
    right.t_start_us = at_t_us;
    right.t_end_us = original.t_end_us;
    // Resolve the cap flag from an immutable borrow BEFORE match &mut right.params.
    let right_capped = motif_cap_us(&catalog, &right.params).is_some();
    match &mut right.params {
        LayerParams::VideoClip(p) => {
            p.src_in_us = p.src_in_us + split_offset;
        }
        LayerParams::Audio(p) => {
            p.src_in_us = p.src_in_us + split_offset;
        }
        LayerParams::Motif(p) => {
            // Only capped motifs window content (see apply_trim_layer). An
            // uncapped motif keeps src_in_us = 0 across a split.
            if right_capped {
                p.src_in_us = p.src_in_us + split_offset;
            }
        }
        _ => {}
    }
    crate::state::layer::for_each_animated_f64(&mut right.params, |a| split_track_half(a, split_offset, true));
    crate::state::layer::for_each_animated_rgba(&mut right.params, |a| split_track_half(a, split_offset, true));
    let mut left = original.clone();
    left.t_end_us = at_t_us;
    match &mut left.params {
        LayerParams::VideoClip(p) => {
            p.src_out_us = p.src_in_us + split_offset;
        }
        LayerParams::Audio(p) => {
            p.src_out_us = p.src_in_us + split_offset;
        }
        // Motif has no stored src_out (derived from layer width); left half needs no change.
        _ => {}
    }
    crate::state::layer::for_each_animated_f64(&mut left.params, |a| split_track_half(a, split_offset, false));
    crate::state::layer::for_each_animated_rgba(&mut left.params, |a| split_track_half(a, split_offset, false));
    let track = &mut project.tracks[ti];
    track.layers[li] = left;
    let insert_at = li + 1;
    let right_id = right.id;
    track.layers.insert(insert_at, right);
    Ok((id, right_id))
}

/// `docs/groups.md` — trim one edge of a layer's timeline range.
/// When grouped and `escape_group=false`, fan out the same delta to every
/// member whose corresponding edge sits at the *same* `t` as the trimmed
/// layer's pre-trim edge. Clamp the delta to the most-restrictive aligned
/// member (source-bound or `t_start < t_end` constraint).
pub(crate) fn apply_trim_layer(
    project: &mut Project,
    id: LayerId,
    edge: LayerEdge,
    new_t_us: TimeUs,
    escape_group: bool,
) -> Result<(), CommandError> {
    // Snap on entry — storage invariant per apply_add_layer.
    let new_t_us = crate::state::time::snap_frame_round(new_t_us, project.composition.fps);
    let (ti, li) = locate_layer(project, id).ok_or(CommandError::LayerNotFound { layer: id })?;
    // Reject if the owning track is locked.
    {
        let track = &project.tracks[ti];
        if track.locked {
            return Err(CommandError::TrackLocked { track: track.id });
        }
    }
    let target = &project.tracks[ti].layers[li];
    let cur_start = target.t_start_us;
    let cur_end = target.t_end_us;
    let cur_edge_t = match edge {
        LayerEdge::In => cur_start,
        LayerEdge::Out => cur_end,
    };

    // Identify the aligned set: members (including the target) whose
    // matching edge sits at `cur_edge_t`. The target is always aligned.
    let aligned: Vec<LayerId> = if escape_group {
        vec![id]
    } else {
        let mut v = vec![id];
        for sid in group_siblings_excluding(project, id) {
            if let Some((sti, sli)) = locate_layer(project, sid) {
                let s = &project.tracks[sti].layers[sli];
                let s_edge_t = match edge {
                    LayerEdge::In => s.t_start_us,
                    LayerEdge::Out => s.t_end_us,
                };
                if s_edge_t == cur_edge_t {
                    v.push(sid);
                }
            }
        }
        v
    };
    if !escape_group {
        check_group_lock(project, id, aligned.iter().copied())?;
    }

    let requested_delta = new_t_us - cur_edge_t;
    if requested_delta == 0 {
        return Ok(());
    }

    // Compute the most-restrictive allowed delta across all aligned members.
    // For an `In` trim, the delta moves t_start by +delta; constraints:
    //   - new_t_start < t_end (so delta < cur_dur)
    //   - new_t_start >= 0 (so delta >= -t_start)
    //   - for media-bearing kinds: new src_in = src_in + delta within
    //     [0, src_out)
    // For an `Out` trim, the delta moves t_end by +delta; constraints:
    //   - new_t_end > t_start (so delta > -cur_dur)
    //   - for media-bearing kinds: new src_out = src_out + delta within
    //     (src_in, media_duration] (we don't know media_duration here, so
    //     we cap at src_out monotonicity vs src_in only; over-trim past
    //     media tail will be caught by `validate_src_range`).
    // Resolve the motif catalog once; the per-member cap lookup below is
    // a cheap find over this (Motif layers only — everything else stays
    // unbounded). Built once outside the loop so a group of motifs pays
    // the catalog cost a single time.
    let catalog = crate::motifs::catalog::builtins();
    // The motif cap bound is re-snapped to the composition frame grid, so
    // grab the fps before the immutable-borrow loop below.
    let fps = project.composition.fps;
    let clamped_delta = {
        let mut d = requested_delta;
        for &mid in aligned.iter() {
            let (mti, mli) = locate_layer(project, mid).expect("aligned member exists");
            let m = &project.tracks[mti].layers[mli];
            // A Motif member's length cap comes from its manifest —
            // either the static `max_duration_s` or, when the manifest names a
            // `max_duration_prop`, THIS member's own prop value (so editing the
            // prop changes the cap live). Resolve per-member so a group mixing a
            // capped motif with an uncapped one (or non-motif) clamps each
            // by its own bound. Unknown id / absent cap → None → unbounded.
            let motif_max_dur_us = motif_cap_us(&catalog, &m.params);
            let bounds = trim_delta_bounds(m, edge, motif_max_dur_us, fps);
            d = clamp_signed(d, bounds.min, bounds.max);
        }
        d
    };
    if clamped_delta == 0 {
        // The clamped op would be a no-op — surface as TrimEdgeOutOfRange
        // so the caller knows the request was rejected rather than silently
        // succeeded.
        return Err(CommandError::TrimEdgeOutOfRange {
            layer: id,
            new_t: new_t_us,
            cur_start,
            cur_end,
        });
    }

    // Apply the clamped delta to every aligned member's matching edge,
    // updating src_* for media-bearing kinds.
    for &mid in aligned.iter() {
        let (mti, mli) = locate_layer(project, mid).expect("aligned member exists");
        // Resolve the cap flag with an immutable borrow BEFORE taking &mut below;
        // the borrow checker requires the immutable borrow to end first.
        let capped = motif_cap_us(&catalog, &project.tracks[mti].layers[mli].params).is_some();
        let m = &mut project.tracks[mti].layers[mli];
        match edge {
            LayerEdge::In => {
                m.t_start_us += clamped_delta;
                match &mut m.params {
                    LayerParams::VideoClip(p) => {
                        p.src_in_us += clamped_delta;
                    }
                    LayerParams::Audio(p) => {
                        p.src_in_us += clamped_delta;
                    }
                    LayerParams::Motif(p) => {
                        // Only capped motifs window their content; an uncapped
                        // motif (holdable overlay) keeps src_in_us = 0 — its
                        // content animates over the layer width from frame 0.
                        // (No uncapped builtin exists today, so this guard is
                        // forward-looking; capped motifs still scrub.)
                        if capped {
                            p.src_in_us += clamped_delta;
                        }
                    }
                    _ => {}
                }
                // Keep keyframes glued to content: the IN edge moved by
                // `clamped_delta`, so every keyframe (layer-relative) shifts by
                // the opposite amount. Keys that fall before the new start go
                // negative and are kept in data (rendered out-of-range / hidden
                // by the UI), so trimming is non-destructive and reversible.
                crate::state::layer::for_each_animated_f64(&mut m.params, |a| {
                    a.shift_keyframes(-clamped_delta);
                });
                crate::state::layer::for_each_animated_rgba(&mut m.params, |a| {
                    a.shift_keyframes(-clamped_delta);
                });
            }
            LayerEdge::Out => {
                m.t_end_us += clamped_delta;
                match &mut m.params {
                    LayerParams::VideoClip(p) => {
                        p.src_out_us += clamped_delta;
                    }
                    LayerParams::Audio(p) => {
                        p.src_out_us += clamped_delta;
                    }
                    // Motif: no stored `src_out` — the content window's end is
                    // derived from the layer width (t_end_us - t_start_us). The
                    // OUT-edge cap in trim_delta_bounds keeps it within content.
                    _ => {}
                }
            }
        }
    }

    // The `In` trim can move a layer's start time backwards within its
    // track; re-sort the affected tracks to maintain the sort invariant.
    if matches!(edge, LayerEdge::In) {
        let touched_tracks: std::collections::HashSet<TrackId> = aligned
            .iter()
            .filter_map(|m| locate_layer(project, *m).map(|(ti, _)| project.tracks[ti].id))
            .collect();
        for tid in touched_tracks {
            if let Some(t) = project.tracks.iter_mut().find(|t| t.id == tid) {
                let mut sorted: Vec<Layer> = t.layers.iter().cloned().collect();
                sorted.sort_by_key(|l| l.t_start_us);
                t.layers = sorted.into();
            }
        }
    }

    apply_duration_autofit(project);
    Ok(())
}

/// Resolve a Motif layer's content-duration cap (µs) from a pre-built
/// motif `catalog` + the layer's params. `None` for non-motif params,
/// unknown motif ids, or uncapped motifs. Single source of truth for
/// "what is this motif's window/content cap" across trim, split, and the
/// seconds-edit clamp — keep all cap lookups going through here so they can't
/// drift (cf. the snap-math / engine-source drift hazards in this codebase).
fn motif_cap_us(
    catalog: &[crate::motifs::catalog::Motif],
    params: &LayerParams,
) -> Option<i64> {
    match params {
        LayerParams::Motif(tp) => catalog
            .iter()
            .find(|t| t.id() == tp.motif_id)
            .and_then(|t| crate::motifs::catalog::resolve_motif_max_dur_us(&t.manifest, &tp.props)),
        _ => None,
    }
}

#[derive(Clone, Copy)]
pub(crate) struct DeltaBounds {
    pub(crate) min: i64,
    pub(crate) max: i64,
}

/// Allowable signed `delta` such that applying it to `edge` of `layer`
/// keeps the layer geometrically valid (`t_start < t_end`, src window
/// non-negative).
///
/// `motif_max_dur_us` is the per-motif length cap (from the manifest's
/// `max_duration_s`), applied *only* when `layer` is a `Motif`. It binds
/// both edges so the total length `dur` can't grow past the cap, AND so the
/// capped edge lands on the composition frame grid (the hard storage
/// invariant — every persisted `t_start_us`/`t_end_us` must be frame-snapped):
///   - OUT: the capped `t_end` is `round∘floor(t_start + cap)` — the largest
///     grid point whose length stays `<= cap` (floor → never rounds up past
///     the cap), so `delta <= that - t_end`.
///   - IN:  the capped `t_start` is `round∘ceil(t_end - cap)` — the smallest
///     grid point whose length stays `<= cap`, so `delta >= that - t_start`.
///
/// The raw cap (`max_duration_s * 1e6`) is absolute µs and need not sit on the
/// grid (e.g. `countdown`'s 5.0s = 5_000_000µs is off-grid at 29.97 fps), so
/// the bound must be re-snapped here. `floor`/`ceil` pick the cap-respecting
/// frame; the outer `round` canonicalises to the round-grid (`snap_frame_floor`
/// truncates its µs output and isn't round-idempotent on /1001 rates, so the
/// raw floor value can land 1µs below a grid point — re-rounding fixes that
/// while staying `<= target`, since `round_output(n) <= n_exact <= target`).
///
/// For a capped motif, `src_in_us` (the window offset into content) shifts
/// the bounds: the IN edge is floored at `-src_in_us` (can't scrub before
/// content frame 0), and the OUT cap uses `cap - src_in_us` (the derived
/// `src_out` can't pass content end). For `src_in_us == 0` both are identical
/// to the original cap math.
///
/// `fps` is the composition frame rate used for the snap. `None`
/// (no cap, or a non-motif layer) keeps the historical unbounded behavior
/// so holdable overlays (lower-thirds) stay freely extendable.
pub(crate) fn trim_delta_bounds(
    layer: &Layer,
    edge: LayerEdge,
    motif_max_dur_us: Option<i64>,
    fps: Rational,
) -> DeltaBounds {
    let dur = layer.t_end_us - layer.t_start_us;
    let inf = i64::MAX / 4; // large enough to feel infinite, small enough to clamp safely
    // The cap applies only to Motif layers with a declared cap; everything
    // else is unbounded.
    let motif_cap = match (&layer.params, motif_max_dur_us) {
        (LayerParams::Motif(_), Some(cap)) => Some(cap),
        _ => None,
    };
    // The window start for a capped motif (0 for non-motif / uncapped).
    let motif_src_in = match (&layer.params, motif_cap) {
        (LayerParams::Motif(p), Some(_)) => p.src_in_us,
        _ => 0,
    };
    match edge {
        LayerEdge::In => {
            // delta > -t_start (keep timeline start >= 0)
            // delta < dur (keep t_start < t_end)
            let timeline_min = -layer.t_start_us;
            let timeline_max = dur - 1;
            // Source-bound (only for media-bearing kinds): src_in + delta >= 0
            //                                              src_in + delta < src_out
            let (src_min, src_max) = match &layer.params {
                LayerParams::VideoClip(p) => (-p.src_in_us, p.src_out_us - p.src_in_us - 1),
                LayerParams::Audio(p) => (-p.src_in_us, p.src_out_us - p.src_in_us - 1),
                LayerParams::Motif(_) if motif_cap.is_some() => (-motif_src_in, inf),
                _ => (-inf, inf),
            };
            // Motif cap: dragging the IN edge earlier (negative delta)
            // grows dur. The earliest grid-aligned t_start that keeps
            // length <= cap is `round∘ceil(t_end - cap)`; floor the resulting
            // delta at 0 so a layer already at/over the cap can't be forced to
            // shrink (the historical slack-at-0 behavior).
            let cap_min = match motif_cap {
                Some(cap) => {
                    use crate::state::time::{snap_frame_ceil, snap_frame_round};
                    // saturating_sub/saturating_sub guard against i64 overflow
                    // when an MCP caller passes an absurd `seconds` prop (e.g.
                    // 1e13 → cap saturates to i64::MAX via the f64→i64 cast in
                    // resolve_motif_max_dur_us). The snap functions widen to
                    // i128 internally and are safe for any i64 input; the
                    // second saturating_sub prevents the rare case where
                    // capped_start lands near i64::MIN and t_start_us > 0.
                    let capped_start = snap_frame_round(
                        snap_frame_ceil(layer.t_end_us.saturating_sub(cap), fps),
                        fps,
                    );
                    capped_start.saturating_sub(layer.t_start_us).min(0)
                }
                None => -inf,
            };
            DeltaBounds {
                min: timeline_min.max(src_min).max(cap_min),
                max: timeline_max.min(src_max),
            }
        }
        LayerEdge::Out => {
            // delta > -dur (keep t_end > t_start, so delta > -(dur-1) i.e. >= -(dur-1))
            // delta unbounded above (composition will auto-extend)
            let timeline_min = -(dur - 1);
            // Source-bound: src_out + delta > src_in
            // No media-duration check here — `validate_src_range` does it.
            let (src_min, src_max) = match &layer.params {
                LayerParams::VideoClip(p) => (-(p.src_out_us - p.src_in_us - 1), inf),
                LayerParams::Audio(p) => (-(p.src_out_us - p.src_in_us - 1), inf),
                _ => (-inf, inf),
            };
            // Motif cap: extending the OUT edge (positive delta) grows dur.
            // The latest grid-aligned t_end that keeps length <= cap is
            // `round∘floor(t_start + cap)`; ceil the resulting delta at 0 so a
            // layer already at/over the cap can't extend (slack-at-0).
            let cap_max = match motif_cap {
                Some(cap) => {
                    use crate::state::time::{snap_frame_floor, snap_frame_round};
                    // saturating_add/saturating_sub guard against i64 overflow
                    // on absurd prop-driven cap values (mirror of the IN-edge
                    // fix above). The snap functions handle any i64 via i128.
                    let capped_end = snap_frame_round(
                        snap_frame_floor(
                            layer
                                .t_start_us
                                .saturating_add(cap.saturating_sub(motif_src_in)),
                            fps,
                        ),
                        fps,
                    );
                    capped_end.saturating_sub(layer.t_end_us).max(0)
                }
                None => inf,
            };
            DeltaBounds {
                min: timeline_min.max(src_min),
                max: src_max.min(cap_max),
            }
        }
    }
}

fn clamp_signed(d: i64, min: i64, max: i64) -> i64 {
    if min > max {
        // Bounds collapsed — no movement allowed.
        return 0;
    }
    d.max(min).min(max)
}

/// Apply a `LayerParamsPatch` to a layer's `params` in place. Errors if the
/// patch's kind doesn't match the layer's current `LayerParams` discriminant.
pub(crate) fn apply_params_patch(
    layer: &mut Layer,
    patch: &LayerParamsPatch,
    id: LayerId,
) -> Result<(), CommandError> {
    match (&mut layer.params, patch) {
        (LayerParams::Text(p), LayerParamsPatch::Text(tp)) => {
            if let Some(c) = &tp.content {
                p.content = c.clone();
            }
            if let Some(f) = &tp.font_family {
                p.font.family = f.clone();
            }
            if let Some(s) = tp.font_size_px {
                p.font.size_px = s;
            }
            if let Some(c) = tp.color {
                p.color = Animated::Static(c);
            }
            if let Some(x) = tp.x {
                p.transform.x = Animated::Static(x);
            }
            if let Some(y) = tp.y {
                p.transform.y = Animated::Static(y);
            }
            if let Some(o) = tp.opacity {
                p.opacity = Animated::Static(o);
            }
            Ok(())
        }
        (LayerParams::VideoClip(p), LayerParamsPatch::VideoClip(vp)) => {
            if let Some(v) = vp.src_in_us {
                p.src_in_us = v;
            }
            if let Some(v) = vp.src_out_us {
                p.src_out_us = v;
            }
            if let Some(x) = vp.x {
                p.transform.x = Animated::Static(x);
            }
            if let Some(y) = vp.y {
                p.transform.y = Animated::Static(y);
            }
            if let Some(s) = vp.scale_x {
                p.transform.scale_x = Animated::Static(s);
            }
            if let Some(s) = vp.scale_y {
                p.transform.scale_y = Animated::Static(s);
            }
            if let Some(o) = vp.opacity {
                p.opacity = Animated::Static(o);
            }
            if let Some(s) = vp.speed {
                p.speed = s;
            }
            if let Some(b) = vp.flip_h {
                p.flip_h = b;
            }
            if let Some(b) = vp.flip_v {
                p.flip_v = b;
            }
            if let Some(v) = vp.fade_in_us {
                p.fade_in_us = v;
            }
            if let Some(v) = vp.fade_out_us {
                p.fade_out_us = v;
            }
            Ok(())
        }
        (LayerParams::ImageOverlay(p), LayerParamsPatch::ImageOverlay(ip)) => {
            if let Some(x) = ip.x {
                p.transform.x = Animated::Static(x);
            }
            if let Some(y) = ip.y {
                p.transform.y = Animated::Static(y);
            }
            if let Some(s) = ip.scale_x {
                p.transform.scale_x = Animated::Static(s);
            }
            if let Some(s) = ip.scale_y {
                p.transform.scale_y = Animated::Static(s);
            }
            if let Some(o) = ip.opacity {
                p.opacity = Animated::Static(o);
            }
            if let Some(v) = ip.fade_in_us {
                p.fade_in_us = v;
            }
            if let Some(v) = ip.fade_out_us {
                p.fade_out_us = v;
            }
            Ok(())
        }
        (LayerParams::Motif(p), LayerParamsPatch::Motif(tp)) => {
            if let Some(x) = tp.x {
                p.transform.x = Animated::Static(x);
            }
            if let Some(y) = tp.y {
                p.transform.y = Animated::Static(y);
            }
            if let Some(s) = tp.scale_x {
                p.transform.scale_x = Animated::Static(s);
            }
            if let Some(s) = tp.scale_y {
                p.transform.scale_y = Animated::Static(s);
            }
            if let Some(o) = tp.opacity {
                p.opacity = Animated::Static(o);
            }
            if let Some(v) = tp.src_in_us {
                p.src_in_us = v;
            }
            if let Some(id) = &tp.motif_id {
                p.motif_id = id.clone();
            }
            if let Some(v) = tp.motif_version {
                p.motif_version = v;
            }
            // Merge props field-wise — don't replace the whole map (see the
            // doc comment on `MotifPatch::props`).
            if let Some(props) = &tp.props {
                for (k, v) in props {
                    p.props.insert(k.clone(), v.clone());
                }
            }
            Ok(())
        }
        (LayerParams::Color(p), LayerParamsPatch::Color(cp)) => {
            if let Some(c) = cp.color {
                p.color = Animated::Static(c);
            }
            if let Some(w) = cp.width {
                p.width = w;
            }
            if let Some(h) = cp.height {
                p.height = h;
            }
            Ok(())
        }
        (LayerParams::Audio(p), LayerParamsPatch::Audio(ap)) => {
            if let Some(v) = ap.src_in_us {
                p.src_in_us = v;
            }
            if let Some(v) = ap.src_out_us {
                p.src_out_us = v;
            }
            if let Some(g) = ap.gain_db {
                p.gain_db = Animated::Static(g);
            }
            if let Some(p_) = ap.pan {
                p.pan = Animated::Static(p_);
            }
            if let Some(v) = ap.fade_in_us {
                p.fade_in_us = v;
            }
            if let Some(v) = ap.fade_out_us {
                p.fade_out_us = v;
            }
            if let Some(m) = ap.mute {
                p.mute = m;
            }
            if let Some(r) = ap.role {
                p.role = r;
            }
            Ok(())
        }
        (actual, patch) => Err(CommandError::LayerParamsKindMismatch {
            layer: id,
            actual: layer_params_kind(actual),
            patch: layer_params_patch_kind(patch),
        }),
    }
}

/// Extend a layer's `t_end_us` (and `src_out_us` for media-bearing layer
/// kinds) by `delta_us`. Used by `add_transition` to atomically create the
/// authorized overlap between two back-to-back clips. Validation downstream
/// catches the case where `src_out_us` runs off the end of the source media.
pub(crate) fn extend_layer_t_end(layer: &mut Layer, delta_us: TimeUs) {
    layer.t_end_us += delta_us;
    match &mut layer.params {
        LayerParams::VideoClip(p) => p.src_out_us += delta_us,
        LayerParams::Audio(p) => p.src_out_us += delta_us,
        _ => {}
    }
}

/// Inverse of [`extend_layer_t_end`]: shrink `t_end_us` (and `src_out_us`
/// for media-bearing layers) by `delta_us`. Used by `remove_transition` to
/// undo the auto-extension. Saturates at 0 so a buggy delta can't underflow.
pub(crate) fn shrink_layer_t_end(layer: &mut Layer, delta_us: TimeUs) {
    layer.t_end_us = (layer.t_end_us - delta_us).max(0);
    match &mut layer.params {
        LayerParams::VideoClip(p) => p.src_out_us = (p.src_out_us - delta_us).max(0),
        LayerParams::Audio(p) => p.src_out_us = (p.src_out_us - delta_us).max(0),
        _ => {}
    }
}

fn layer_params_kind(params: &LayerParams) -> &'static str {
    match params {
        LayerParams::VideoClip(_) => "VideoClip",
        LayerParams::ImageOverlay(_) => "ImageOverlay",
        LayerParams::Text(_) => "Text",
        LayerParams::Motif(_) => "Motif",
        LayerParams::Audio(_) => "Audio",
        LayerParams::Color(_) => "Color",
    }
}

fn layer_params_patch_kind(patch: &LayerParamsPatch) -> &'static str {
    match patch {
        LayerParamsPatch::Text(_) => "Text",
        LayerParamsPatch::VideoClip(_) => "VideoClip",
        LayerParamsPatch::ImageOverlay(_) => "ImageOverlay",
        LayerParamsPatch::Motif(_) => "Motif",
        LayerParamsPatch::Color(_) => "Color",
        LayerParamsPatch::Audio(_) => "Audio",
    }
}

// ============================================================
// Per-layer effect mutation helpers (Task 2)
// ============================================================

/// Append `effect` to `layer_id`'s effect chain. Returns the newly-added
/// effect's id (carried inside `effect.id`). Errors with `LayerNotFound`
/// if `layer_id` does not exist in the project.
pub(crate) fn apply_add_effect(
    project: &mut Project,
    layer_id: LayerId,
    effect: crate::state::effect::Effect,
) -> Result<crate::state::ids::EffectId, CommandError> {
    let id = effect.id;
    for track in project.tracks.iter_mut() {
        if let Some(idx) = track.layers.iter().position(|l| l.id == layer_id) {
            let layer = track.layers.get_mut(idx).expect("index just verified");
            layer.effects.push(effect);
            return Ok(id);
        }
    }
    Err(CommandError::LayerNotFound { layer: layer_id })
}

/// Apply `patch` to the effect identified by `effect_id` on `layer_id`.
/// `patch.enabled` replaces the flag; `patch.params` is merged key-by-key
/// into the effect's params map (insert/overwrite per key, no deletions).
/// Errors with `LayerNotFound` or `EffectNotFound` if either is absent.
pub(crate) fn apply_update_effect(
    project: &mut Project,
    layer_id: LayerId,
    effect_id: crate::state::ids::EffectId,
    patch: crate::state::effect::EffectPatch,
) -> Result<(), CommandError> {
    for track in project.tracks.iter_mut() {
        if let Some(idx) = track.layers.iter().position(|l| l.id == layer_id) {
            let layer = track.layers.get_mut(idx).expect("index just verified");
            let e = layer
                .effects
                .iter_mut()
                .find(|e| e.id == effect_id)
                .ok_or(CommandError::EffectNotFound { effect: effect_id })?;
            if let Some(enabled) = patch.enabled {
                e.enabled = enabled;
            }
            if let Some(params) = patch.params {
                for (k, v) in params {
                    e.params.insert(k, v);
                }
            }
            return Ok(());
        }
    }
    Err(CommandError::LayerNotFound { layer: layer_id })
}

/// Move the effect identified by `effect_id` to `new_index` within
/// `layer_id`'s effect chain (0 = first/topmost). Errors with `LayerNotFound`,
/// `EffectNotFound`, or `EffectIndexOutOfRange` (when `new_index >= len`).
pub(crate) fn apply_move_effect(
    project: &mut Project,
    layer_id: LayerId,
    effect_id: crate::state::ids::EffectId,
    new_index: usize,
) -> Result<(), CommandError> {
    for track in project.tracks.iter_mut() {
        if let Some(idx) = track.layers.iter().position(|l| l.id == layer_id) {
            let layer = track.layers.get_mut(idx).expect("index just verified");
            let from = layer
                .effects
                .iter()
                .position(|e| e.id == effect_id)
                .ok_or(CommandError::EffectNotFound { effect: effect_id })?;
            let len = layer.effects.len();
            if new_index >= len {
                return Err(CommandError::EffectIndexOutOfRange { index: new_index, len });
            }
            let e = layer.effects.remove(from);
            layer.effects.insert(new_index, e);
            return Ok(());
        }
    }
    Err(CommandError::LayerNotFound { layer: layer_id })
}

/// Remove the effect identified by `effect_id` from `layer_id`'s effect
/// chain. Errors with `LayerNotFound` or `EffectNotFound` if either is absent.
pub(crate) fn apply_remove_effect(
    project: &mut Project,
    layer_id: LayerId,
    effect_id: crate::state::ids::EffectId,
) -> Result<(), CommandError> {
    for track in project.tracks.iter_mut() {
        if let Some(idx) = track.layers.iter().position(|l| l.id == layer_id) {
            let layer = track.layers.get_mut(idx).expect("index just verified");
            let before = layer.effects.len();
            layer.effects.retain(|e| e.id != effect_id);
            if layer.effects.len() == before {
                return Err(CommandError::EffectNotFound { effect: effect_id });
            }
            return Ok(());
        }
    }
    Err(CommandError::LayerNotFound { layer: layer_id })
}
