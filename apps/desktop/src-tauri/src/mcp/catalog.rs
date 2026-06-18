//! One declarative table feeds BOTH `tool_catalog()` (the advertised schemas)
//! and `dispatch_tool()` (the name→handler match), so a tool can never appear
//! in one without the other. Each entry's description is copied verbatim from
//! the pre-S4a `#[tool(description = …)]` attribute.

use crate::napi_backend::Backend;
use super::wire::{McpCatalog, McpToolError, PromptDef, ResourceDef, ToolDef, ToolResult};
use super::{prompts, resources, tools};

macro_rules! tool_table {
    ( $( $(#[$meta:meta])* $name:literal => ($desc:expr, $args:ty, $handler:path) ),* $(,)? ) => {
        pub(crate) fn tool_catalog() -> Vec<ToolDef> {
            vec![ $(
                $(#[$meta])*
                ToolDef {
                    name: $name.to_string(),
                    description: $desc.to_string(),
                    input_schema: serde_json::to_value(schemars::schema_for!($args))
                        .expect("schema serializes"),
                }
            ),* ]
        }
        pub(crate) async fn dispatch_tool(b: &Backend, name: &str, args_json: &str)
            -> Result<ToolResult, McpToolError>
        {
            match name {
                $( $(#[$meta])* $name => {
                    let a: $args = serde_json::from_str(args_json)
                        .map_err(|e| McpToolError::invalid_params(
                            format!("invalid args for {}: {e}", $name), None))?;
                    $handler(b, a).await
                } )*
                other => Err(McpToolError::resource_not_found(
                    format!("unknown tool '{other}'"), None)),
            }
        }
    };
}

tool_table! {
    "ping" => ("Liveness check. Returns 'pong' to confirm the WeftCut MCP server is reachable.", super::EmptyArgs, tools::ping),
    "begin_agent_session" => ("Enter agent mode: flip the human's UI to a simplified preview / scrub / \
                          record-only layout while the agent makes changes. `reason` is a short \
                          free-text label shown in the record panel header (e.g. 'cutting filler \
                          words'). Creates an automatic checkpoint named 'Pre-agent: {reason}' so \
                          the human can revert the entire session in one click. Calling this while \
                          already in agent mode replaces the session. The human exits via the UI; \
                          there is no end_agent_session tool.", tools::BeginAgentSessionArgs, tools::begin_agent_session),
    "add_track" => ("Add a new track to the project. Returns the new track id as a UUID string. \
                          Tracks are kind-agnostic — any layer kind can be placed on any track.", tools::AddTrackArgs, tools::add_track),
    "remove_track" => ("Remove a track. Rejects if the track has layers unless force=true. \
                          Default A roll / B roll tracks cannot be removed.", tools::RemoveTrackArgs, tools::remove_track),
    "move_track" => ("Move a track to a different z-order position. 0 = bottom of stack. \
                          Position must be < current track count.", tools::MoveTrackArgs, tools::move_track),
    "add_color_layer" => ("Add a solid-color layer to a track. Returns the new layer id. \
                          `t_start_us` and `t_end_us` are timeline microseconds (start inclusive, end exclusive). \
                          Layer cannot overlap existing layers on the same track.", tools::AddColorLayerArgs, tools::add_color_layer),
    "add_video_layer" => ("Add a video clip layer pulling a slice of an imported media item onto a track. \
                          `src_in_us`/`src_out_us` are the in/out points within the source media. \
                          `t_start_us`/`t_end_us` are where the clip lives on the timeline. \
                          The two ranges should be the same length unless `speed` is later changed. \
                          When the source media has an audio stream and the project's \
                          `auto_pair_audio_on_import` setting is on (default), this also creates a \
                          paired Audio layer on an audio track at the same time bounds and groups the \
                          two so they move/trim/split together. Returns either the video layer id \
                          (legacy mode) or `{ video_layer_id, audio_layer_id, group_id }` when a pair \
                          was created.", tools::AddVideoLayerArgs, tools::add_video_layer),
    "apply_subtitles" => ("Add a Subtitles layer that burns an inline SRT or ASS body onto the timeline. \
                          The body is stored in the project (so it round-trips through .vproj) and \
                          materialized to a content-addressed file in the OS app cache before render. \
                          `format` is 'srt' or 'ass'; if omitted it sniffs from the body. \
                          `track_id` is optional — if omitted, picks the first existing Subtitle track \
                          or creates one named 'Subtitles'. Returns the new layer id.", tools::ApplySubtitlesArgs, tools::apply_subtitles),
    #[cfg(feature = "jobs")]
    "detect_silences" => ("Find silent regions in a VideoClip or Audio layer using the pre-computed \
                          waveform. Walks the layer's peaks file (binary VPEAKS at 100 peaks/sec) and \
                          returns timeline-absolute ranges where every peak stays below `threshold_amp` \
                          for at least `min_silence_us` microseconds. Defaults: `threshold_amp=0.02` \
                          (-34 dBFS), `min_silence_us=500000` (0.5s). Use the returned ranges to feed \
                          `split_layer` + `delete_layer` and produce a tighter cut. \
                          Returns `[{ t_start_us, t_end_us }, ...]` sorted by t_start_us. Errors with \
                          `NotReady` if the waveform job hasn't finished yet — wait for a \
                          `media:job_complete` event with `kind=waveform` and retry.", tools::DetectSilencesArgs, tools::detect_silences),
    "update_layer" => ("Update a layer's envelope (label, time range, enabled, locked). \
                          Only fields you set are applied. Time range changes go through validation.", tools::UpdateLayerArgs, tools::update_layer),
    "update_layer_params" => ("Update a layer's kind-specific params. \
                          The patch is tagged with `kind` ('Text' | 'VideoClip' | 'ImageOverlay' | 'Color' | 'Audio') \
                          and must match the layer's kind. \
                          Audio fields take real effect in both preview and export: `gain_db` (dB; this \
                          patch sets a STATIC value, replacing any existing keyframes on the track), \
                          `pan` (-1..1 equal-power, same static-replace semantics), \
                          `fade_in_us`/`fade_out_us` (linear edge fades), `mute`, and \
                          `role` (one of dialogue/music/sfx/voiceover) to reassign the clip's mixing role.", tools::UpdateLayerParamsArgs, tools::update_layer_params),
    "move_layer" => ("Move a layer to a different track and/or start time. The end time shifts \
                          by the same delta. Cross-track moves are validated against the destination's \
                          existing layers — overlap rejects with structured options.", tools::MoveLayerArgs, tools::move_layer),
    "split_layer" => ("Split a layer into two halves at the given timeline microsecond. \
                          Returns {left, right} layer ids. `at_t_us` must be strictly between the layer's \
                          t_start_us and t_end_us. For media-bearing layers (VideoClip, Audio) the source \
                          offsets are adjusted at speed=1 — variable speed support is deferred.", tools::SplitLayerArgs, tools::split_layer),
    "delete_layer" => ("Delete a layer. When the project setting `auto_delete_empty_tracks` is on \
                          (default) and this empties a non-reserved, unlocked track, the track is \
                          deleted in the same history entry (one undo restores both). A/B-roll and \
                          other role-stamped tracks always stay.", tools::LayerIdArgs, tools::delete_layer),
    "trim_layer" => ("Trim one edge of a layer's timeline range. `edge` is 'in' (t_start) or 'out' (t_end). \
                          For media-bearing layers the corresponding src bound (src_in_us or src_out_us) moves \
                          by the same delta; over-trimming past the source bound is clamped. \
                          When the layer is in a group and `escape_group` is false (default), every group \
                          member whose corresponding edge sits at the same t as the trimmed edge is moved \
                          by the same delta, clamped to the tightest aligned member's bounds. Pass \
                          `escape_group=true` to trim only this layer. See `docs/groups.md`.", tools::TrimLayerArgs, tools::trim_layer),
    "groups_list" => ("List every group in the project. Each entry has `id`, optional `label`, and the \
                          set of member `layer_ids`. Empty array when no groups exist. Membership is flat — \
                          a layer is in at most one group.", super::EmptyArgs, tools::groups_list),
    "groups_get" => ("Read a single group by id. Returns `{ id, label, layer_ids }` or NotFound.", tools::GroupIdArgs, tools::groups_get),
    "groups_create" => ("Create a new group from >=2 distinct layer ids. Optional `label`. \
                          If any layer is already in another group, the op fails unless `reassign=true`, \
                          which removes them from their prior group(s) first (auto-dissolving any group \
                          that falls below 2 members). Returns the new group id.", tools::GroupsCreateArgs, tools::groups_create),
    "groups_dissolve" => ("Dissolve (delete) a group. The member layers themselves are not deleted.", tools::GroupIdArgs, tools::groups_dissolve),
    "groups_add_members" => ("Add member layers to an existing group. Same reassign semantics as groups_create.", tools::GroupsAddMembersArgs, tools::groups_add_members),
    "groups_remove_members" => ("Remove member layers from a group. If the remaining membership falls below 2, \
                          the group auto-dissolves.", tools::GroupsRemoveMembersArgs, tools::groups_remove_members),
    "groups_rename" => ("Update a group's label. Pass `label: null` to clear it.", tools::GroupsRenameArgs, tools::groups_rename),
    "duplicate_layer" => ("Duplicate a layer with a time offset. The copy is inserted on the same track. \
                          Returns the new layer id. The composition duration extends if needed.", tools::DuplicateLayerArgs, tools::duplicate_layer),
    "get_param_track" => ("Read a layer param's animation track, flattened for editing. Returns \
                          {\"mode\":\"Static\",\"value\":n} or {\"mode\":\"Keyframed\",\"keyframes\":[{id, \
                          t_us, t_local_us, value, interp}]}. `t_us` is timeline-absolute; `t_local_us` is \
                          layer-local (the stored base). Use this to discover keyframe ids before editing.", super::keyframes::GetParamTrackArgs, tools::get_param_track),
    "set_keyframe" => ("Insert or update a keyframe on a layer param. `t_us` is timeline-absolute. \
                          A Static track is lifted to Keyframed. An existing key at the same frame is \
                          updated in place. `interp` (optional) sets the easing for the segment leaving \
                          this key (e.g. {\"kind\":\"Linear\"}, {\"kind\":\"EaseIn\"}, \
                          {\"kind\":\"Bezier\",\"p1\":[x,y],\"p2\":[x,y]}); omit to inherit the preceding \
                          key's easing (or Linear).", super::keyframes::SetKeyframeArgs, tools::set_keyframe),
    "remove_keyframe" => ("Remove a keyframe by id from a layer param. Get the id from get_param_track. \
                          When it was the last key, the track collapses to Static holding that key's value.", super::keyframes::RemoveKeyframeArgs, tools::remove_keyframe),
    "retime_keyframe" => ("Move a keyframe to a new timeline-absolute time. The track re-sorts.", super::keyframes::RetimeKeyframeArgs, tools::retime_keyframe),
    "set_keyframe_easing" => ("Set the easing of the segment leaving a keyframe. `interp`: {\"kind\":\"Hold\"} | \
                          {\"kind\":\"Linear\"} | {\"kind\":\"EaseIn\"} | {\"kind\":\"EaseOut\"} | \
                          {\"kind\":\"Bezier\",\"p1\":[x,y],\"p2\":[x,y]}.", super::keyframes::SetKeyframeEasingArgs, tools::set_keyframe_easing),
    "smooth_keyframes" => ("Bake monotone (no-overshoot) smooth tangents. With `keyframe_id`, smooths that \
                          one key; without it, smooths the whole track.", super::keyframes::SmoothKeyframesArgs, tools::smooth_keyframes),
    "clear_keyframes" => ("Collapse a param's animation back to a single Static value. `value` (optional) \
                          is the value to hold; when omitted, defaults to the first keyframe's value. \
                          No-op on an already-Static track.", super::keyframes::ClearKeyframesArgs, tools::clear_keyframes),
    "set_param_track" => ("Low-level: replace a layer param's whole animation track. `track` is an \
                          AnimTrack<f64>: {\"mode\":\"Static\",\"value\":n} or \
                          {\"mode\":\"Keyframed\",\"value\":[{id, t_us, value, interp}]} with keyframe \
                          `t_us` timeline-absolute. Use the granular tools (set_keyframe etc.) unless you \
                          need bulk authoring.", super::keyframes::SetParamTrackArgs, tools::set_param_track),
    "set_composition" => ("Update composition envelope (canvas size, fps, sample rate, channels, color space, background, duration). \
                          Only fields you set are applied. Width/height must be positive; fps denominator must be non-zero. \
                          Setting `duration_us` pins the composition duration — subsequent layer edits will no longer \
                          auto-fit it (except an overflow guard if a layer extends past the pinned value). Use \
                          `fit_composition_to_layers` to clear the pin and snap duration back to the layer high-water mark.", tools::SetCompositionArgs, tools::set_composition),
    "fit_composition_to_layers" => ("Clear the composition's duration pin and set `duration_us` to `max(layer.t_end_us)`. \
                          The inverse of `set_composition { duration_us }`: that pins, this unpins. After this \
                          call, subsequent layer edits track duration in both directions (grow on adds, shrink \
                          on deletes/inward trims).", super::EmptyArgs, tools::fit_composition_to_layers),
    "add_marker" => ("Add a marker (point or region) to the timeline. Returns the new marker id. \
                          Set `end_t_us` to make it a region marker.", tools::AddMarkerArgs, tools::add_marker),
    "update_marker" => ("Update a marker. Setting `t_us` re-sorts the marker list.", tools::UpdateMarkerArgs, tools::update_marker),
    "remove_marker" => ("Remove a marker.", tools::MarkerIdArgs, tools::remove_marker),
    #[cfg(feature = "jobs")]
    "import_media" => ("Import a media file from an absolute path. Hashes the file (blake3) and probes \
                          metadata via ffprobe when installed. Returns the new media id.", tools::ImportMediaArgs, tools::import_media),
    "remove_media" => ("Remove a media item. Rejects if any layer references it unless force=true. \
                          With force=true, also deletes the referencing layers in one atomic commit.", tools::RemoveMediaArgs, tools::remove_media),
    "undo" => ("Undo the most recent edit (linear history). Errors with NothingToUndo at the origin. \
                          Only timeline edits (layers, tracks, markers, transitions, composition duration, and \
                          cascade-deleting media removals) record onto the undo stack. The following sit OUTSIDE it \
                          and are unaffected by undo: media imports and removals of unreferenced media, canvas \
                          setup changes (width/height/fps/sample_rate/channels/color_space/background), and \
                          loading or creating a project (which resets history).", super::EmptyArgs, tools::undo),
    "redo" => ("Redo the next edit. Errors with NothingToRedo if no redo is available. \
                          A new commit truncates the redo tail.", super::EmptyArgs, tools::redo),
    "lock_history" => ("Block the user from reverting (undo / redo / restore_checkpoint) while \
                          the agent is mid-batch. `reason` is shown next to the lock badge in the \
                          record-panel header and as the error returned to revert attempts. \
                          Last-writer-wins. Always pair with an unlock_history call; releases \
                          also happen on workspace change and on user-side agent-mode exit.", tools::LockHistoryArgs, tools::lock_history),
    "unlock_history" => ("Release the revert-lock taken by lock_history. Idempotent — calling \
                          while already unlocked is a no-op.", super::EmptyArgs, tools::unlock_history),
    "checkpoint" => ("Create an explicit named checkpoint of the current state. \
                          Checkpoints survive new commits (they don't get truncated like the redo tail) \
                          and persist in the .vproj save file. Returns the new checkpoint id. \
                          The human's agent-mode record panel renders each created checkpoint as a \
                          pin-style row with a Restore button — use this at logical batch boundaries.", tools::CheckpointArgs, tools::checkpoint),
    "list_checkpoints" => ("List all named checkpoints, oldest first. Returns id, label, actor, created_at \
                          per checkpoint (no project snapshot).", super::EmptyArgs, tools::list_checkpoints),
    "restore_checkpoint" => ("Restore a named checkpoint. Records a new history entry — undo will return to the \
                          pre-restore state. Errors with CheckpointNotFound if the id doesn't exist. \
                          The agent-mode record panel prunes the rolled-back agent actions from view; \
                          a small '↩ Restored to <label>' row marks the boundary.", tools::RestoreCheckpointArgs, tools::restore_checkpoint),
    "dry_run" => ("Try-run a sequence of edit operations against a clone of the current project \
                          WITHOUT committing. Useful for previewing complex multi-step edits — agents \
                          can detect overlap / invariant violations before mutating real state. \
                          Validates after each op (matching real `commit()` behaviour) and HALTS at \
                          the first error so subsequent ops don't dry-run against a state real \
                          execution wouldn't reach. Returns `{ results: [{ index, status, output? \
                          | error? }, ...] }`. \
                          Supports add_color_layer, add_video_layer, update_layer, \
                          update_layer_params, move_layer, split_layer, delete_layer. Other tools \
                          (motifs, subtitles, media import, undo/redo) are not dry-runnable in v1.", tools::DryRunArgs, tools::dry_run),
    "set_role_gain" => ("Set an audio role's mix gain (dB). role ∈ {dialogue,music,sfx,voiceover}. \
                          Recorded (undoable). Folds into every layer of that role at mix time.", tools::SetRoleGainArgs, tools::set_role_gain),
    "set_role_flags" => ("Mute/solo an audio role. role ∈ {dialogue,music,sfx,voiceover}. \
                          Unrecorded (not undoable). Mute wins over solo; any solo silences non-soloed roles.", tools::SetRoleFlagsArgs, tools::set_role_flags),
    #[cfg(feature = "cloud")]
    "transcribe_clip" => ("Transcribe a VideoClip or Audio layer through the configured cloud transcription \
                          provider (OpenAI Whisper today) and return the SRT body with timestamps already \
                          shifted to timeline-absolute microseconds. Pipe the returned body straight into \
                          `apply_subtitles` (omit `t_start_us` so the layer activates from 0 — the cues \
                          self-position via their internal timestamps). Optional `t_start_us`/`t_end_us` \
                          narrow the transcription window inside the layer's time range; both default to \
                          the layer endpoints. VideoClip layers with speed != 1.0 are rejected — split off \
                          a speed-1 segment first. Errors with structured messages if no API key is \
                          configured, the audio slice exceeds the provider cap (~13 min for Whisper at \
                          25 MB), or the provider rate-limits / rejects auth.", tools::TranscribeClipArgs, tools::transcribe_clip),
    #[cfg(feature = "cloud")]
    "synthesize_speech" => ("Synthesize speech via the configured cloud TTS provider (OpenAI tts-1 today) \
                          and attach the result as an Audio layer. The MP3 is content-addressed in cache \
                          by `(model, voice, speed, text)`, so a repeat call with the same args reuses \
                          the cached file without burning another API request. \
                          Args: `text` (≤4096 chars for tts-1), `voice` (one of alloy/echo/fable/onyx/nova/shimmer), \
                          optional `speed` (0.25..4.0; default = provider default ≈1.0), \
                          optional `target_track_id` (defaults to first existing Audio track or a new \
                          'Voiceover' track), optional `t_start_us` (defaults to the composition's \
                          current duration so the voiceover appends at the end). Returns \
                          `{ layer_id, media_id, t_start_us, t_end_us, cached }`.", tools::SynthesizeSpeechArgs, tools::synthesize_speech),
}

pub(crate) fn resource_catalog() -> Vec<ResourceDef> {
    resources::static_resources()
}
pub(crate) fn prompt_catalog() -> Vec<PromptDef> {
    prompts::catalog()
}
pub(crate) fn catalog() -> McpCatalog {
    McpCatalog {
        tools: tool_catalog(),
        resources: resource_catalog(),
        prompts: prompt_catalog(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table feeds both surfaces from one source — every advertised tool
    /// must be dispatchable. Smoke: catalog is non-empty and `ping` dispatches.
    #[tokio::test]
    async fn ping_dispatches_to_pong() {
        use std::sync::Arc;
        let b = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let r = dispatch_tool(&b, "ping", "{}").await.unwrap();
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["content"][0]["text"], "pong");
    }

    #[tokio::test]
    async fn unknown_tool_is_not_found() {
        use std::sync::Arc;
        let b = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let err = dispatch_tool(&b, "does_not_exist", "{}").await.unwrap_err();
        assert_eq!(err.code, super::super::wire::McpErrorCode::NotFound);
    }

    #[test]
    fn catalog_advertises_tools_resources_prompts() {
        let cat = catalog();
        assert!(cat.tools.iter().any(|t| t.name == "ping"));
        assert!(cat.tools.iter().any(|t| t.name == "add_track"));
        assert!(cat.resources.iter().any(|r| r.uri == "project://current"));
        assert!(cat.prompts.iter().any(|p| p.name == "cut-silences"));
    }

    #[cfg(feature = "cloud")]
    #[test]
    fn catalog_advertises_cloud_tools() {
        let cat = catalog();
        assert!(cat.tools.iter().any(|t| t.name == "transcribe_clip"));
        assert!(cat.tools.iter().any(|t| t.name == "synthesize_speech"));
        // every advertised tool must dispatch — schema is an object.
        for t in &cat.tools {
            assert!(t.input_schema.is_object(), "{} schema not an object", t.name);
        }
    }
}
