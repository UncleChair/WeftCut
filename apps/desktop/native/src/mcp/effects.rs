//! Argument structs for the four effect-chain MCP tools.
//! The tool functions live in `tools.rs`; this module is kept small so the
//! arg schema types stay adjacent to the tool-table registration in
//! `catalog.rs`.

use schemars::JsonSchema;
use serde::Deserialize;

/// Args for `add_effect`.
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct AddEffectArgs {
    /// UUID of the layer to attach the effect to.
    pub layer_id: String,
    /// Catalog key for the effect (v1: `"blur"`). Rust does not validate the key;
    /// the renderer rejects unknown kinds at render time.
    pub kind: String,
}

/// Args for `update_effect`.
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct UpdateEffectArgs {
    /// UUID of the layer that owns the effect.
    pub layer_id: String,
    /// UUID of the effect to update.
    pub effect_id: String,
    /// Partial update: `{ enabled?, params? }`. `params` is a map of param key
    /// to `Animated<f64>`: `{ "mode": "Static", "value": <number> }` (v1).
    pub patch: serde_json::Value,
}

/// Args for `move_effect`.
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct MoveEffectArgs {
    /// UUID of the layer that owns the effect.
    pub layer_id: String,
    /// UUID of the effect to reorder.
    pub effect_id: String,
    /// 0-based destination index (0 = applied first). Must be < effect count.
    pub new_index: usize,
}

/// Args for `remove_effect`.
#[derive(Debug, Deserialize, JsonSchema)]
pub(super) struct RemoveEffectArgs {
    /// UUID of the layer that owns the effect.
    pub layer_id: String,
    /// UUID of the effect to delete.
    pub effect_id: String,
}
