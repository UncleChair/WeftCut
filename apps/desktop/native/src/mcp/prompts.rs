//! MCP prompts surface — `cut-silences`, `auto-caption`, `voiceover`.
//!
//! Prompts in MCP are user-invokable templates: when the user runs
//! `/cut-silences` in their MCP client, the agent receives the messages
//! produced by `expand` as the next user instruction. This one is a recipe
//! around the `detect_silences` + `split_layer` + `delete_layer` tools — the
//! value is the recipe, not new capability.
//!
//! The `auto-caption` / `voiceover` prompts reference cloud tools and are
//! enabled under `#[cfg(feature = "speech")]`.
//!
//! Argument schemas declared in `catalog()` flow back to clients via
//! `prompts/list`; the per-call interpolation happens in `expand_*`.

use serde_json::Map;
use serde_json::Value;

use super::wire::{
    ContentBlock, McpToolError, PromptArgDef, PromptDef, PromptMessage, PromptResult, PromptRole,
};

pub const NAME_CUT_SILENCES: &str = "cut-silences";
#[cfg(feature = "speech")]
pub const NAME_AUTO_CAPTION: &str = "auto-caption";
#[cfg(feature = "speech")]
pub const NAME_VOICEOVER: &str = "voiceover";

/// Static prompt catalog. Mirrored 1:1 in `list_prompts`.
pub(crate) fn catalog() -> Vec<PromptDef> {
    let mut prompts = vec![PromptDef {
        name: NAME_CUT_SILENCES.into(),
        description: Some(
            "Find silent regions in a clip and tighten it up by splitting + deleting the dead air."
                .into(),
        ),
        arguments: vec![
            PromptArgDef {
                name: "layer_id".into(),
                description: Some("Target VideoClip or Audio layer id.".into()),
                required: true,
            },
            PromptArgDef {
                name: "threshold_amp".into(),
                description: Some(
                    "Peak amplitude threshold in [0.0, 1.0]. Default 0.02 (≈ -34 dBFS).".into(),
                ),
                required: false,
            },
            PromptArgDef {
                name: "min_silence_us".into(),
                description: Some(
                    "Minimum silence duration to cut, in microseconds. Default 500000 (0.5s)."
                        .into(),
                ),
                required: false,
            },
        ],
    }];
    #[cfg(feature = "speech")]
    {
        prompts.push(PromptDef {
            name: NAME_AUTO_CAPTION.into(),
            description: Some(
                "Transcribe a video or audio layer with cloud Whisper, then apply the SRT as subtitles."
                    .into(),
            ),
            arguments: vec![
                PromptArgDef {
                    name: "layer_id".into(),
                    description: Some("Target VideoClip or Audio layer id.".into()),
                    required: true,
                },
                PromptArgDef {
                    name: "language".into(),
                    description: Some(
                        "Optional ISO-639-1 language hint (en, zh, etc.). Auto-detect when omitted."
                            .into(),
                    ),
                    required: false,
                },
            ],
        });
        prompts.push(PromptDef {
            name: NAME_VOICEOVER.into(),
            description: Some(
                "Generate cloud TTS for a script and attach it as an Audio layer.".into(),
            ),
            arguments: vec![
                PromptArgDef {
                    name: "script".into(),
                    description: Some(
                        "Text to speak. tts-1 caps a single call at 4096 chars; for longer scripts split into paragraphs."
                            .into(),
                    ),
                    required: true,
                },
                PromptArgDef {
                    name: "voice".into(),
                    description: Some(
                        "OpenAI voice: alloy, echo, fable, onyx, nova, or shimmer.".into(),
                    ),
                    required: false,
                },
                PromptArgDef {
                    name: "speed".into(),
                    description: Some(
                        "Optional speech speed in [0.25, 4.0]. Omit for the provider default."
                            .into(),
                    ),
                    required: false,
                },
                PromptArgDef {
                    name: "target_track_id".into(),
                    description: Some(
                        "Optional Audio track id. Defaults to the first existing Audio track or a new 'Voiceover' track."
                            .into(),
                    ),
                    required: false,
                },
            ],
        });
    }
    prompts
}

/// Resolve a prompt name + arguments to a `PromptResult` ready for the client.
/// Unknown names bubble up as `invalid_params` so well-behaved clients can show
/// "prompt not available" gracefully.
pub(crate) fn expand(
    name: &str,
    args: Option<&Map<String, Value>>,
) -> Result<PromptResult, McpToolError> {
    match name {
        NAME_CUT_SILENCES => expand_cut_silences(args),
        #[cfg(feature = "speech")]
        NAME_AUTO_CAPTION => expand_auto_caption(args),
        #[cfg(feature = "speech")]
        NAME_VOICEOVER => expand_voiceover(args),
        other => Err(McpToolError::invalid_params(
            format!(
                "unknown prompt '{other}'; available: cut-silences{}",
                if cfg!(feature = "speech") {
                    ", auto-caption, voiceover"
                } else {
                    ""
                }
            ),
            None,
        )),
    }
}

