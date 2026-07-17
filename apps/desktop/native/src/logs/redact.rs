//! Sensitive-data redactor. Runs on `LogEntry.details` (only) before
//! broadcast and persistence. See `docs/status-log.md` —
//! we apply a small allowlist of patterns matching the realistic leak
//! surface: cloud-SDK error reprs that embed bearer tokens and api-key
//! query parameters.
//!
//! Limits:
//!   * Only `details` is scrubbed. The producer is responsible for
//!     keeping `message` itself free of secrets.
//!   * Patterns are conservative — we'd rather miss an exotic leak than
//!     redact a legitimate api-key-shaped value in production code.
//!   * After redaction, `details` is also size-capped to ~4 KB; the
//!     truncation tag `{"truncated": true}` is appended so a reader can
//!     tell the payload was cut.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

/// Max byte size of the serialized `details` field after redaction.
const MAX_DETAILS_BYTES: usize = 4 * 1024;

fn redactors() -> &'static [(Regex, &'static str)] {
    static CELL: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    CELL.get_or_init(|| {
        vec![
            // `Authorization: Bearer <token>` — case-insensitive header value.
            (
                Regex::new(r"(?i)(authorization:\s*bearer\s+)[A-Za-z0-9._\-]+").unwrap(),
                "$1<redacted>",
            ),
            // `api[_-]?key = <value>` or `api[_-]?key: <value>` — both
            // form-encoded query string and YAML/JSON-like key:value.
            (
                Regex::new(r#"(?i)(api[_-]?key\s*[=:]\s*)["']?[A-Za-z0-9._\-]+["']?"#).unwrap(),
                "$1<redacted>",
            ),
            // `x-api-key: <token>` header style.
            (
                Regex::new(r"(?i)(x-api-key:\s*)[A-Za-z0-9._\-]+").unwrap(),
                "$1<redacted>",
            ),
        ]
    })
}

/// Case-insensitive match for keys that should have their string values
/// redacted regardless of value content. Catches the case where a cloud
/// SDK serializes a structured request as `{ "authorization": "...",
/// "x-api-key": "..." }` — patterns above only match key:value strings.
fn is_sensitive_key(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "authorization"
        || lower == "x-api-key"
        || lower == "api_key"
        || lower == "api-key"
        || lower == "apikey"
}

/// Redact known secret patterns from a `details` payload in place.
/// Walks the JSON tree; replaces matching string content. Numbers,
/// bools, nulls are untouched.
pub fn redact_in_place(value: &mut Value) {
    match value {
        Value::String(s) => {
            for (re, repl) in redactors().iter() {
                if re.is_match(s) {
                    *s = re.replace_all(s, *repl).into_owned();
                }
            }
        }
        Value::Array(arr) => {
            for v in arr {
                redact_in_place(v);
            }
        }
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if is_sensitive_key(k) {
                    if let Value::String(_) = v {
                        *v = Value::String("<redacted>".into());
                        continue;
                    }
                }
                redact_in_place(v);
            }
        }
        _ => {}
    }
}

/// Redact + size-cap. On entries whose serialized form exceeds
/// `MAX_DETAILS_BYTES`, replace the payload with a small object that
/// keeps a prefix slice and marks the truncation.
pub fn redact_and_cap(value: Value) -> Value {
    let mut v = value;
    redact_in_place(&mut v);
    let serialized = serde_json::to_string(&v).unwrap_or_default();
    if serialized.len() <= MAX_DETAILS_BYTES {
        return v;
    }
    let preview: String = serialized.chars().take(2048).collect();
    serde_json::json!({
        "truncated": true,
        "original_bytes": serialized.len(),
        "preview": preview,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_bearer_token() {
        let mut v = json!({
            "err": "401 Unauthorized; Authorization: Bearer sk-abc123_DEF",
        });
        redact_in_place(&mut v);
        let s = serde_json::to_string(&v).unwrap();
        assert!(s.contains("<redacted>"));
        assert!(!s.contains("sk-abc123_DEF"));
    }

    #[test]
    fn strips_api_key_pairs() {
        let mut v = json!({
            "url": "https://api.example.com/v1?api_key=secret-VALUE&q=hi",
            "headers": { "x-api-key": "another-secret" },
        });
        redact_in_place(&mut v);
        let s = serde_json::to_string(&v).unwrap();
        assert!(!s.contains("secret-VALUE"), "got {s}");
        assert!(!s.contains("another-secret"), "got {s}");
    }

    #[test]
    fn leaves_unrelated_strings_alone() {
        let mut v = json!({ "message": "Added 3 layers to track v1" });
        let before = v.clone();
        redact_in_place(&mut v);
        assert_eq!(v, before);
    }

    #[test]
    fn caps_oversized_payloads() {
        let big = "x".repeat(MAX_DETAILS_BYTES * 2);
        let v = json!({ "blob": big });
        let capped = redact_and_cap(v);
        assert_eq!(capped["truncated"], json!(true));
        assert!(capped["original_bytes"].as_u64().unwrap() > MAX_DETAILS_BYTES as u64);
    }
}
