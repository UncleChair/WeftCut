// Phase B4 — preview-mode preference store.
//
// User-facing preference (Auto / Real-time / Cached) persisted to
// localStorage. The PreviewSurface integration (B5) reads
// `useEffectivePreviewMode()` to decide whether to render
// segmented (A's MSE) or realtime (B's WebCodecs).
//
// IMPORTANT: per `feedback_zustand_composite_selector`, consumers
// MUST use the atomic selector hooks exported below — never spread
// the whole store object in a selector. That trap unmounted the
// editor's StatusBar once already.

import { create } from "zustand";

import type { RealtimeCapability } from "./capability";

/// User-facing setting. Drives `resolveEffectiveMode`.
export type PreviewModePreference = "auto" | "realtime" | "cached";

/// Resolved engine choice consumed by PreviewSurface (in B5).
/// `legacy` is the pre-segmented whole-timeline path; preserved as
/// the runtime fallback when neither realtime nor segmented engines
/// can serve (e.g. Linux without WebKitGTK 2.46+ and without the
/// segmented env var).
export type EffectivePreviewMode = "realtime" | "segmented" | "legacy";

const STORAGE_KEY = "weftcut:previewModePreference";

function readPersistedPreference(): PreviewModePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "auto" || raw === "realtime" || raw === "cached") return raw;
  } catch {
    // localStorage can be blocked; fall through to default.
  }
  return "auto";
}

function writePersistedPreference(pref: PreviewModePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Non-fatal; preference resets on next load.
  }
}

interface PreviewModeState {
  preference: PreviewModePreference;
  /// `null` until the probe has completed at least once. The settings
  /// UI shows "probing…" in that window; mode resolution treats it
  /// as "not yet known" and falls through to segmented.
  capability: RealtimeCapability | null;
}

interface PreviewModeActions {
  setPreference: (next: PreviewModePreference) => void;
  setCapability: (report: RealtimeCapability) => void;
}

export const usePreviewModeStore = create<PreviewModeState & PreviewModeActions>(
  (set) => ({
    preference: readPersistedPreference(),
    capability: null,

    setPreference: (next) => {
      writePersistedPreference(next);
      set({ preference: next });
    },
    setCapability: (report) => set({ capability: report }),
  }),
);

// Atomic selectors — DO NOT compose into a single object selector.
// Composite object selectors return a fresh `{...}` each call and
// trip `useSyncExternalStore`'s reference equality, causing infinite
// re-render loops. (`feedback_zustand_composite_selector` memory.)
export const usePreviewModePreference = (): PreviewModePreference =>
  usePreviewModeStore((s) => s.preference);
export const usePreviewModeCapability = (): RealtimeCapability | null =>
  usePreviewModeStore((s) => s.capability);
export const useSetPreviewModePreference = (): ((
  next: PreviewModePreference,
) => void) => usePreviewModeStore((s) => s.setPreference);
export const useSetPreviewModeCapability = (): ((
  report: RealtimeCapability,
) => void) => usePreviewModeStore((s) => s.setCapability);

/// Resolve the effective engine from preference + capability.
///
///   pref=cached   → always segmented (A's MSE)
///   pref=realtime → realtime if api+codec ok; segmented otherwise
///                   (treat "realtime" as a strong hint but still
///                    safe: missing decoder = no playback at all)
///   pref=auto     → realtime if capability.ok; segmented otherwise
///   capability=null → segmented (probe hasn't completed)
export function resolveEffectiveMode(
  preference: PreviewModePreference,
  capability: RealtimeCapability | null,
): EffectivePreviewMode {
  if (preference === "cached") return "segmented";
  if (!capability) return "segmented";
  if (preference === "realtime") {
    // User override: trust the user, but only when the decoder is
    // actually present — without it, realtime would draw nothing.
    return capability.apiPresent && capability.h264Supported
      ? "realtime"
      : "segmented";
  }
  // Auto: all-or-nothing on the full probe result.
  return capability.ok ? "realtime" : "segmented";
}

export function useEffectivePreviewMode(): EffectivePreviewMode {
  const preference = usePreviewModePreference();
  const capability = usePreviewModeCapability();
  return resolveEffectiveMode(preference, capability);
}
