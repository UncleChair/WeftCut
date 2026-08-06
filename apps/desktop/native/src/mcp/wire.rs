//! Transport-agnostic MCP wire types. Serialize to the exact JSON shapes the
//! `@modelcontextprotocol/sdk` low-level Server expects, so the TS layer can
//! forward Rust output verbatim (no re-shaping).

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpErrorCode {
    InvalidParams,
    InvalidRequest,
    NotFound,
    Internal,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpToolError {
    pub code: McpErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl McpToolError {
    pub fn invalid_params(msg: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            code: McpErrorCode::InvalidParams,
            message: msg.into(),
            data,
        }
    }
    pub fn invalid_request(msg: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            code: McpErrorCode::InvalidRequest,
            message: msg.into(),
            data,
        }
    }
    pub fn internal_error(msg: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            code: McpErrorCode::Internal,
            message: msg.into(),
            data,
        }
    }
    pub fn resource_not_found(msg: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            code: McpErrorCode::NotFound,
            message: msg.into(),
            data,
        }
    }
}

impl std::fmt::Display for McpToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for McpToolError {}

/// The plain-Rust command surface behind `Backend::dispatch` speaks
/// `Result<_, String>`. A bare `?` on those inside a tool function converts the
/// String to an internal error — the only String errors a tool can hit are
/// backend-lifecycle failures, which are genuinely internal, not bad agent
/// input. Tool-specific validation still builds the precise
/// `invalid_params`/`invalid_request` variants explicitly.
impl From<String> for McpToolError {
    fn from(message: String) -> Self {
        Self::internal_error(message, None)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    #[expect(
        dead_code,
        reason = "MCP content-block protocol shape; no Rust-side tool returns images yet"
    )]
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolResult {
    pub content: Vec<ContentBlock>,
    #[serde(rename = "isError", skip_serializing_if = "is_false")]
    pub is_error: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl ToolResult {
    pub fn text(s: impl Into<String>) -> Self {
        Self {
            content: vec![ContentBlock::Text { text: s.into() }],
            is_error: false,
        }
    }
    pub fn json<T: Serialize>(v: &T) -> Result<Self, McpToolError> {
        let s = serde_json::to_string(v)
            .map_err(|e| McpToolError::internal_error(format!("serialize result: {e}"), None))?;
        Ok(Self::text(s))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum ResourceContent {
    Text {
        uri: String,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        text: String,
    },
    Blob {
        uri: String,
        #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
        blob: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceResult {
    pub contents: Vec<ResourceContent>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceDef {
    pub uri: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptArgDef {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptDef {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub arguments: Vec<PromptArgDef>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpCatalog {
    pub tools: Vec<ToolDef>,
    pub resources: Vec<ResourceDef>,
    pub prompts: Vec<PromptDef>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptRole {
    User,
    #[expect(
        dead_code,
        reason = "MCP prompt protocol shape; catalog prompts are user-role only today"
    )]
    Assistant,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptMessage {
    pub role: PromptRole,
    pub content: ContentBlock,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub messages: Vec<PromptMessage>,
}

/// The napi-method envelope: a uniform `{ok, result|error}` JSON so the napi
/// boundary is infallible (always `Ok(String)`); the TS side throws an SDK
/// error when `ok` is false.
pub fn reply<T: Serialize>(r: Result<T, McpToolError>) -> String {
    match r {
        Ok(v) => serde_json::json!({ "ok": true, "result": v }).to_string(),
        Err(e) => serde_json::json!({ "ok": false, "error": e }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_result_text_shape() {
        let v = serde_json::to_value(ToolResult::text("pong")).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "content": [{ "type": "text", "text": "pong" }] })
        );
    }

    #[test]
    fn tool_result_json_is_text_block_with_serialized_json() {
        let r = ToolResult::json(&serde_json::json!({ "a": 1 })).unwrap();
        let v = serde_json::to_value(r).unwrap();
        assert_eq!(v["content"][0]["type"], "text");
        // JSON results travel as a text block whose text is the serialized JSON.
        assert_eq!(v["content"][0]["text"], "{\"a\":1}");
    }

    #[test]
    fn blob_resource_shape() {
        let rr = ResourceResult {
            contents: vec![ResourceContent::Blob {
                uri: "media://x/thumbnail".into(),
                mime_type: Some("image/jpeg".into()),
                blob: "QUJD".into(),
            }],
        };
        let v = serde_json::to_value(rr).unwrap();
        assert_eq!(
            v["contents"][0],
            serde_json::json!({ "uri": "media://x/thumbnail", "mimeType": "image/jpeg", "blob": "QUJD" })
        );
    }

    #[test]
    fn error_reply_envelope() {
        let s = reply::<ToolResult>(Err(McpToolError::invalid_params("bad", None)));
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["ok"], false);
        assert_eq!(v["error"]["code"], "invalid_params");
        assert_eq!(v["error"]["message"], "bad");
    }

    #[test]
    fn prompt_message_shape() {
        let m = PromptMessage {
            role: PromptRole::User,
            content: ContentBlock::Text { text: "hi".into() },
        };
        let v = serde_json::to_value(m).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "role": "user", "content": { "type": "text", "text": "hi" } })
        );
    }
}