fn expand_cut_silences(args: Option<&Map<String, Value>>) -> Result<PromptResult, McpToolError> {
    let layer_id = require_str(args, "layer_id")?;
    let threshold = optional_str(args, "threshold_amp");
    let min_silence = optional_str(args, "min_silence_us");

    let mut extra = String::new();
    if let Some(t) = &threshold {
        extra.push_str(&format!(", `threshold_amp: {t}`"));
    }
    if let Some(m) = &min_silence {
        extra.push_str(&format!(", `min_silence_us: {m}`"));
    }

    let text = format!(
"Trim silent gaps out of layer `{layer_id}`.

Steps:
1. Call `detect_silences` with `layer_id: \"{layer_id}\"`{extra}. It walks the pre-computed waveform peaks and returns timeline-absolute `[{{ t_start_us, t_end_us }}, ...]` ranges where the audio is below threshold for the requested duration. If the tool errors with a `waveform not generated yet` message, wait for the corresponding `media:job_complete` event (kind=waveform) and retry — imports run in the background.
2. Apply the cuts back-to-front (process the LAST region first, then work upward). Working back-to-front means earlier indices stay valid as you mutate; doing it forward means every cut after the first needs index re-resolution. For each region:
   a. Call `split_layer` with `at_t_us: <region.t_start_us>` → split point 1.
   b. Call `split_layer` on the right half with `at_t_us: <region.t_end_us>` → split point 2; the middle slice now isolates the silent region.
   c. Call `delete_layer` on the middle slice.
3. After all cuts land, report how many regions were removed and the total duration saved.

Defaults if the agent leaves args off: threshold_amp ≈ 0.02 (-34 dBFS), min_silence_us 500ms — tuned for podcast-style speech with quick breath-pause cuts. Loosen for music (lower threshold, longer min) or tighten for talking-head (higher threshold)."
    );
    Ok(PromptResult {
        description: Some("Cut silent regions out of a clip using waveform analysis.".into()),
        messages: vec![PromptMessage {
            role: PromptRole::User,
            content: ContentBlock::Text { text },
        }],
    })
}

#[cfg(feature = "speech")]
fn expand_auto_caption(args: Option<&Map<String, Value>>) -> Result<PromptResult, McpToolError> {
    let layer_id = require_str(args, "layer_id")?;
    let language = optional_str(args, "language");
    let language_clause = match language {
        Some(lang) => format!(", `language: \"{lang}\"`"),
        None => String::new(),
    };
    let text = format!(
"Auto-caption the clip on layer `{layer_id}` using the configured transcription engine.

Steps:
1. Call `transcribe_clip` with `layer_id: \"{layer_id}\"`{language_clause}. The tool extracts the layer's audio (mono 16 kHz WAV), transcribes it with the configured engine (cloud OpenAI Whisper, or local whisper.cpp / FunASR), and returns a JSON envelope `{{ backend, segments, language, word_timing, srt }}` with all timestamps already shifted to timeline-absolute microseconds. The `srt` field is a ready-to-apply SubRip body; `segments`/`words` carry the same content with per-word spans.
2. Inspect the `srt` field. Fix obvious mistakes you can spot — proper nouns, technical terms, on-screen text that should match exactly. Don't rewrite the prose.
3. Call `apply_subtitles` with the (possibly edited) `srt` body — NOT the whole JSON envelope. The cues self-position into a new caption track of editable Text layers via their internal timestamps — you do not pass start/end times (any `t_start_us`/`t_end_us` are ignored). The tool returns the new caption track id.

If `transcribe_clip` errors because no backend is configured (or with `MissingKey` / `InvalidKey`), tell the user to add an OpenAI API key or configure a local engine under Settings → Transcription. If `PayloadTooLarge`, narrow the window with `t_start_us`/`t_end_us` and call again — the cloud Whisper per-request cap is ~13 minutes of mono 16 kHz audio (local engines have no upload cap)."
    );
    Ok(PromptResult {
        description: Some("Auto-caption a clip via cloud Whisper + apply_subtitles.".into()),
        messages: vec![PromptMessage {
            role: PromptRole::User,
            content: ContentBlock::Text { text },
        }],
    })
}

