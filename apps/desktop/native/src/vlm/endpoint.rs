//! OpenAI-compatible `/v1/chat/completions` describer — backs BOTH the BYO
//! endpoint and the cloud VLM backends (ticket 07). They differ only in URL /
//! key / model; the request shape and the output style are identical, so one
//! impl serves both.
//!
//! Same frame-sampling input as the local sidecar, adapted to the wire by
//! [`build_request_body`]; the reply is read by `extract_content` and tagged
//! [`RawDescription::JsonArray`], so the shared parser yields the same
//! `SceneDescription` shape as the local path.
//!
//! Reuses [`speech::http`](crate::speech)'s pooled `reqwest::Client` — one TLS
//! stack, one connection pool across both cloud subsystems.

use async_trait::async_trait;
use base64::Engine;
use reqwest::StatusCode;
use serde_json::{json, Value};

use crate::speech::http::{bearer_auth, shared_client};

use super::backend::VlmBackend;
use super::describer::{DescribeRequest, Focus, SceneDescriber, TimedFrame};
use super::error::VlmError;
use super::parser::RawDescription;
use super::sidecar::build_prompt;

/// The hosted-cloud default endpoint + model (OpenAI-compatible). BYO overrides
/// both from its `Endpoint` config; cloud uses these unless the config names a
/// different model.
pub const CLOUD_URL: &str = "https://api.openai.com/v1/chat/completions";
pub const CLOUD_MODEL: &str = "gpt-4o";

/// Describer over an OpenAI-compatible chat-completions endpoint.
pub struct OpenAiCompatDescriber {
    url: String,
    api_key: Option<String>,
    model: String,
    /// Which backend this represents — for error attribution + the result
    /// envelope's `backend` tag.
    provider: VlmBackend,
}

impl OpenAiCompatDescriber {
    pub fn new(url: String, api_key: Option<String>, model: String, provider: VlmBackend) -> Self {
        Self { url, api_key, model, provider }
    }
}

#[async_trait]
impl SceneDescriber for OpenAiCompatDescriber {
    async fn describe(&self, req: DescribeRequest) -> Result<RawDescription, VlmError> {
        // Read + base64 each frame BEFORE building the body (async fs, sequential
        // — a handful of small PNGs).
        let mut encoded = Vec::with_capacity(req.frames.len());
        for f in &req.frames {
            let bytes = tokio::fs::read(&f.path).await.map_err(VlmError::Io)?;
            encoded.push((f.t_us, base64::engine::general_purpose::STANDARD.encode(&bytes)));
        }
        let body = build_request_body(&self.model, &encoded, req.focus);

        let mut rb = shared_client().post(&self.url).json(&body);
        if let Some(key) = &self.api_key {
            rb = rb.header("Authorization", bearer_auth(key));
        }
        let resp = rb.send().await.map_err(VlmError::Network)?;
        let status = resp.status();
        if !status.is_success() {
            return Err(self.map_status(status, resp.text().await.unwrap_or_default()));
        }
        let payload: Value = resp.json().await.map_err(VlmError::Network)?;
        let content = extract_content(&payload).ok_or_else(|| VlmError::Provider {
            provider: self.provider,
            message: "response had no choices[0].message.content".into(),
        })?;
        Ok(RawDescription::JsonArray(content))
    }
}

impl OpenAiCompatDescriber {
    fn map_status(&self, status: StatusCode, body: String) -> VlmError {
        match status {
            StatusCode::UNAUTHORIZED => VlmError::InvalidKey { provider: self.provider },
            StatusCode::TOO_MANY_REQUESTS => VlmError::RateLimited {
                provider: self.provider,
                retry_after_s: None,
            },
            _ => VlmError::Provider {
                provider: self.provider,
                message: format!("HTTP {status}: {}", body.trim()),
            },
        }
    }
}

/// Build the chat-completions request body: one user message whose `content` is
/// the interleaved [text, image, text, image, …, instruction] parts. The text
/// parts carry the injected `Frame at <t>s:` markers + the JSON instruction
/// (reusing [`build_prompt`]'s exact wording so cloud/BYO stay faithful to the
/// local path). Pure so it is unit-testable without a network.
pub fn build_request_body(model: &str, frames: &[(i64, String)], focus: Focus) -> Value {
    // Reuse the local prompt to derive the leading instruction wording; the
    // per-frame markers are emitted as structured parts instead of `<__media__>`.
    let timed: Vec<TimedFrame> = frames
        .iter()
        .map(|(t, _)| TimedFrame { t_us: *t, path: Default::default() })
        .collect();
    let instruction = trailing_instruction(&build_prompt(&timed, focus));

    let mut content: Vec<Value> = vec![json!({
        "type": "text",
        "text": "You are analyzing frames sampled from a single video clip. Each image is labeled with its timestamp in seconds."
    })];
    for (t_us, b64) in frames {
        content.push(json!({ "type": "text", "text": format!("Frame at {:.2}s:", *t_us as f64 / 1_000_000.0) }));
        content.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:image/png;base64,{b64}") }
        }));
    }
    content.push(json!({ "type": "text", "text": instruction }));

    json!({
        "model": model,
        "temperature": 0.1,
        "max_tokens": 768,
        "messages": [{ "role": "user", "content": content }],
    })
}

/// The JSON-array instruction tail of the local prompt (everything from the
/// "Return ONLY a JSON array" line onward) — reused verbatim so every backend
/// asks for the same output shape.
fn trailing_instruction(prompt: &str) -> String {
    match prompt.find("Return ONLY a JSON array") {
        Some(i) => prompt[i..].to_string(),
        None => prompt.to_string(),
    }
}

/// Pull `choices[0].message.content` out of a chat-completions response.
fn extract_content(payload: &Value) -> Option<String> {
    payload
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_body_interleaves_frames_and_carries_the_instruction() {
        let frames = vec![(0i64, "AAAA".to_string()), (2_500_000i64, "BBBB".to_string())];
        let body = build_request_body("gpt-4o", &frames, Focus::General);
        let content = body["messages"][0]["content"].as_array().unwrap();
        // lead text + (text + image) * 2 + instruction = 6 parts.
        assert_eq!(content.len(), 6);
        assert_eq!(content[1]["text"], "Frame at 0.00s:");
        assert!(content[2]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,AAAA"));
        assert_eq!(content[3]["text"], "Frame at 2.50s:");
        assert!(content.last().unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("Return ONLY a JSON array"));
        assert_eq!(body["model"], "gpt-4o");
    }

    #[test]
    fn extract_content_reads_first_choice() {
        let payload = json!({
            "choices": [{ "message": { "content": "[{\"t_start\":0}]" } }]
        });
        assert_eq!(extract_content(&payload).as_deref(), Some("[{\"t_start\":0}]"));
        assert_eq!(extract_content(&json!({ "choices": [] })), None);
    }
}
