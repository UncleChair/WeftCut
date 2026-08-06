// The keyframe-edit algorithms the MCP keyframe tools use MUST be the renderer's
// golden-tested module (src/renderer/keyframe/edits.ts) — never a reimplementation
// — so TS-in-main and the Rust `keyframe_edits.rs` algorithms stay in lockstep
// (same rationale as snap.ts re-exporting the wasm eval leaf). The MCP path
// injects the actor's deterministic idGen as `mkId` so new keyframe ids match
// Rust `new_id()` allocation order under det mode.
export {
  liftToKeyframed,
  upsertKeyframe,
  removeKeyframe,
  retimeKeyframe,
  setKeyframeInterp,
  smoothKeyframe,
  smoothTrack,
} from '../../renderer/keyframe/edits'
