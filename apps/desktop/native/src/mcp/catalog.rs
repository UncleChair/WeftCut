//! One declarative table feeds BOTH `tool_catalog()` (the advertised schemas)
//! and `dispatch_tool()` (the name→handler match), so a tool can never appear
//! in one without the other. Each entry's description is the literal text the
//! MCP catalog advertises to clients.
//!
//! Phase 4b T3: this table is trimmed to the native/compute/hybrid tools only.
//! The ~47 TS-executed mutations are served by the TS actor's `MCP_TOOLS` table
//! and routed by `routeMcpTool`; their Rust handlers are deleted.

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
        pub async fn dispatch_tool(b: &Backend, name: &str, args_json: &str)
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
    // begin_agent_session routes to the TS actor ('ts' MCP tool) and is supplied
    // by the TS def; mergeMcpCatalog filters it out of the Rust side (Phase 4b).
    "apply_subtitles" => ("Import a subtitle document (SRT/VTT/ASS) as a caption track of editable Text layers. \
                          Cue timings come from the body. `format` is sniffed when omitted. \
                          Advanced ASS styling (karaoke, drawings) is simplified. \
                          Returns the new caption track id.", tools::ApplySubtitlesArgs, tools::apply_subtitles),
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
    #[cfg(feature = "jobs")]
    "import_media" => ("Import a media file from an absolute path. Hashes the file (blake3) and probes \
                          metadata via ffprobe when installed. Returns the new media id.", tools::ImportMediaArgs, tools::import_media),
    #[cfg(feature = "cloud")]
    "transcribe_clip" => ("Transcribe a VideoClip or Audio layer through the configured cloud transcription \
                          provider (OpenAI Whisper today) and return the SRT body with timestamps already \
                          shifted to timeline-absolute microseconds. Pipe the returned body straight into \
                          `apply_subtitles` (the cues self-position into a new caption track via their \
                          internal timestamps — `apply_subtitles` takes no start/end). Optional `t_start_us`/`t_end_us` \
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
    #[cfg(feature = "motifs")]
    "list_motifs" => ("List every motif available to add via `add_motif` — built-ins PLUS installed and \
                          draft user motifs. Returns an array of `{ id, name, version, size: [w,h], \
                          default_duration_s, props_schema, status, content_hash, target_id? }` where \
                          `status` is `builtin` | `installed` | `draft`. Inspect `props_schema` before \
                          `add_motif` to know what keys + types each motif accepts; unknown keys reject. \
                          Drafts (status `draft`) are placeable immediately for preview.", super::EmptyArgs, tools::list_motifs),
    #[cfg(feature = "motifs")]
    "get_motif_source" => ("Read a Motif's source { manifest, html } — any built-in, installed, or draft. \
                          Read this before editing so you can base your changes on the current source. \
                          `id` comes from `list_motifs`.", tools::MotifIdArgs, tools::get_motif_source),
    #[cfg(feature = "motifs")]
    "write_motif_draft" => ("Write a Motif draft from { manifest, html }. Returns the draft id. The draft is \
                          placeable immediately (via `add_motif`) for preview, and re-writable. `from` \
                          (optional) records an existing Motif id as the draft's UPDATE target so a later \
                          `install_motif {mode:'update'}` republishes over it; omit `from` for a brand-new \
                          Motif (installs as new). The manifest's `id`/`version` are ignored — app-assigned. \
                          Expose tweakable controls via `props_schema`.", tools::WriteMotifDraftArgs, tools::write_motif_draft),
    #[cfg(feature = "motifs")]
    "preview_motif_draft" => ("Render one frame of a Motif (draft / installed / built-in) and return it as a \
                          base64-encoded PNG, so you can SEE your output and self-correct. Args: `id`, \
                          `t_sec` (content time), optional `width`/`height` (default = the motif's size), \
                          optional `props`. Requires the app's preview runtime to be live; returns an error \
                          (rather than hanging) if it isn't ready.", tools::PreviewMotifDraftArgs, tools::preview_motif_draft),
    #[cfg(feature = "motifs")]
    "install_motif" => ("Install a draft. mode 'new' publishes under the draft's own id; 'update' \
                          republishes over the draft's recorded UPDATE target (set via `write_motif_draft`'s \
                          `from`) — bumping its version so every placement re-renders, and rebinding + \
                          migrating current-project layers. Returns the published id.", tools::InstallMotifArgs, tools::install_motif),
    #[cfg(feature = "motifs")]
    "delete_motif" => ("Delete an installed or draft user Motif by id. Built-ins are rejected. Placed \
                          layers referencing it degrade to an error placeholder.", tools::MotifIdArgs, tools::delete_motif),
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
        assert!(cat.tools.iter().any(|t| t.name == "apply_subtitles"));
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

    /// apply_subtitles is a hybrid in Phase 4b: its Rust handler is a stub that
    /// returns an error (the TS host intercepts the real call). The catalog entry
    /// stays (asserted above); dispatch reaching the Rust stub errors cleanly.
    #[tokio::test]
    async fn apply_subtitles_rust_handler_is_a_host_stub() {
        use std::sync::Arc;
        let b = Backend::new_for_test(Arc::new(crate::events::VecEventSink::new()));
        b.init().await.unwrap();
        let args = serde_json::json!({
            "body": "1\n00:00:01,000 --> 00:00:02,000\nHi\n", "t_end_us": 2_000_000
        }).to_string();
        let err = dispatch_tool(&b, "apply_subtitles", &args).await.unwrap_err();
        assert!(
            err.message.contains("host process"),
            "apply_subtitles Rust handler must be a host stub, got: {}",
            err.message,
        );
    }
}
