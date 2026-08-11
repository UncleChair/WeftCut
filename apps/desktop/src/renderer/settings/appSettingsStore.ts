// App-level settings store (`docs/data-model.md`).
//
// Strict app-level scope: one value across every project. The Electron main
// process owns persistence (`apps/desktop/src/main/app-settings.ts`);
// this store mirrors the current value into React. Mutations go through
// `appSettingsSet` IPC; main emits `app_settings:changed` which
// `wireAppSettingsStream` listens for and writes back into the store.
//
// It owns the UI language ↔ i18next bridge too — see `setLocale`.
//
// IMPORTANT: consumers MUST read through the atomic selector hooks exported
// below, never a composite selector — see the note there.

import { listen, type UnlistenFn } from "@/bridge/events";
import { create } from "zustand";

import i18n, { SUPPORTED_LOCALES, type Locale } from "../i18n";

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
  tail_snap_enabled: true,
  tail_snap_strength_px: 12,
  preview_snap_enabled: true,
  preview_snap_strength_px: 12,
  prebake_motifs: false,
  preview_effects_enabled: true,
  decode_engine: "auto",
  playback_resolution: "full",
  media_pool_layout: "large",
  timeline_follow_playhead: true,
};

export const useAppSettingsStore = create<AppSettingsState & AppSettingsActions>(
  (set) => ({
    settings: FALLBACK,
    loaded: false,
    hydrate: (next) => set({ settings: next, loaded: true }),
  }),
);

// Atomic selectors. Each picks one field: a composite selector builds a fresh
// object per call, which trips `useSyncExternalStore`'s reference equality and
// infinite-loops (`feedback_zustand_composite_selector`).
export const useDisplayMode = (): DisplayMode =>
  useAppSettingsStore((s) => s.settings.display_mode);
export const useDeltaWindowUs = (): number =>
  useAppSettingsStore((s) => s.settings.delta_window_us);
export const useTailSnapEnabled = (): boolean =>
  useAppSettingsStore((s) => s.settings.tail_snap_enabled);
export const useTailSnapStrengthPx = (): number =>
  useAppSettingsStore((s) => s.settings.tail_snap_strength_px);
/// Preview-gizmo snapping. The gizmo itself does NOT use these hooks — its
/// gestures are pointer-rate and imperative, so `TransformGizmo` reads the
/// values off `useAppSettingsStore.getState()` at pointerdown (the whole snap
/// target set is frozen there — see `docs/features.md`, "On-canvas transform
/// (gizmo)"). These are for the settings UI.
export const usePreviewSnapEnabled = (): boolean =>
  useAppSettingsStore((s) => s.settings.preview_snap_enabled);
export const usePreviewSnapStrengthPx = (): number =>
  useAppSettingsStore((s) => s.settings.preview_snap_strength_px);
export const usePrebakeMotifsEnabled = (): boolean =>
  useAppSettingsStore((s) => s.settings.prebake_motifs);
export const useDecodeEngine = (): AppSettings["decode_engine"] =>
  useAppSettingsStore((s) => s.settings.decode_engine);
/// Preview playback resolution (`full` | `half` | `quarter`). The preview
/// itself does NOT read this hook — `PixiPreview` subscribes to the store
/// directly so a change re-opens the decode transport in place instead of
/// re-rendering the React tree. This is for the settings UI.
export const usePlaybackResolution = (): AppSettings["playback_resolution"] =>
  useAppSettingsStore((s) => s.settings.playback_resolution);
/// Media-pool card arrangement: `large` (one card per row), `grid`
/// (fixed-size cards, adaptive columns), `list` (compact rows).
export const useMediaPoolLayout = (): AppSettings["media_pool_layout"] =>
  useAppSettingsStore((s) => s.settings.media_pool_layout);
/// Whether the timeline pages its view to keep the playhead visible.
export const useFollowPlayheadEnabled = (): boolean =>
  useAppSettingsStore((s) => s.settings.timeline_follow_playhead);
