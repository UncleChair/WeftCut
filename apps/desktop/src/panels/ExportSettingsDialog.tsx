import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { documentDir, join } from "@tauri-apps/api/path";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { exportSettingsGet, exportSettingsSet, workspaceDir } from "../ipc";
import {
  type EncodePath,
  resolveEncodePath,
} from "../render/exportCodecProbe";
import {
  type CodecId,
  type Container,
  type ExportSettings,
  type QualityPreset,
  type RateMode,
  containerExtension,
  containersForCodec,
  isCodecContainerValid,
  downscaleFpsOptions,
  downscaleHeightOptions,
  mergeSettings,
  resolveOutputDims,
  clampExportRange,
  KEYFRAME_INTERVALS,
  type AudioCodecId,
  AUDIO_BITRATES,
  AUDIO_SAMPLE_RATES,
  AUDIO_CHANNELS,
  audioCodecsForContainer,
  isAudioCodecContainerValid,
} from "../render/exportSettings";
import { formatTimecode, parseTimecode } from "../frames";

interface Comp {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
}

interface Props {
  comp: Comp;
  currentTimeUs: number;
  durationUs: number;
  onCancel: () => void;
  onConfirm: (
    settings: ExportSettings,
    path: string,
    range: { startUs: number; endUs: number },
  ) => void;
}

