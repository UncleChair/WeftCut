// App-level preference types, shared by the Electron main process (owner of
// persistence) and the renderer (consumer via ipc). One definition → no
// main↔renderer drift. Mirrors the on-disk JSON shape exactly; field names are
// snake_case to match the file written historically by the Rust addon, so
// existing users' app_settings.json keeps working after the move to TS.

export type DisplayMode = "AbRoll" | "ShowAll";

/// Preview playback resolution — the user-owned quality/throughput dial every
/// mainstream NLE carries (Premiere's Full / ½ / ¼). Names the FRACTION, not
/// the divisor: `renderer/render/decoder/playbackResolution.ts` is the one
/// place it becomes a number.
export type PlaybackResolution = "full" | "half" | "quarter";

/// Media-pool card arrangement: `large` keeps the legacy one-card-per-row
/// full-width cards; `grid` packs fixed-size cards into as many columns as
/// the panel width fits; `list` renders compact file-manager-style rows.
export type MediaPoolLayout = "large" | "grid" | "list";

export interface AppSettings {
  display_mode: DisplayMode;
  /// Half-width of the symmetric peek window in microseconds (default
  /// 10_000_000 = 10 s). Clamped on write to [1 s, 5 min].
  delta_window_us: number;
  /// Snap moved timeline layers to nearby layer boundaries and playhead.
  tail_snap_enabled: boolean;
  /// Pixel threshold for boundary snapping. Clamped on write.
  tail_snap_strength_px: number;
  /// Snap the preview gizmo's move and resize gestures to the composition's
  /// edges and centre lines and to other staged layers' bounding boxes.
  /// Deliberately separate from `tail_snap_enabled`: the two domains differ by
  /// an order of magnitude in target density (every clip boundary on every
  /// visible track vs six composition lines plus a handful of layers), so one
  /// threshold cannot be tuned for both.
  preview_snap_enabled: boolean;
  /// SCREEN-pixel snap radius for the preview gizmo — the same unit as
  /// `tail_snap_strength_px`, and the reason the solver divides it by the
  /// contain fit's scale before comparing in composition space. Composition
  /// pixels would feel different on a 1080p and a 4K composition and would
  /// drift as the panel is resized. Clamped on write.
  preview_snap_strength_px: number;
  /// When true, every motif layer's full frame sequence is pre-baked
  /// to disk in the background (L2). Default false. See docs/motifs.md.
  prebake_motifs: boolean;
  /// When false, the preview compositor skips all effect filters (LOD
  /// toggle for scrub performance). Default true.
  preview_effects_enabled: boolean;
  /// Preview decode engine: `auto` picks the best engine per clip (FFmpeg when
  /// its component is present, else WebCodecs); `ffmpeg` (Standard) plays every
  /// format; `webcodecs` (Lite) is lightweight but supports fewer formats.
  decode_engine: "auto" | "ffmpeg" | "webcodecs";
  /// Preview playback resolution. `full` ships every decoded frame at source
  /// size; `half`/`quarter` have the native decoder downscale each frame
  /// BEFORE it crosses IPC, which is where a 4K software-lane preview spends
  /// 12.44 MB per frame. Preview only — export always decodes full size.
  /// App-level, like `decode_engine`: it describes THIS machine's headroom.
  playback_resolution: PlaybackResolution;
  /// Media-pool card arrangement (see MediaPoolLayout). App-level: it's a
  /// browsing preference of this user, not a property of any project.
  media_pool_layout: MediaPoolLayout;
  /// Keep the playhead inside the timeline's visible span by paging the view
  /// when it reaches an edge (`renderer/timeline/followPlayhead.ts`). Off means
  /// the view only ever moves because the user moved it.
  timeline_follow_playhead: boolean;
  /// Paint the project's markers in the timeline ruler's lower half
  /// (`renderer/timeline/TimelineRuler.tsx`). A canvas-noise control and nothing
  /// more: `add_markers` can spray hundreds in one commit, and this silences
  /// them. App-level because it is a view preference of this user, not project
  /// content — and the search palette keeps indexing and navigating to markers
  /// either way.
  markers_visible: boolean;
  /// Absolute path to the user-configurable data root that owns all large,
  /// app-managed, relocatable content (motifs/, cache/, downloads/). Empty /
  /// unset means "use the default" — the main-process resolver
  /// (dataRoot.ts) substitutes `<userData>/data`. It CANNOT itself live under
  /// the data root (bootstrap chicken-and-egg), so it stays in app_settings.json
  /// under userData. Optional on disk: absent on every pre-existing file.
  data_root?: string;
  /// Persisted UI language as a locale code (e.g. "en-US", "zh-CN"). The SINGLE
  /// source of truth for UI language.
  /// Optional: unset means "auto-detect from the OS on first launch" (i18next's
  /// navigator detection) — set only once the user explicitly picks one via the
  /// locale toggle. Valid values are the renderer's SUPPORTED_LOCALES; an
  /// unknown code is tolerated (i18next falls back), so main does not validate
  /// the set. Kept off disk when unset, like data_root.
  language?: string;
}

/// Patch shape — every field optional. The store merges into the current
/// settings, persists atomically, and returns the post-patch snapshot. Use
/// this for one-field flips (e.g., `{ display_mode: "ShowAll" }`) instead of
/// round-tripping the whole struct.
export interface AppSettingsPatch {
  display_mode?: DisplayMode;
  delta_window_us?: number;
  tail_snap_enabled?: boolean;
  tail_snap_strength_px?: number;
  preview_snap_enabled?: boolean;
  preview_snap_strength_px?: number;
  prebake_motifs?: boolean;
  preview_effects_enabled?: boolean;
  decode_engine?: "auto" | "ffmpeg" | "webcodecs";
  playback_resolution?: PlaybackResolution;
  media_pool_layout?: MediaPoolLayout;
  timeline_follow_playhead?: boolean;
  markers_visible?: boolean;
  /// New data-root path. An empty string clears it back to unset (→ default).
  data_root?: string;
  /// New UI language (a SUPPORTED_LOCALES code). An empty string clears it back
  /// to unset (→ auto-detect on next launch).
  language?: string;
}

export const APP_SETTINGS_DEFAULTS: AppSettings = {
  display_mode: "AbRoll",
  delta_window_us: 10_000_000,
  tail_snap_enabled: true,
  tail_snap_strength_px: 12,
  // Same numbers as the timeline's pair on purpose — "snap strength" already
  // means a screen-pixel radius in this app, so there is no second dial to
  // learn. On by default, like the timeline's.
  preview_snap_enabled: true,
  preview_snap_strength_px: 12,
  prebake_motifs: false,
  preview_effects_enabled: true,
  decode_engine: "auto",
  playback_resolution: "full",
  media_pool_layout: "large",
  // On, like every mainstream NLE ships it: a playhead that walks off-screen
  // mid-playback is the surprising state, not the followed one.
  timeline_follow_playhead: true,
  // On, because it is what every NLE that has markers does, and because a
  // feature nobody can see is indistinguishable from one that doesn't work:
  // markers have been write-only until now.
  markers_visible: true,
  data_root: undefined,
  language: undefined,
};

export const DELTA_WINDOW_MIN_US = 1_000_000;
export const DELTA_WINDOW_MAX_US = 300_000_000;
export const TAIL_SNAP_STRENGTH_MIN_PX = 2;
export const TAIL_SNAP_STRENGTH_MAX_PX = 80;
export const PREVIEW_SNAP_STRENGTH_MIN_PX = 2;
export const PREVIEW_SNAP_STRENGTH_MAX_PX = 80;