/// Persisted UI language (a SUPPORTED_LOCALES code), or `undefined` when unset
/// (the renderer auto-detects the OS language). i18next remains the live
/// language source; this is the persisted user choice.
export const useLanguage = (): string | undefined =>
  useAppSettingsStore((s) => s.settings.language);
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

export async function toggleFollowPlayhead(): Promise<AppSettings> {
  const current = useAppSettingsStore.getState().settings.timeline_follow_playhead;
  return setAppSettings({ timeline_follow_playhead: !current });
}

/// Imperative read for the command palette's checkmark, which is evaluated
/// inside `listCommands()` rather than during a render — same reason
/// `appCommands.ts` reads `toolStore` directly.
export function followPlayheadEnabled(): boolean {
  return useAppSettingsStore.getState().settings.timeline_follow_playhead;
}

/// Change the UI language AND persist it to app_settings.json — the single
/// source of truth for language. i18next is updated synchronously so the UI
/// switches immediately; the disk write is fire-and-forget (the
/// `app_settings:changed` echo re-applies it — a no-op here, but the path that
/// syncs the change to OTHER windows).
export function setLocale(next: Locale): void {
  void i18n.changeLanguage(next);
  void setAppSettings({ language: next });
}

/// The old (pre-app_settings) localStorage cache key written by i18next's
/// LanguageDetector. Read once to migrate the choice, then cleared.
const LEGACY_LOCALE_STORAGE_KEY = "weftcut.locale";

/// Apply a persisted locale to the i18next runtime. No-op when unset (→ leave
/// the OS-detected default) or already active (avoids a redundant
/// `languageChanged` churn on the `app_settings:changed` echo).
function applyPersistedLocale(locale: string | undefined): void {
  if (!locale || i18n.resolvedLanguage === locale) return;
  void i18n.changeLanguage(locale);
}

/// One-time migration for users upgrading from the localStorage era: older
/// builds cached the choice under `weftcut.locale`. When app_settings has no
/// language yet, adopt that value (if it's a supported locale) into the store,
/// then drop the stale key so this never runs again.
function migrateLegacyLocale(): void {
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_LOCALE_STORAGE_KEY);
  } catch {
    return; // localStorage unavailable (e.g. tests) — nothing to migrate.
  }
  if (legacy && (SUPPORTED_LOCALES as readonly string[]).includes(legacy)) {
    setLocale(legacy as Locale); // persist into app_settings + apply to i18next
  }
  try {
    localStorage.removeItem(LEGACY_LOCALE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/// Wire-up: fetch the current settings, subscribe to backend changes.
/// Returns an unlisten function — `App.tsx` calls this once on mount.
export async function wireAppSettingsStream(): Promise<UnlistenFn> {
  // Subscribe BEFORE the seed read: a change emitted between the seed
  // resolving and the listener registering would be lost, and this store
  // carries preview-critical fields (playback_resolution, decode_engine) that
  // would then sit stale until the next unrelated settings write.
  let eventSeen = false;
  const unlisten = await listen<AppSettings>(APP_SETTINGS_EVENTS.changed, (e) => {
    eventSeen = true;
    useAppSettingsStore.getState().hydrate(e.payload);
    // Keep i18next in sync when the language changes (incl. from another window).
    applyPersistedLocale(e.payload.language);
  });
  // Seed from the current value so the store reflects the disk state even if
  // no event ever fires. Events carry point-in-time payloads, so a seed that
  // lost the race must NOT hydrate over a newer event's payload — hence the
  // latch, not a blind double-hydrate.
  try {
    const initial = await appSettingsGet();
    if (!eventSeen) {
      useAppSettingsStore.getState().hydrate(initial);
      // Apply the persisted language choice to i18next, or migrate a legacy
      // `weftcut.locale` on first upgrade.
      if (initial.language) applyPersistedLocale(initial.language);
      else migrateLegacyLocale();
    }
  } catch (e) {
    // IPC unavailable during early boot or in tests; keep defaults.
    console.warn("appSettingsGet failed:", e);
  }
  return unlisten;
}
