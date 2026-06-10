import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { documentDir, join } from "@tauri-apps/api/path";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { exportSettingsGet, exportSettingsSet, workspaceDir } from "../ipc";
import { AppDialog } from "../components/AppDialog";
import { AppSelect } from "../components/AppSelect";
import { Button } from "@/components/ui/button";
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
    <AppDialog
      title={t("export_dialog.title")}
      onClose={onCancel}
      closeLabel={t("export_dialog.cancel")}
      panelClassName="settings-panel"
    >
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
                    <Button onClick={() => void onBrowse()}>
                      {t("export_dialog.browse")}
                    </Button>
                  </span>
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.resolution")}
                  </span>
                  <AppSelect
                    className="export-select"
                    value={String(settings.resolutionHeight ?? "")}
                    onValueChange={(v) =>
                      patch({ resolutionHeight: v ? Number(v) : null })
                    }
                    options={[
                      {
                        value: "",
                        label: `${t("export_dialog.follow_comp")} (${comp.width}×${comp.height})`,
                      },
                      ...downscaleHeightOptions(comp.height).map((h) => ({
                        value: String(h),
                        label: `${h}p`,
                      })),
                    ]}
                  />
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.fps")}
                  </span>
                  <AppSelect
                    className="export-select"
                    value={String(settings.fps ?? "")}
                    onValueChange={(v) => patch({ fps: v ? Number(v) : null })}
                    options={[
                      {
                        value: "",
                        label: `${t("export_dialog.follow_comp")} (${compFps.toFixed(2)})`,
                      },
                      ...downscaleFpsOptions(compFps).map((f) => ({
                        value: String(f),
                        label: `${f} fps`,
                      })),
                    ]}
                  />
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.range")}
                  </span>
                  <AppSelect
                    className="export-select"
                    value={rangeMode}
                    onValueChange={(v) => setRangeMode(v as "full" | "custom")}
                    options={[
                      { value: "full", label: t("export_dialog.range_full") },
                      { value: "custom", label: t("export_dialog.range_custom") },
                    ]}
                  />
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
                  <AppSelect
                    className="export-select"
                    value={settings.codec}
                    onValueChange={(v) => {
                      const codec = v as CodecId;
                      if (!isCodecContainerValid(codec, settings.container)) {
                        // Falls back to MP4 → Opus (MKV-only) must also reset.
                        const audio = { ...settings.audio, codec: "aac" as AudioCodecId };
                        patch({ codec, container: "mp4", audio });
                      } else {
                        patch({ codec });
                      }
                    }}
                    options={[
                      { value: "h264", label: "H.264" },
                      { value: "av1", label: "AV1" },
                      { value: "hevc", label: "HEVC" },
                    ]}
                  />
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
                  <AppSelect
                    className="export-select"
                    value={settings.container}
                    onValueChange={(v) => {
                      const container = v as Container;
                      const audio = isAudioCodecContainerValid(
                        settings.audio.codec,
                        container,
                      )
                        ? settings.audio
                        : { ...settings.audio, codec: "aac" as AudioCodecId };
                      patch({ container, audio });
                    }}
                    options={containersForCodec(settings.codec).map((c) => ({
                      value: c,
                      label: c.toUpperCase(),
                    }))}
                  />
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.quality")}
                  </span>
                  <AppSelect
                    className="export-select"
                    value={settings.quality}
                    onValueChange={(v) =>
                      patch({ quality: v as QualityPreset })
                    }
                    options={[
                      { value: "low", label: t("export_dialog.quality_low") },
                      { value: "medium", label: t("export_dialog.quality_medium") },
                      { value: "high", label: t("export_dialog.quality_high") },
                      { value: "custom", label: t("export_dialog.quality_custom") },
                    ]}
                  />
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
                  <AppSelect
                    className="export-select"
                    value={settings.rateMode}
                    onValueChange={(v) => patch({ rateMode: v as RateMode })}
                    options={[
                      { value: "vbr", label: "VBR" },
                      { value: "cbr", label: "CBR" },
                    ]}
                  />
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.keyframe_interval")}
                  </span>
                  <AppSelect
                    className="export-select"
                    value={String(settings.keyframeIntervalSec)}
                    onValueChange={(v) =>
                      patch({ keyframeIntervalSec: Number(v) })
                    }
                    options={KEYFRAME_INTERVALS.map((s) => ({
                      value: String(s),
                      label: `${s}s`,
                    }))}
                  />
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.encoder_accel")}
                  </span>
                  <AppSelect
                    className="export-select"
                    value={settings.hwAccel}
                    onValueChange={(v) =>
                      patch({ hwAccel: v as "auto" | "software" })
                    }
                    options={[
                      { value: "auto", label: t("export_dialog.encoder_auto") },
                      {
                        value: "software",
                        label: t("export_dialog.encoder_software"),
                      },
                    ]}
                  />
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
                      <AppSelect
                        className="export-select"
                        value={settings.audio.codec}
                        onValueChange={(v) =>
                          patch({
                            audio: { ...settings.audio, codec: v as AudioCodecId },
                          })
                        }
                        options={audioCodecsForContainer(settings.container).map(
                          (c) => ({ value: c, label: c.toUpperCase() }),
                        )}
                      />
                    </div>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.audio_bitrate")}
                      </span>
                      <AppSelect
                        className="export-select"
                        value={String(settings.audio.bitrate)}
                        onValueChange={(v) =>
                          patch({
                            audio: { ...settings.audio, bitrate: Number(v) },
                          })
                        }
                        options={AUDIO_BITRATES.map((b) => ({
                          value: String(b),
                          label: `${b / 1000} kbps`,
                        }))}
                      />
                    </div>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.audio_channels")}
                      </span>
                      <AppSelect
                        className="export-select"
                        value={String(settings.audio.channels ?? "")}
                        onValueChange={(v) =>
                          patch({
                            audio: {
                              ...settings.audio,
                              channels: v ? Number(v) : null,
                            },
                          })
                        }
                        options={[
                          { value: "", label: t("export_dialog.follow_comp") },
                          ...AUDIO_CHANNELS.map((c) => ({
                            value: String(c),
                            label:
                              c === 1
                                ? t("export_dialog.channels_mono")
                                : t("export_dialog.channels_stereo"),
                          })),
                        ]}
                      />
                    </div>
                    <div className="export-row">
                      <span className="settings-toggle-label">
                        {t("export_dialog.audio_sample_rate")}
                      </span>
                      <AppSelect
                        className="export-select"
                        value={String(settings.audio.sampleRate ?? "")}
                        onValueChange={(v) =>
                          patch({
                            audio: {
                              ...settings.audio,
                              sampleRate: v ? Number(v) : null,
                            },
                          })
                        }
                        options={[
                          { value: "", label: t("export_dialog.follow_comp") },
                          ...AUDIO_SAMPLE_RATES.map((r) => ({
                            value: String(r),
                            label: `${(r / 1000).toFixed(1)} kHz`,
                          })),
                        ]}
                      />
                    </div>
                  </>
                )}

                <div className="export-actions">
                  <Button size="lg" onClick={onCancel}>
                    {t("export_dialog.cancel")}
                  </Button>
                  <Button
                    variant="default"
                    size="lg"
                    disabled={!canExport}
                    onClick={() => void onExport()}
                  >
                    {t("export_dialog.export")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
    </AppDialog>
  );
}
