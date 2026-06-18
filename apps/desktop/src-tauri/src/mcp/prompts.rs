//! MCP prompts surface — `cut-silences`.
//!
//! Prompts in MCP are user-invokable templates: when the user runs
//! `/cut-silences` in their MCP client, the agent receives the messages
//! produced by `expand` as the next user instruction. This one is a recipe
//! around the `detect_silences` + `split_layer` + `delete_layer` tools — the
//! value is the recipe, not new capability.
//!
//! The `auto-caption` / `voiceover` prompts referenced the deferred cloud
//! tools; they're dropped here and recoverable from git for S4b.
//!
//! Argument schemas declared in `catalog()` flow back to clients via
//! `prompts/list`; the per-call interpolation happens in `expand_*`.

use serde_json::Map;
use serde_json::Value;

use super::wire::{
    ContentBlock, McpToolError, PromptArgDef, PromptDef, PromptMessage, PromptResult, PromptRole,
};

pub const NAME_CUT_SILENCES: &str = "cut-silences";

/// Static prompt catalog. Mirrored 1:1 in `list_prompts`.
pub(crate) fn catalog() -> Vec<PromptDef> {
    vec![PromptDef {
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
    }]
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
        other => Err(McpToolError::invalid_params(
            format!("unknown prompt '{other}'; available: cut-silences"),
            None,
        )),
    }
}

fn expand_cut_silences(
    args: Option<&Map<String, Value>>,
) -> Result<PromptResult, McpToolError> {
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
        description: Some(
            "Cut silent regions out of a clip using waveform analysis.".into(),
        ),
        messages: vec![PromptMessage {
            role: PromptRole::User,
            content: ContentBlock::Text { text },
        }],
    })
}

fn require_str(
    args: Option<&Map<String, Value>>,
    key: &str,
) -> Result<String, McpToolError> {
    optional_str(args, key).ok_or_else(|| {
        McpToolError::invalid_params(
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
    fn catalog_lists_cut_silences_with_required_args_marked() {
        let cat = catalog();
        assert_eq!(cat.len(), 1);

        let cs = cat.iter().find(|p| p.name == NAME_CUT_SILENCES).unwrap();
        let layer = cs.arguments.iter().find(|a| a.name == "layer_id").unwrap();
        assert!(layer.required);
        let threshold = cs.arguments.iter().find(|a| a.name == "threshold_amp").unwrap();
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

    fn message_text(msg: &PromptMessage) -> &str {
        match &msg.content {
            ContentBlock::Text { text } => text.as_str(),
            other => panic!("expected text content, got {other:?}"),
        }
    }
}
