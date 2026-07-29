import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Radio } from "@base-ui/react/radio";
import { Slider } from "@base-ui/react/slider";
import {
  setAppSettings,
  useDecodeEngine,
  usePlaybackResolution,
} from "./appSettingsStore";
import {
  useDecodeComponentAvailable,
  useDecodeComponentReason,
} from "./decodeComponentStore";
import { decodeEngineOptions } from "./decodeEngineOptions";

/// "Preview" section of the General settings pane — the two dials that
/// describe how THIS machine plays back: which engine decodes preview media,
/// and at what resolution. Applying either is a plain app-settings patch —
/// `PixiPreview` subscribes to the store and re-opens the live decode
/// transports in place, so the change is visible without a reload.
export function PreviewSection({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  return (
    <>
      <DecodeEngineCards onError={onError} />
      <PlaybackResolutionSlider onError={onError} />
    </>
  );
}

/// Per-engine one-liner under each card's title. The titles come from
/// `decodeEngineOptions` (shared with the export dialog so the two surfaces
/// can't drift in wording); the descriptions are preview-only — the export
/// dialog's select stays title-only.
const ENGINE_DESC_KEYS = {
  auto: "settings.decode_engine_auto_desc",
  ffmpeg: "settings.decode_engine_ffmpeg_desc",
  webcodecs: "settings.decode_engine_webcodecs_desc",
} as const;

/// Decode engine as radio cards: every option visible with its trade-off
/// inline, instead of hiding the comparison behind a dropdown + hint pair.
/// The Standard (FFmpeg) card disables — with the reason shown underneath —
/// when its component isn't installed, replacing the old select-then-error
/// flow.
function DecodeEngineCards({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation();
  const engine = useDecodeEngine();
  const componentAvailable = useDecodeComponentAvailable();
  const componentReason = useDecodeComponentReason();
  const options = decodeEngineOptions(t, componentAvailable);

  return (
    <div className="settings-choice-group">
      <span className="settings-toggle-label">
        {t("settings.decode_engine")}
      </span>
      <RadioGroup
        className="settings-radio-cards"
        value={engine}
        aria-label={t("settings.decode_engine")}
        onValueChange={async (next) => {
          onError("");
          try {
            await setAppSettings({ decode_engine: next });
          } catch (err) {
            onError(String(err));
          }
        }}
      >
        {options.map((o) => (
          <Radio.Root
            key={o.value}
            value={o.value}
            disabled={o.disabled ?? false}
            className="settings-radio-card"
          >
            <span className="settings-radio-card-dot" aria-hidden="true">
              <Radio.Indicator className="settings-radio-card-indicator" />
            </span>
            <span className="settings-radio-card-text">
              <span className="settings-radio-card-title">{o.label}</span>
              <span className="settings-radio-card-desc">
                {t(ENGINE_DESC_KEYS[o.value as keyof typeof ENGINE_DESC_KEYS])}
              </span>
            </span>
          </Radio.Root>
        ))}
      </RadioGroup>
      {!componentAvailable && (
        <p className="settings-toggle-hint">
          {t("settings.decode_engine_unavailable", {
            reason: componentReason ?? "",
          })}
        </p>
      )}
    </div>
  );
}

/// Preview quality dial as a three-stop slider — 流畅 (¼) on the left, 画质
/// (Full) on the right, one stop per fraction. Uses the Slider primitives
/// directly instead of AppSlider so the stops can render as dots inside the
/// track; the .app-slider* skin is unchanged. Drafts while dragging and
/// commits on release / keypress settle, so a drag from ¼ to Full re-opens
/// the decode transports once, not per stop crossed.
const RESOLUTION_STOPS = ["quarter", "half", "full"] as const;

/// Tick label under each stop, same order as RESOLUTION_STOPS.
const STOP_LABEL_KEYS = [
  "settings.playback_resolution_quarter",
  "settings.playback_resolution_half",
  "settings.playback_resolution_full",
] as const;

function PlaybackResolutionSlider({
  onError,
}: {
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const resolution = usePlaybackResolution();
  const storeIndex = RESOLUTION_STOPS.indexOf(resolution);
  const [draftIndex, setDraftIndex] = useState(storeIndex);

  useEffect(() => {
    setDraftIndex(storeIndex);
  }, [storeIndex]);

  const commit = async (index: number) => {
    const next = RESOLUTION_STOPS[index];
    if (next === undefined || next === resolution) return;
    onError("");
    try {
      await setAppSettings({ playback_resolution: next });
    } catch (err) {
      onError(String(err));
      setDraftIndex(storeIndex);
    }
  };

  return (
    <div className="settings-choice-group">
      <span className="settings-toggle-label">
        {t("settings.playback_resolution")}
      </span>
      <div className="settings-resolution-slider">
        <span className="settings-resolution-end">
          {t("settings.playback_resolution_smooth")}
        </span>
        <div className="settings-resolution-track">
          <Slider.Root
            className="app-slider"
            value={draftIndex}
            min={0}
            max={RESOLUTION_STOPS.length - 1}
            step={1}
            onValueChange={(v) => {
              if (typeof v === "number") setDraftIndex(v);
            }}
            onValueCommitted={(v) => {
              if (typeof v === "number") void commit(v);
            }}
          >
            <Slider.Control className="app-slider-control">
              <Slider.Track className="app-slider-track">
                <Slider.Indicator className="app-slider-indicator" />
                {RESOLUTION_STOPS.map((stop, i) => (
                  <span
                    key={stop}
                    className="settings-resolution-stop"
                    style={{
                      left: `${(i / (RESOLUTION_STOPS.length - 1)) * 100}%`,
                    }}
                    aria-hidden="true"
                  />
                ))}
                <Slider.Thumb
                  className="app-slider-thumb"
                  aria-label={t("settings.playback_resolution")}
                  getAriaValueText={() =>
                    t(STOP_LABEL_KEYS[draftIndex] ?? STOP_LABEL_KEYS[0])
                  }
                />
              </Slider.Track>
            </Slider.Control>
          </Slider.Root>
          <div className="settings-resolution-ticks" aria-hidden="true">
            {STOP_LABEL_KEYS.map((key, i) => (
              <span key={key} className={i === draftIndex ? "is-active" : undefined}>
                {t(key)}
              </span>
            ))}
          </div>
        </div>
        <span className="settings-resolution-end">
          {t("settings.playback_resolution_sharp")}
        </span>
      </div>
      <p className="settings-toggle-hint">
        {t("settings.playback_resolution_export_note")}
      </p>
    </div>
  );
}
