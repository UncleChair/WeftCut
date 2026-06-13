import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { documentDir, join } from "@tauri-apps/api/path";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { exportSettingsGet, exportSettingsSet, workspaceDir } from "../ipc";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";
import { AppSelect } from "../components/AppSelect";
import { AppSwitch } from "../components/AppSwitch";
import { AppTimecodeField } from "../components/AppTimecodeField";
import { Button } from "@/components/ui/button";
import {
  type EncodePath,
  resolveEncodePath,
} from "../render/exportCodecProbe";
import {
  type BitDepth,
  type CodecId,
  type Container,
  type ExportSettings,
  type QualityPreset,
  type RateMode,
  containerExtension,
  containersForCodec,
  isBitDepthValid,
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
  /// True when the project has at least one 10-bit-capable video source
  /// (H.264 Hi10P or AV1 10-bit — `tenBitExportCapable`). Used to show the
  /// 10-bit hint and smart-default the bit-depth selector to 10 when the
  /// user picks HEVC or AV1 for the first time this dialog session.
  hasTenBitSource: boolean;
  onCancel: () => void;
  onConfirm: (
    settings: ExportSettings,
    path: string,
    range: { startUs: number; endUs: number },
  ) => void;
}

export function ExportSettingsDialog({ comp, currentTimeUs, durationUs, hasTenBitSource, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [location, setLocation] = useState<string>("");
  const [filename, setFilename] = useState<string>("weftcut-export");
  const [encodePath, setEncodePath] = useState<EncodePath | null>(null);
  const [rangeMode, setRangeMode] = useState<"full" | "custom">("full");
  const [rangeStartUs, setRangeStartUs] = useState<number>(0);
  const [rangeEndUs, setRangeEndUs] = useState<number>(durationUs);
  /// True while the experimental-10-bit confirmation gate is showing. Set when
  /// the user clicks Export with bitDepth === 10; cleared on cancel. The actual
  /// export only fires from the gate's "export anyway" button.
  const [confirmExperimental, setConfirmExperimental] = useState(false);
  /// Latches once an export actually launches so a double-click on Export /
  /// "Export anyway" can't fire two concurrent runs — two 10-bit exports would
  /// race to open the single native sink and the loser errors "video sink
  /// already active". The dialog unmounts once the export starts, so this never
  /// needs resetting except when launch itself throws before starting.
  const submittingRef = useRef(false);
  /// True once the user has explicitly touched the bit-depth selector this
  /// dialog session. Suppresses the smart-default (auto-10 on 10-bit-capable
  /// codec change) after the first explicit choice.
  const userTouchedBitDepth = useRef(false);
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
        if (!cancelled) {
          userTouchedBitDepth.current = saved?.bitDepth != null;
          setSettings(mergeSettings(saved));
        }
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

  async function doExport() {
    if (!settings || !location || !filename.trim()) return;
    if (submittingRef.current) return; // guard against double-fire
    submittingRef.current = true;
    try {
      const ext = containerExtension(settings.container);
      const out = await join(location, `${filename.trim()}.${ext}`);
      await exportSettingsSet(settings).catch(() => {});
      const range =
        rangeMode === "full"
          ? { startUs: 0, endUs: durationUs }
          : clampExportRange(rangeStartUs, rangeEndUs, durationUs);
      onConfirm(settings, out, range);
    } catch {
      // Launch never reached onConfirm (e.g. path join failed) — unlatch so
      // the user can retry rather than being stuck on a dead dialog.
      submittingRef.current = false;
    }
  }

  function onExport() {
    if (!settings || !location || !filename.trim()) return;
    // 10-bit export is experimental — gate it behind an explicit confirmation
    // (the on-screen preview can't be guaranteed to match the 10-bit output;
    // see the inline warning). 8-bit export proceeds directly.
    if (settings.bitDepth === 10) {
      setConfirmExperimental(true);
      return;
    }
    void doExport();
  }

  const canExport =
    !!location &&
    filename.trim().length > 0 &&
    encodePath !== null &&
    (rangeMode === "full" || rangeStartUs < rangeEndUs);

  return (
    <>
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
                    <AppInput
                      value={filename}
                      onValueChange={setFilename}
                      mono
                      spellCheck={false}
                      className="export-filename-input"
                      ariaLabel={t("export_dialog.filename")}
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
                    <AppInput
                      value={location}
                      onValueChange={() => {}}
                      readOnly
                      mono
                      title={location}
                      className="export-path-input"
                      ariaLabel={t("export_dialog.location")}
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
                        <AppTimecodeField
                          valueUs={rangeStartUs}
                          fpsNum={comp.fps_num}
                          fpsDen={comp.fps_den}
                          ariaLabel={t("export_dialog.range_in")}
                          onCommit={setRangeStartUs}
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
                        <AppTimecodeField
                          valueUs={rangeEndUs}
                          fpsNum={comp.fps_num}
                          fpsDen={comp.fps_den}
                          ariaLabel={t("export_dialog.range_out")}
                          onCommit={setRangeEndUs}
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
                      // Snap bitDepth: H.264 cannot produce Hi10P output.
                      const bitDepth: BitDepth =
                        codec === "h264"
                          ? 8
                          : !userTouchedBitDepth.current && hasTenBitSource
                            ? 10
                            : settings.bitDepth;
                      if (!isCodecContainerValid(codec, settings.container)) {
                        // Falls back to MP4 → Opus (MKV-only) must also reset.
                        const audio = { ...settings.audio, codec: "aac" as AudioCodecId };
                        patch({ codec, container: "mp4", audio, bitDepth });
                      } else {
                        patch({ codec, bitDepth });
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
                    {t("export_dialog.bit_depth")}
                  </span>
                  <AppSelect
                    className="export-select"
                    value={String(settings.bitDepth)}
                    onValueChange={(v) => {
                      userTouchedBitDepth.current = true;
                      patch({ bitDepth: Number(v) as BitDepth });
                    }}
                    options={[
                      { value: "8", label: t("export_dialog.bit_depth_8") },
                      {
                        value: "10",
                        label: t("export_dialog.bit_depth_10"),
                        disabled: !isBitDepthValid(settings.codec, 10),
                      },
                    ]}
                  />
                </div>
                {hasTenBitSource && settings.bitDepth === 8 && (
                  <p className="settings-blurb">
                    {t("export_dialog.bit_depth_hint")}
                  </p>
                )}
                {settings.bitDepth === 10 && (
                  <p className="settings-warn">
                    {t("export_dialog.bit_depth_experimental_warning")}
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
                      <AppNumberField
                        value={settings.customBitrate ? settings.customBitrate / 1_000_000 : null}
                        min={1}
                        step={1}
                        align="center"
                        className="settings-input-narrow"
                        ariaLabel={t("export_dialog.custom_bitrate")}
                        onValueChange={(v) => patch({ customBitrate: Math.round(v * 1_000_000) })}
                        onClear={() => patch({ customBitrate: null })}
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
                  <AppSwitch
                    checked={settings.audio.include}
                    ariaLabel={t("export_dialog.audio_include")}
                    onCheckedChange={(next) =>
                      patch({ audio: { ...settings.audio, include: next } })
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
    {confirmExperimental && (
      <AppDialog
        title={t("export_dialog.experimental_title")}
        onClose={() => setConfirmExperimental(false)}
        closeLabel={t("export_dialog.cancel")}
        panelClassName="settings-panel export-experimental-confirm"
      >
        <div className="settings-body">
          <div className="settings-card">
            <p className="settings-blurb">
              {t("export_dialog.experimental_body")}
            </p>
            <ul className="export-experimental-points">
              <li>{t("export_dialog.experimental_point_preview")}</li>
              <li>{t("export_dialog.experimental_point_slow")}</li>
              <li>{t("export_dialog.experimental_point_reliability")}</li>
            </ul>
            <div className="export-actions">
              <Button size="lg" onClick={() => setConfirmExperimental(false)}>
                {t("export_dialog.cancel")}
              </Button>
              <Button
                variant="default"
                size="lg"
                onClick={() => void doExport()}
              >
                {t("export_dialog.experimental_proceed")}
              </Button>
            </div>
          </div>
        </div>
      </AppDialog>
    )}
    </>
  );
}
