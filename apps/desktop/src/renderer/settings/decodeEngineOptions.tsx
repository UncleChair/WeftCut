// The decode-engine tier options (Automatic / Standard / Lite), shared by the
// preview picker (SettingsPanel's PreviewSection radio cards) and the export
// dialog so the two surfaces can't drift apart in wording or in the
// grayed-with-reason pattern (spec decision 10: "preview's exact pattern").
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import type { AppSelectOption } from "../components/AppSelect";

function engineTag(t: TFunction, key: string): ReactNode {
  return (
    <span style={{ marginLeft: 6, fontSize: 12, color: "var(--muted-foreground)" }}>
      {t(key)}
    </span>
  );
}

export function decodeEngineOptions(
  t: TFunction,
  componentAvailable: boolean,
): AppSelectOption[] {
  return [
    { value: "auto", label: t("settings.decode_engine_auto") },
    {
      value: "ffmpeg",
      label: (
        <>
          {t("settings.decode_engine_ffmpeg")}
          {engineTag(t, "settings.decode_engine_ffmpeg_tag")}
          {!componentAvailable &&
            ` — ${t("settings.decode_engine_unavailable_suffix")}`}
        </>
      ),
      disabled: !componentAvailable,
    },
    {
      value: "webcodecs",
      label: (
        <>
          {t("settings.decode_engine_webcodecs")}
          {engineTag(t, "settings.decode_engine_webcodecs_tag")}
        </>
      ),
    },
  ];
}
