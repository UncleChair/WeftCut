//! MCP prompts surface — `/auto-caption` and `/voiceover` (Phase 6 Stage 7).
//!
//! Prompts in MCP are user-invokable templates: when the user runs
//! `/auto-caption` in Claude Desktop, the agent receives the messages
//! produced by `get_prompt` as the next user instruction. These two are
//! thin wrappers around tools that already exist (`transcribe_clip` +
//! `apply_subtitles` for captions; `synthesize_speech` for voiceover) —
//! the value is the recipe, not new capability.
//!
//! Argument schemas declared here flow back to clients via
//! `prompts/list`; the per-call interpolation happens in `expand_*`.

use rmcp::Error as McpError;
use rmcp::model::{
    GetPromptResult, Prompt, PromptArgument, PromptMessage, PromptMessageRole,
};
use serde_json::Map;
use serde_json::Value;

pub const NAME_AUTO_CAPTION: &str = "auto-caption";
pub const NAME_VOICEOVER: &str = "voiceover";

/// Static prompt catalog. Mirrored 1:1 in `list_prompts`.
pub fn catalog() -> Vec<Prompt> {
    vec![
        Prompt::new(
            NAME_AUTO_CAPTION,
            Some(
                "Transcribe a video or audio layer with cloud Whisper, then apply the SRT as subtitles."
            ),
            Some(vec![
                PromptArgument {
                    name: "layer_id".into(),
                    description: Some(
                        "Target VideoClip or Audio layer id.".into(),
                    ),
                    required: Some(true),
                },
                PromptArgument {
                    name: "language".into(),
                    description: Some(
                        "Optional ISO-639-1 language hint (en, zh, etc.). Auto-detect when omitted.".into(),
                    ),
                    required: Some(false),
                },
            ]),
        ),
        Prompt::new(
            NAME_VOICEOVER,
            Some(
                "Generate cloud TTS for a script and attach it as an Audio layer.",
            ),
            Some(vec![
                PromptArgument {
                    name: "script".into(),
                    description: Some(
                        "Text to speak. tts-1 caps a single call at 4096 chars; for longer scripts split into paragraphs.".into(),
                    ),
                    required: Some(true),
                },
                PromptArgument {
                    name: "voice".into(),
                    description: Some(
                        "OpenAI voice: alloy, echo, fable, onyx, nova, or shimmer.".into(),
                    ),
                    required: Some(true),
                },
                PromptArgument {
                    name: "speed".into(),
                    description: Some(
                        "Optional speech speed in [0.25, 4.0]. Omit for the provider default.".into(),
                    ),
                    required: Some(false),
                },
                PromptArgument {
                    name: "target_track_id".into(),
                    description: Some(
                        "Optional Audio track id. Defaults to the first existing Audio track or a new 'Voiceover' track.".into(),
                    ),
                    required: Some(false),
                },
            ]),
        ),
    ]
}

/// Resolve a prompt name + arguments to a `GetPromptResult` ready for the
/// client. Unknown names bubble up as `method_not_found` so well-behaved
/// clients can show "prompt not available" gracefully.
pub fn expand(
    name: &str,
    args: Option<&Map<String, Value>>,
) -> Result<GetPromptResult, McpError> {
    match name {
        NAME_AUTO_CAPTION => expand_auto_caption(args),
        NAME_VOICEOVER => expand_voiceover(args),
        other => Err(McpError::invalid_params(
            format!("unknown prompt '{other}'; available: auto-caption, voiceover"),
            None,
        )),
    }
}

fn expand_auto_caption(
    args: Option<&Map<String, Value>>,
) -> Result<GetPromptResult, McpError> {
    let layer_id = require_str(args, "layer_id")?;
    let language = optional_str(args, "language");
    let language_clause = match language {
        Some(lang) => format!(", `language: \"{lang}\"`"),
        None => String::new(),
    };
    let text = format!(
"Auto-caption the clip on layer `{layer_id}` using cloud transcription.

Steps:
1. Call `transcribe_clip` with `layer_id: \"{layer_id}\"`{language_clause}. The tool extracts the layer's audio (mono 16 kHz WAV), uploads it to Whisper, and returns SRT with cue timestamps already shifted to timeline-absolute microseconds.
2. Inspect the returned SRT. Fix obvious mistakes you can spot — proper nouns, technical terms, on-screen text that should match exactly. Don't rewrite the prose.
3. Call `apply_subtitles` with the (possibly edited) body. **Omit `t_start_us`** so the Subtitles layer activates from timeline 0; the cues self-position via their internal timestamps. Set `t_end_us` to the composition's `duration_us` (read from `project://composition`) so the layer covers the whole timeline.

If `transcribe_clip` errors with `MissingKey` or `InvalidKey`, tell the user to configure their OpenAI API key under Settings → API keys. If `PayloadTooLarge`, narrow the window with `t_start_us`/`t_end_us` and call again — Whisper's per-request cap is ~13 minutes of mono 16 kHz audio."
    );
    Ok(GetPromptResult {
        description: Some(
            "Auto-caption a clip via cloud Whisper + apply_subtitles.".into(),
        ),
        messages: vec![PromptMessage::new_text(PromptMessageRole::User, text)],
    })
}

