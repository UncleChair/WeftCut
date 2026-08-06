//! Per-layer effect instances. Rust stores the ordered instances + animatable
//! params; the TS renderer (effectRegistry.ts) owns the catalog of which filters
//! exist and how to build them. The two join on `kind`. See docs/adr/0027 and
//! docs/render.md.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::state::animated::Animated;
use crate::state::ids::EffectId;

/// One effect in a layer's chain. `kind` is the TS-catalog join key; Rust does
/// not validate it. v1 params are scalar `Animated<f64>` only.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Effect {
    pub id: EffectId,
    pub kind: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub params: BTreeMap<String, Animated<f64>>,
}

fn default_true() -> bool {
    true
}

/// Partial update for `update_effect`. Absent fields are left unchanged.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct EffectPatch {
    pub enabled: Option<bool>,
    pub params: Option<BTreeMap<String, Animated<f64>>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effect_serde_roundtrip_static_param() {
        let mut params = std::collections::BTreeMap::new();
        params.insert("strength".to_string(), Animated::Static(8.0));
        let e = Effect {
            id: crate::state::ids::new_id(),
            kind: "blur".into(),
            enabled: true,
            params,
        };
        let json = serde_json::to_string(&e).unwrap();
        let back: Effect = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kind, "blur");
        assert!(back.enabled);
        assert!(matches!(back.params.get("strength"), Some(Animated::Static(v)) if *v == 8.0));
    }
}
