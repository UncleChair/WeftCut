// Per-workspace timeline view state (zoom + per-track heights + expanded
// keyframe sub-lanes), shared by the Electron main process (persistence owner,
// src/main/view-state.ts) and the renderer (consumer via ipc / useTimelineView).
// One definition → no main↔renderer drift. Persisted at <workspace>/view.json.
//
// UI-only knobs: deliberately NOT part of project.json so zooming the timeline
// never dirties the project document, pushes an undo entry, or shows up on the
// MCP tool surface.

export interface ViewState {
  /// Timeline horizontal zoom — pixels per second of timeline time.
  timeline_px_per_sec: number;
  /// Track id (UUID string) → row height in px. Tracks absent from the map
  /// fall back to the frontend default.
  track_heights: Record<string, number>;
  /// Track ids whose keyframe sub-lanes are expanded. Absent ⇒ collapsed.
  expanded_tracks: string[];
}

/** Fresh defaults (new object each call so callers can't share-mutate the map/array). */
export function viewStateDefaults(): ViewState {
  return { timeline_px_per_sec: 80, track_heights: {}, expanded_tracks: [] };
}