export function ExportSettingsDialog({ comp, currentTimeUs, durationUs, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [location, setLocation] = useState<string>("");
  const [filename, setFilename] = useState<string>("weftcut-export");
  const [encodePath, setEncodePath] = useState<EncodePath | null>(null);
  const [rangeMode, setRangeMode] = useState<"full" | "custom">("full");
  const [rangeStartUs, setRangeStartUs] = useState<number>(0);
  const [rangeEndUs, setRangeEndUs] = useState<number>(durationUs);
  // Keep the default "custom" end in sync if the project duration arrives late.
  useEffect(() => {
    setRangeEndUs((e) => (e === 0 ? durationUs : e));
  }, [durationUs]);

  const compFps = comp.fps_num / comp.fps_den;

  // Load saved settings (per project) on mount.
  useEffect(() => {
    let cancelled = false;
    exportSettingsGet()
      .then((saved) => {
        if (!cancelled) setSettings(mergeSettings(saved));
      })
      .catch(() => {
        if (!cancelled) setSettings(mergeSettings(null));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Default the output location to <project>/output (falls back to the
  // Documents folder when no project is open). Created on export if missing.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let dir = "";
      try {
        const ws = await workspaceDir();
        dir = ws ? await join(ws, "output") : await documentDir();
      } catch {
        try {
          dir = await documentDir();
        } catch {
          dir = "";
        }
      }
      if (!cancelled) setLocation(dir);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve the encode path (webcodecs vs ffmpeg) whenever codec / output
  // dims / fps change, so the dialog can show a path badge. Path depends only
  // on codec + output dims + fps — not quality/container/rate.
  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    setEncodePath(null);
    const d = resolveOutputDims(comp, settings);
    const fps = settings.fps != null ? settings.fps : compFps;
    void resolveEncodePath(settings.codec, d.width, d.height, fps).then((p) => {
      if (!cancelled) setEncodePath(p);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.codec, settings?.fps, settings?.resolutionHeight, comp, compFps]);

  const patch = (p: Partial<ExportSettings>) =>
    setSettings((s) => (s ? { ...s, ...p } : s));

  async function onBrowse() {
    const chosen = await openDialog({
      title: t("export_dialog.choose_location"),
      directory: true,
      multiple: false,
      ...(location ? { defaultPath: location } : {}),
    });
    if (typeof chosen === "string") setLocation(chosen);
  }

  async function onExport() {
    if (!settings || !location || !filename.trim()) return;
    const ext = containerExtension(settings.container);
    const out = await join(location, `${filename.trim()}.${ext}`);
    await exportSettingsSet(settings).catch(() => {});
    const range =
      rangeMode === "full"
        ? { startUs: 0, endUs: durationUs }
        : clampExportRange(rangeStartUs, rangeEndUs, durationUs);
    onConfirm(settings, out, range);
  }

  const canExport =
    !!location &&
    filename.trim().length > 0 &&
    encodePath !== null &&
    (rangeMode === "full" || rangeStartUs < rangeEndUs);

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true">
      <div className="settings-panel">
        <header>
          <h2>{t("export_dialog.title")}</h2>
          <button
            className="settings-close"
            onClick={onCancel}
            aria-label={t("export_dialog.cancel")}
          >
            ✕
          </button>
        </header>

        <div className="settings-body">
          <div className="settings-card">
            {!settings ? (
              <p className="settings-blurb">…</p>
            ) : (
              <>
                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.filename")}
                  </span>
                  <span className="export-filename">
                    <input
                      type="text"
                      className="settings-input export-filename-input"
                      value={filename}
                      spellCheck={false}
                      onChange={(e) => setFilename(e.target.value)}
                    />
                    <span className="settings-slider-unit">
                      .{containerExtension(settings.container)}
                    </span>
                  </span>
                </div>

                <div className="export-row export-path-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.location")}
                  </span>
                  <span className="export-path">
                    <input
                      type="text"
                      className="settings-input export-path-input"
                      readOnly
                      value={location}
                      title={location}
                    />
                    <button onClick={() => void onBrowse()}>
                      {t("export_dialog.browse")}
                    </button>
                  </span>
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.resolution")}
                  </span>
                  <select
                    className="export-select"
                    value={settings.resolutionHeight ?? ""}
                    onChange={(e) =>
                      patch({
                        resolutionHeight: e.target.value
                          ? Number(e.target.value)
                          : null,
                      })
                    }
                  >
                    <option value="">
                      {t("export_dialog.follow_comp")} ({comp.width}×
                      {comp.height})
                    </option>
                    {downscaleHeightOptions(comp.height).map((h) => (
                      <option key={h} value={h}>
                        {h}p
                      </option>
                    ))}
                  </select>
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.fps")}
                  </span>
                  <select
                    className="export-select"
                    value={settings.fps ?? ""}
                    onChange={(e) =>
                      patch({
                        fps: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  >
                    <option value="">
                      {t("export_dialog.follow_comp")} ({compFps.toFixed(2)})
                    </option>
                    {downscaleFpsOptions(compFps).map((f) => (
                      <option key={f} value={f}>
                        {f} fps
                      </option>
                    ))}
                  </select>
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.range")}
                  </span>
                  <select
                    className="export-select"
                    value={rangeMode}
                    onChange={(e) =>
                      setRangeMode(e.target.value as "full" | "custom")
                    }
                  >
                    <option value="full">{t("export_dialog.range_full")}</option>
                    <option value="custom">{t("export_dialog.range_custom")}</option>
                  </select>
                </div>
                {rangeMode === "custom" && (
                  <>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.range_in")}
                      </span>
                      <span className="export-range-field">
                        <input
                          type="text"
                          className="settings-input"
                          spellCheck={false}
                          value={formatTimecode(rangeStartUs, comp.fps_num, comp.fps_den)}
                          onChange={(e) => {
                            const us = parseTimecode(e.target.value, comp.fps_num, comp.fps_den);
                            if (us !== null) setRangeStartUs(us);
                          }}
                        />
                        <button
                          onClick={() =>
                            setRangeStartUs(Math.min(currentTimeUs, rangeEndUs))
                          }
                        >
                          {t("export_dialog.set_to_playhead")}
                        </button>
                      </span>
                    </div>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.range_out")}
                      </span>
                      <span className="export-range-field">
                        <input
                          type="text"
                          className="settings-input"
                          spellCheck={false}
                          value={formatTimecode(rangeEndUs, comp.fps_num, comp.fps_den)}
                          onChange={(e) => {
                            const us = parseTimecode(e.target.value, comp.fps_num, comp.fps_den);
                            if (us !== null) setRangeEndUs(us);
                          }}
                        />
                        <button
                          onClick={() =>
                            setRangeEndUs(Math.max(currentTimeUs, rangeStartUs))
                          }
                        >
                          {t("export_dialog.set_to_playhead")}
                        </button>
                      </span>
                    </div>
                  </>
                )}

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.codec")}
                  </span>
                  <select
                    className="export-select"
                    value={settings.codec}
                    onChange={(e) => {
                      const codec = e.target.value as CodecId;
                      if (!isCodecContainerValid(codec, settings.container)) {
                        // Falls back to MP4 → Opus (MKV-only) must also reset.
                        const audio = { ...settings.audio, codec: "aac" as AudioCodecId };
                        patch({ codec, container: "mp4", audio });
                      } else {
                        patch({ codec });
                      }
                    }}
                  >
                    <option value="h264">H.264</option>
                    <option value="av1">AV1</option>
                    <option value="hevc">HEVC</option>
                  </select>
                </div>
                {encodePath === null ? (
                  <p className="settings-blurb">
                    {t("export_dialog.checking_codec")}
                  </p>
                ) : (
                  <p className="settings-blurb">
                    {encodePath === "ffmpeg"
                      ? t("export_dialog.path_ffmpeg")
                      : t("export_dialog.path_webcodecs")}
                  </p>
                )}

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.container")}
                  </span>
                  <select
                    className="export-select"
                    value={settings.container}
                    onChange={(e) => {
                      const container = e.target.value as Container;
                      const audio = isAudioCodecContainerValid(
                        settings.audio.codec,
                        container,
                      )
                        ? settings.audio
                        : { ...settings.audio, codec: "aac" as AudioCodecId };
                      patch({ container, audio });
                    }}
                  >
                    {containersForCodec(settings.codec).map((c) => (
                      <option key={c} value={c}>
                        {c.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.quality")}
                  </span>
                  <select
                    className="export-select"
                    value={settings.quality}
                    onChange={(e) =>
                      patch({ quality: e.target.value as QualityPreset })
                    }
                  >
                    <option value="low">{t("export_dialog.quality_low")}</option>
                    <option value="medium">
                      {t("export_dialog.quality_medium")}
                    </option>
                    <option value="high">
                      {t("export_dialog.quality_high")}
                    </option>
                    <option value="custom">
                      {t("export_dialog.quality_custom")}
                    </option>
                  </select>
                </div>
                {settings.quality === "custom" && (
                  <div className="export-row">
                    <span className="settings-toggle-label">
                      {t("export_dialog.custom_bitrate")}
                    </span>
                    <span className="export-bitrate">
                      <input
                        type="number"
                        className="settings-input settings-input-narrow"
                        min={500}
                        step={500}
                        value={
                          settings.customBitrate
                            ? settings.customBitrate / 1_000_000
                            : ""
                        }
                        onChange={(e) =>
                          patch({
                            customBitrate: e.target.value
                              ? Math.round(Number(e.target.value) * 1_000_000)
                              : null,
                          })
                        }
                      />
                      <span className="settings-slider-unit">
                        {t("export_dialog.mbps")}
                      </span>
                    </span>
                  </div>
                )}

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.rate_mode")}
                  </span>
                  <select
                    className="export-select"
                    value={settings.rateMode}
                    onChange={(e) =>
                      patch({ rateMode: e.target.value as RateMode })
                    }
                  >
                    <option value="vbr">VBR</option>
                    <option value="cbr">CBR</option>
                  </select>
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.keyframe_interval")}
                  </span>
                  <select
                    className="export-select"
                    value={settings.keyframeIntervalSec}
                    onChange={(e) =>
                      patch({ keyframeIntervalSec: Number(e.target.value) })
                    }
                  >
                    {KEYFRAME_INTERVALS.map((s) => (
                      <option key={s} value={s}>
                        {s}s
                      </option>
                    ))}
                  </select>
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.audio_include")}
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.audio.include}
                    onChange={(e) =>
                      patch({ audio: { ...settings.audio, include: e.target.checked } })
                    }
                  />
                </div>
                {settings.audio.include && (
                  <>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.audio_codec")}
                      </span>
                      <select
                        className="export-select"
                        value={settings.audio.codec}
                        onChange={(e) =>
                          patch({
                            audio: {
                              ...settings.audio,
                              codec: e.target.value as AudioCodecId,
                            },
                          })
                        }
                      >
                        {audioCodecsForContainer(settings.container).map((c) => (
                          <option key={c} value={c}>
                            {c.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.audio_bitrate")}
                      </span>
                      <select
                        className="export-select"
                        value={settings.audio.bitrate}
                        onChange={(e) =>
                          patch({
                            audio: { ...settings.audio, bitrate: Number(e.target.value) },
                          })
                        }
                      >
                        {AUDIO_BITRATES.map((b) => (
                          <option key={b} value={b}>
                            {b / 1000} kbps
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.audio_channels")}
                      </span>
                      <select
                        className="export-select"
                        value={settings.audio.channels ?? ""}
                        onChange={(e) =>
                          patch({
                            audio: {
                              ...settings.audio,
                              channels: e.target.value ? Number(e.target.value) : null,
                            },
                          })
                        }
                      >
                        <option value="">{t("export_dialog.follow_comp")}</option>
                        {AUDIO_CHANNELS.map((c) => (
                          <option key={c} value={c}>
                            {c === 1
                              ? t("export_dialog.channels_mono")
                              : t("export_dialog.channels_stereo")}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.audio_sample_rate")}
                      </span>
                      <select
                        className="export-select"
                        value={settings.audio.sampleRate ?? ""}
                        onChange={(e) =>
                          patch({
                            audio: {
                              ...settings.audio,
                              sampleRate: e.target.value ? Number(e.target.value) : null,
                            },
                          })
                        }
                      >
                        <option value="">{t("export_dialog.follow_comp")}</option>
                        {AUDIO_SAMPLE_RATES.map((r) => (
                          <option key={r} value={r}>
                            {(r / 1000).toFixed(1)} kHz
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}

                <div className="export-actions">
                  <button onClick={onCancel}>
                    {t("export_dialog.cancel")}
                  </button>
                  <button
                    className="export-primary"
                    disabled={!canExport}
                    onClick={() => void onExport()}
                  >
                    {t("export_dialog.export")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
