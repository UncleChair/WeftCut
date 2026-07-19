//! Audio roles — the mixing model's "what kind of sound is this" axis
//! (`docs/audio.md`). Each audio layer carries an `AudioRole`; the
//! project holds one `RoleMixSettings` per role (a mix bus). Mixing
//! groups by role, not by track. v1 has no per-role effects, so a role
//! bus is realized by folding role gain into each layer's gain envelope
//! and filtering the audible set by role mute/solo.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Fixed v1 role set. Custom / sub-roles are deferred. Kebab-case on the
/// wire (matches `TrackRole`'s convention and the TS `AudioRole` union).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Default, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AudioRole {
    #[default]
    Dialogue,
    Music,
    Sfx,
    Voiceover,
}

impl AudioRole {
    /// Canonical display / iteration order. The mixer UI and the IPC view
    /// emit roles in this order regardless of map iteration order.
    pub const ALL: [AudioRole; 4] = [
        AudioRole::Dialogue,
        AudioRole::Music,
        AudioRole::Sfx,
        AudioRole::Voiceover,
    ];

    /// Kebab string used in IPC views (must match the serde wire form).
    pub fn as_str(self) -> &'static str {
        match self {
            AudioRole::Dialogue => "dialogue",
            AudioRole::Music => "music",
            AudioRole::Sfx => "sfx",
            AudioRole::Voiceover => "voiceover",
        }
    }
}

/// Per-role mix-bus settings. `gain_db` is a recorded edit; `muted`/`solo`
/// are unrecorded preferences (see `RoleFlagsPatch`). Effects insert here
/// in a later plan (`effects: Vec<AudioEffect>`); v1 adds no DSP.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RoleMixSettings {
    #[serde(default)]
    pub gain_db: f64,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub solo: bool,
}

impl Default for RoleMixSettings {
    fn default() -> Self {
        Self {
            gain_db: 0.0,
            muted: false,
            solo: false,
        }
    }
}

/// Patch for `update_role_flags` — the Mixer panel's M/S toggles.
/// Unrecorded (applied to every history snapshot) so Ctrl-Z never flips a
/// mute, mirroring `TrackFlagsPatch`. Only `Some(_)` fields apply.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct RoleFlagsPatch {
    pub muted: Option<bool>,
    pub solo: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_default_is_dialogue() {
        assert_eq!(AudioRole::default(), AudioRole::Dialogue);
    }

    #[test]
    fn role_serializes_kebab() {
        assert_eq!(
            serde_json::to_string(&AudioRole::Voiceover).unwrap(),
            "\"voiceover\""
        );
        assert_eq!(
            serde_json::from_str::<AudioRole>("\"sfx\"").unwrap(),
            AudioRole::Sfx
        );
    }

    #[test]
    fn as_str_matches_wire_form() {
        for r in AudioRole::ALL {
            let wire = serde_json::to_string(&r).unwrap();
            assert_eq!(wire, format!("\"{}\"", r.as_str()));
        }
    }
}
