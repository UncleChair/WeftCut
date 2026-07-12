// App-level preference types, shared by the Electron main process (owner of
// persistence) and the renderer (consumer via ipc). One definition → no
// main↔renderer drift. Mirrors the on-disk JSON shape exactly; field names are
// snake_case to match the file written historically by the Rust addon, so
// existing users' app_settings.json keeps working after the move to TS.

export type DisplayMode = "AbRoll" | "ShowAll";

export interface AppSettings {
  display_mode: DisplayMode;
  /// Half-width of the symmetric peek window in microseconds (default
  /// 10_000_000 = 10 s). Clamped on write to [1 s, 5 min].
  delta_window_us: number;
  /// Remembered last-toggle of the left MediaPool drawer.
  media_pool_drawer_open: boolean;
  /// Snap moved timeline layers to nearby layer boundaries and playhead.
  tail_snap_enabled: boolean;
  /// Pixel threshold for boundary snapping. Clamped on write.
  tail_snap_strength_px: number;
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
}

/// Patch shape — every field optional. The store merges into the current
/// settings, persists atomically, and returns the post-patch snapshot. Use
/// this for one-field flips (e.g., `{ display_mode: "ShowAll" }`) instead of
/// round-tripping the whole struct.
export interface AppSettingsPatch {
  display_mode?: DisplayMode;
  delta_window_us?: number;
  media_pool_drawer_open?: boolean;
  tail_snap_enabled?: boolean;
  tail_snap_strength_px?: number;
  prebake_motifs?: boolean;
  preview_effects_enabled?: boolean;
  decode_engine?: "auto" | "ffmpeg" | "webcodecs";
}

export const APP_SETTINGS_DEFAULTS: AppSettings = {
  display_mode: "AbRoll",
  delta_window_us: 10_000_000,
  media_pool_drawer_open: false,
  tail_snap_enabled: true,
  tail_snap_strength_px: 12,
  prebake_motifs: false,
  preview_effects_enabled: true,
  decode_engine: "auto",
};

export const DELTA_WINDOW_MIN_US = 1_000_000;
export const DELTA_WINDOW_MAX_US = 300_000_000;
export const TAIL_SNAP_STRENGTH_MIN_PX = 2;
export const TAIL_SNAP_STRENGTH_MAX_PX = 80;