#[cfg(feature = "speech")]
fn expand_voiceover(args: Option<&Map<String, Value>>) -> Result<PromptResult, McpToolError> {
    let script = require_str(args, "script")?;
    let voice = optional_str(args, "voice");
    let speed = optional_str(args, "speed");
    let target_track = optional_str(args, "target_track_id");

    let voice_clause = match &voice {
        Some(v) => format!("`{v}`"),
        None => "the default voice".to_string(),
    };

    let mut extra = String::new();
    if let Some(v) = &voice {
        extra.push_str(&format!(", `voice: \"{v}\"`"));
    }
    if let Some(s) = &speed {
        extra.push_str(&format!(", `speed: {s}`"));
    }
    if let Some(t) = &target_track {
        extra.push_str(&format!(", `target_track_id: \"{t}\"`"));
    }

    let text = format!(
"Generate voiceover audio for the script below using the {voice_clause} voice.

Script:
\"\"\"
{script}
\"\"\"

Steps:
1. Call `synthesize_speech` with `text: <the script>`{extra}. The tool content-addresses by `(model, voice, speed, text)`, so an identical earlier call returns the cached audio without re-billing.
2. Report the resulting `layer_id`, `media_id`, `t_start_us`, `t_end_us`, and whether the result was `cached`.

If the script exceeds 4096 characters, split it at paragraph boundaries and synthesize each chunk separately. Each call's `t_start_us` defaults to the current `composition.duration_us`, so successive chunks chain at the end of the timeline.

If `synthesize_speech` errors with `MissingKey` or `InvalidKey`, tell the user to configure their OpenAI API key under Settings → Transcription."
    );
    Ok(PromptResult {
        description: Some("Generate cloud TTS and attach it as an Audio layer.".into()),
        messages: vec![PromptMessage {
            role: PromptRole::User,
            content: ContentBlock::Text { text },
        }],
    })
}

fn require_str(args: Option<&Map<String, Value>>, key: &str) -> Result<String, McpToolError> {
    optional_str(args, key).ok_or_else(|| {
        McpToolError::invalid_params(format!("required prompt argument '{key}' missing"), None)
    })
}

fn optional_str(args: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    args.and_then(|m| m.get(key))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(pairs: &[(&str, Value)]) -> Map<String, Value> {
        let mut m = Map::new();
        for (k, v) in pairs {
            m.insert((*k).into(), v.clone());
        }
        m
    }

    #[test]
    fn catalog_lists_cut_silences_with_required_args_marked() {
        let cat = catalog();
        #[cfg(not(feature = "speech"))]
        assert_eq!(cat.len(), 1);
        #[cfg(feature = "speech")]
        assert_eq!(cat.len(), 3);

        let cs = cat.iter().find(|p| p.name == NAME_CUT_SILENCES).unwrap();
        let layer = cs.arguments.iter().find(|a| a.name == "layer_id").unwrap();
        assert!(layer.required);
        let threshold = cs
            .arguments
            .iter()
            .find(|a| a.name == "threshold_amp")
            .unwrap();
        assert!(!threshold.required);
    }

    #[test]
    fn cut_silences_interpolates_layer_id_and_mentions_detect_silences() {
        let a = args(&[("layer_id", json!("xyz-789"))]);
        let result = expand(NAME_CUT_SILENCES, Some(&a)).expect("expand");
        let body = message_text(&result.messages[0]);
        assert!(body.contains("`xyz-789`"));
        assert!(body.contains("detect_silences"));
        // Must explicitly tell the agent to process back-to-front so cut
        // indices stay valid; otherwise the agent will sequence forward and
        // hit out-of-range layer ids halfway through.
        assert!(body.contains("back-to-front"));
    }

    #[test]
    fn cut_silences_passes_through_optional_thresholds() {
        let a = args(&[
            ("layer_id", json!("xyz")),
            ("threshold_amp", json!("0.05")),
            ("min_silence_us", json!("1000000")),
        ]);
        let result = expand(NAME_CUT_SILENCES, Some(&a)).expect("expand");
        let body = message_text(&result.messages[0]);
        assert!(body.contains("`threshold_amp: 0.05`"));
        assert!(body.contains("`min_silence_us: 1000000`"));
    }

    #[test]
    fn expand_unknown_prompt_errors() {
        let err = expand("nope", None).expect_err("unknown name");
        assert!(format!("{err}").contains("unknown prompt 'nope'"));
    }

    #[test]
    fn cut_silences_requires_layer_id() {
        let err = expand(NAME_CUT_SILENCES, None).expect_err("missing layer_id");
        assert!(format!("{err}").contains("layer_id"));
    }

    #[cfg(feature = "speech")]
    #[test]
    fn catalog_includes_cloud_prompts() {
        let names: Vec<_> = catalog().into_iter().map(|p| p.name).collect();
        assert!(names.iter().any(|n| n == "auto-caption"));
        assert!(names.iter().any(|n| n == "voiceover"));
    }

    #[cfg(feature = "speech")]
    #[test]
    fn voiceover_expands_with_script() {
        let a = args(&[("script", json!("hello there"))]);
        let r = expand("voiceover", Some(&a)).expect("expand voiceover");
        let body = message_text(&r.messages[0]);
        assert!(body.contains("hello there"));
    }

    fn message_text(msg: &PromptMessage) -> &str {
        match &msg.content {
            ContentBlock::Text { text } => text.as_str(),
            other => panic!("expected text content, got {other:?}"),
        }
    }
}
