// Transcription-engine selector options (Auto + one per known backend), shared
// shape with the decode-engine picker (decodeEngineOptions.tsx). Data-driven
// from the backend listing so a new engine appears automatically. FunASR is now
// selectable (its sherpa-onnx sidecar shipped in ticket 06); the shown-but-
// disabled mechanism stays generic for any future not-yet-built backend.
import type { TFunction } from "i18next";
import type { AppSelectOption } from "../components/AppSelect";
import type { SpeechBackendInfo } from "../ipc";

/// Backends with no transcriber impl yet: shown in the selector for
/// discoverability, but disabled (choosing one has no effect). Empty today —
/// every listed backend has a working sidecar/impl.
const NOT_YET_SELECTABLE: ReadonlySet<string> = new Set();

export function speechEngineOptions(
  t: TFunction,
  backends: readonly SpeechBackendInfo[],
): AppSelectOption[] {
  const opts: AppSelectOption[] = [
    { value: "auto", label: t("settings.speech_engine_auto") },
  ];
  for (const b of backends) {
    opts.push({
      value: b.backend,
      label: NOT_YET_SELECTABLE.has(b.backend)
        ? `${b.label} — ${t("settings.speech_engine_soon")}`
        : b.label,
      disabled: NOT_YET_SELECTABLE.has(b.backend),
    });
  }
  return opts;
}
