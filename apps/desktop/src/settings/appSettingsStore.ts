// App-level settings store (`docs/ab-roll-redesign`).
//
// Strict app-level scope: one value across every project. The Rust
// backend owns persistence (`apps/desktop/src-tauri/src/app_settings.rs`);
// this store mirrors the current value into React. Mutations go through
// `appSettingsSet` IPC; the backend emits `app_settings:changed` which
// `wireAppSettingsStream` listens for and writes back into the store.
//
// IMPORTANT (per `feedback_zustand_composite_selector`): consumers MUST
// use the atomic selector hooks exported below. Never spread the whole
// store object in a selector — that trips `useSyncExternalStore`'s
// reference equality and infinite-loops.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  APP_SETTINGS_EVENTS,
  appSettingsGet,
  appSettingsSet,
  type AppSettings,
  type AppSettingsPatch,
  type DisplayMode,
} from "../ipc";

/// Local store state. Mirrors the backend value plus a `loaded` flag so
/// UI can render a placeholder while the first IPC round-trip lands.
interface AppSettingsState {
  settings: AppSettings;
  loaded: boolean;
}

interface AppSettingsActions {
  /// Replace the in-memory snapshot. Used by both the initial fetch
  /// and the `app_settings:changed` event handler.
  hydrate: (next: AppSettings) => void;
}

const FALLBACK: AppSettings = {
  display_mode: "AbRoll",
  delta_window_us: 10_000_000,
  media_pool_drawer_open: false,
  tail_snap_enabled: true,
  tail_snap_strength_px: 12,
  prebake_motifs: false,
};

export const useAppSettingsStore = create<AppSettingsState & AppSettingsActions>(
  (set) => ({
    settings: FALLBACK,
    loaded: false,
    hydrate: (next) => set({ settings: next, loaded: true }),
  }),
);

// Atomic selectors. Each picks one field — composite object selectors
// would re-render every subscriber on any change.
export const useDisplayMode = (): DisplayMode =>
  useAppSettingsStore((s) => s.settings.display_mode);
export const useDeltaWindowUs = (): number =>
  useAppSettingsStore((s) => s.settings.delta_window_us);
export const useMediaPoolDrawerOpen = (): boolean =>
  useAppSettingsStore((s) => s.settings.media_pool_drawer_open);
export const useTailSnapEnabled = (): boolean =>
  useAppSettingsStore((s) => s.settings.tail_snap_enabled);
export const useTailSnapStrengthPx = (): number =>
  useAppSettingsStore((s) => s.settings.tail_snap_strength_px);
export const usePrebakeMotifsEnabled = (): boolean =>
  useAppSettingsStore((s) => s.settings.prebake_motifs);
export const useAppSettingsLoaded = (): boolean =>
  useAppSettingsStore((s) => s.loaded);

/// Apply a patch through IPC. Returns the post-patch snapshot. The
/// store updates twice for the same mutation — once synchronously when
/// the IPC promise resolves, once via the `app_settings:changed` event
/// — but both writes are identical so subscribers see a stable value.
export async function setAppSettings(
  patch: AppSettingsPatch,
): Promise<AppSettings> {
  const after = await appSettingsSet(patch);
  useAppSettingsStore.getState().hydrate(after);
  return after;
}

/// One-shot helpers for the common pill/menu/shortcut surfaces. They
/// resolve to `setAppSettings(...)` under the hood but make the
/// call-sites read like intent.
export async function toggleDisplayMode(): Promise<AppSettings> {
  const current = useAppSettingsStore.getState().settings.display_mode;
  const next: DisplayMode = current === "AbRoll" ? "ShowAll" : "AbRoll";
  return setAppSettings({ display_mode: next });
}

export async function setMediaPoolDrawerOpen(
  open: boolean,
): Promise<AppSettings> {
  return setAppSettings({ media_pool_drawer_open: open });
}

/// Wire-up: fetch the current settings, subscribe to backend changes.
/// Returns an unlisten function — `App.tsx` calls this once on mount.
export async function wireAppSettingsStream(): Promise<UnlistenFn> {
  // Seed from the current value first so the store reflects the disk
  // state before the first event fires.
  try {
    const initial = await appSettingsGet();
    useAppSettingsStore.getState().hydrate(initial);
  } catch (e) {
    // IPC unavailable during early boot or in tests; keep defaults.
    console.warn("appSettingsGet failed:", e);
  }
  return listen<AppSettings>(APP_SETTINGS_EVENTS.changed, (e) => {
    useAppSettingsStore.getState().hydrate(e.payload);
  });
}