fn expand_voiceover(
    args: Option<&Map<String, Value>>,
) -> Result<GetPromptResult, McpError> {
    let script = require_str(args, "script")?;
    let voice = require_str(args, "voice")?;
    let speed = optional_str(args, "speed");
    let target_track = optional_str(args, "target_track_id");

    let mut extra = String::new();
    if let Some(s) = &speed {
        extra.push_str(&format!(", `speed: {s}`"));
    }
    if let Some(t) = &target_track {
        extra.push_str(&format!(", `target_track_id: \"{t}\"`"));
    }

    let text = format!(
"Generate voiceover audio for the script below using the `{voice}` voice.

Script:
\"\"\"
{script}
\"\"\"

Steps:
1. Call `synthesize_speech` with `text: <the script>`, `voice: \"{voice}\"`{extra}. The tool content-addresses by `(model, voice, speed, text)`, so an identical earlier call returns the cached audio without re-billing.
2. Report the resulting `layer_id`, `media_id`, `t_start_us`, `t_end_us`, and whether the result was `cached`.

If the script exceeds 4096 characters, split it at paragraph boundaries and synthesize each chunk separately. Each call's `t_start_us` defaults to the current `composition.duration_us`, so successive chunks chain at the end of the timeline.

If `synthesize_speech` errors with `MissingKey` or `InvalidKey`, tell the user to configure their OpenAI API key under Settings → API keys."
    );
    Ok(GetPromptResult {
        description: Some(
            "Generate cloud TTS and attach it as an Audio layer.".into(),
        ),
        messages: vec![PromptMessage::new_text(PromptMessageRole::User, text)],
    })
}

fn require_str(
    args: Option<&Map<String, Value>>,
    key: &str,
) -> Result<String, McpError> {
    optional_str(args, key).ok_or_else(|| {
        McpError::invalid_params(
            format!("required prompt argument '{key}' missing"),
            None,
        )
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
    fn catalog_lists_both_prompts_with_required_args_marked() {
        let cat = catalog();
        assert_eq!(cat.len(), 2);

        let auto = cat.iter().find(|p| p.name == NAME_AUTO_CAPTION).unwrap();
        let auto_args = auto.arguments.as_ref().expect("auto-caption has args");
        let layer = auto_args.iter().find(|a| a.name == "layer_id").unwrap();
        assert_eq!(layer.required, Some(true));
        let lang = auto_args.iter().find(|a| a.name == "language").unwrap();
        assert_eq!(lang.required, Some(false));

        let vo = cat.iter().find(|p| p.name == NAME_VOICEOVER).unwrap();
        let vo_args = vo.arguments.as_ref().expect("voiceover has args");
        assert_eq!(
            vo_args.iter().find(|a| a.name == "script").unwrap().required,
            Some(true),
        );
        assert_eq!(
            vo_args.iter().find(|a| a.name == "voice").unwrap().required,
            Some(true),
        );
    }

    #[test]
    fn expand_unknown_prompt_errors() {
        let err = expand("nope", None).expect_err("unknown name");
        assert!(format!("{err}").contains("unknown prompt 'nope'"));
    }

    #[test]
    fn auto_caption_requires_layer_id() {
        let err = expand(NAME_AUTO_CAPTION, None).expect_err("missing layer_id");
        assert!(format!("{err}").contains("layer_id"));
    }

    #[test]
    fn auto_caption_interpolates_layer_id_into_message() {
        let a = args(&[("layer_id", json!("abc-123"))]);
        let result = expand(NAME_AUTO_CAPTION, Some(&a)).expect("expand");
        assert_eq!(result.messages.len(), 1);
        let body = message_text(&result.messages[0]);
        assert!(body.contains("`abc-123`"));
        // Without language arg, the body should NOT mention `language`.
        assert!(!body.contains("language:"), "unexpected language clause: {body}");
        // Must mention both tools so the agent knows the pipeline.
        assert!(body.contains("transcribe_clip"));
        assert!(body.contains("apply_subtitles"));
    }

    #[test]
    fn auto_caption_passes_language_through_when_provided() {
        let a = args(&[
            ("layer_id", json!("abc-123")),
            ("language", json!("zh")),
        ]);
        let result = expand(NAME_AUTO_CAPTION, Some(&a)).expect("expand");
        let body = message_text(&result.messages[0]);
        assert!(body.contains("`language: \"zh\"`"), "missing language clause: {body}");
    }

    #[test]
    fn voiceover_requires_script_and_voice() {
        let only_voice = args(&[("voice", json!("alloy"))]);
        assert!(expand(NAME_VOICEOVER, Some(&only_voice)).is_err());

        let only_script = args(&[("script", json!("hello world"))]);
        assert!(expand(NAME_VOICEOVER, Some(&only_script)).is_err());
    }

    #[test]
    fn voiceover_interpolates_script_and_voice() {
        let a = args(&[
            ("script", json!("Once upon a time")),
            ("voice", json!("nova")),
        ]);
        let result = expand(NAME_VOICEOVER, Some(&a)).expect("expand");
        let body = message_text(&result.messages[0]);
        assert!(body.contains("`nova`"));
        assert!(body.contains("Once upon a time"));
        assert!(body.contains("synthesize_speech"));
    }

    #[test]
    fn voiceover_propagates_optional_speed_and_track() {
        let a = args(&[
            ("script", json!("hi")),
            ("voice", json!("alloy")),
            ("speed", json!("1.25")),
            ("target_track_id", json!("track-xyz")),
        ]);
        let result = expand(NAME_VOICEOVER, Some(&a)).expect("expand");
        let body = message_text(&result.messages[0]);
        assert!(body.contains("`speed: 1.25`"), "missing speed: {body}");
        assert!(
            body.contains("`target_track_id: \"track-xyz\"`"),
            "missing target_track_id: {body}",
        );
    }

    fn message_text(msg: &PromptMessage) -> &str {
        match &msg.content {
            rmcp::model::PromptMessageContent::Text { text } => text.as_str(),
            other => panic!("expected text content, got {other:?}"),
        }
    }
}
