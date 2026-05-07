//! Timeline markers — point or region annotations. Agents use `metadata` for notes/todos.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::color::Rgba;
use super::ids::MarkerId;
use super::time::TimeUs;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Marker {
    pub id: MarkerId,
    pub t_us: TimeUs,
    /// Region marker when set.
    pub end_t_us: Option<TimeUs>,
    pub label: String,
    pub color: Rgba,
    #[serde(default)]
    pub metadata: imbl::HashMap<String, Value>,
}
