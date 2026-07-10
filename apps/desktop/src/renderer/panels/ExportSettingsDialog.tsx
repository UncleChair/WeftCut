import { open as openDialog } from "@/bridge/dialog";
import { documentDir, join } from "@/bridge/path";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { exportSettingsGet, exportSettingsSet, workspaceDir } from "../ipc";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";
import { AppCheckbox } from "../components/AppCheckbox";
import { AppSelect } from "../components/AppSelect";
import { AppTimecodeField } from "../components/AppTimecodeField";
import { Button } from "@/components/ui/button";
import { smokeEncode } from "../render/exportCodecProbe";
import {
  type BitDepth,
  type CodecId,
  type Container,
  type DnxhrProfile,
  type EncoderEngine,
  type ExportSettings,
  type ProresProfile,
  type QualityPreset,
  type RateMode,
  type SpeedPreset,
  containersForCodec,
  defaultCrf,
  exportIncludesVideo,
  exportIncludesAudio,
  exportOutputExtension,
  isBitDepthValid,
  isCodecContainerValid,
  isIntermediateCodec,
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

type ExportCategory = "general" | "video" | "audio" | "subtitle";

/// Sidebar order for the export dialog. Every pane stays mounted
/// (toggled via `hidden`) so in-progress edits survive a tab switch.
const EXPORT_CATEGORIES: ReadonlyArray<{ id: ExportCategory; labelKey: string }> = [
  { id: "general", labelKey: "export_dialog.cat_general" },
  { id: "video", labelKey: "export_dialog.cat_video" },
  { id: "audio", labelKey: "export_dialog.cat_audio" },
  { id: "subtitle", labelKey: "export_dialog.cat_subtitle" },
];

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
  /// True once a one-frame WebCodecs smoke-encode confirms the current
  /// codec/dims/fps combo actually encodes; false if it fails; null while
  /// checking. Purely informational (which branch encodes is decided by
  /// resolveEncodeTarget, not by this probe) — it gates the Export button
  /// against a mid-check state and drives the blurb text below.
  const [webcodecsOk, setWebcodecsOk] = useState<boolean | null>(null);
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
  const [category, setCategory] = useState<ExportCategory>("general");
  const tabRefs = useRef<
    Partial<Record<ExportCategory, HTMLButtonElement | null>>
  >({});

  /// Roving-tabindex keyboard nav for the vertical tablist (WAI-ARIA
  /// tabs pattern): arrows move + activate, Home/End jump to the ends.
  const onNavKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const order = EXPORT_CATEGORIES.map((c) => c.id);
    const idx = order.indexOf(category);
    let next: ExportCategory | undefined;
    if (e.key === "ArrowDown") next = order[(idx + 1) % order.length];
    else if (e.key === "ArrowUp")
      next = order[(idx - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    if (next) {
      e.preventDefault();
      setCategory(next);
      tabRefs.current[next]?.focus();
    }
  };

  /// A category whose stream the current `content` excludes is shown dimmed in
  /// the nav (Video when audio-only, Audio when video-only).
  const tabExcluded = (id: ExportCategory): boolean => {
    if (!settings) return false;
    if (id === "video") return !settings.includeVideo;
    if (id === "audio") return !settings.includeAudio;
    return false;
  };
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

  // Smoke-test whether WebCodecs can actually encode the current codec /
  // output dims / fps combo, so the dialog can show a support badge. Purely
  // informational — no fallback exists on the encode path itself; see
  // `webcodecsOk`'s doc comment. Depends only on codec + output dims + fps —
  // not quality/container/rate.
  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    setWebcodecsOk(null);
    // Intermediates (ProRes/DNxHR) are native-only — never probed via
    // WebCodecs. Placeholder gate value only; real intermediate UI (profile
    // pickers, no path badge at all) lands in Task 13.
    if (isIntermediateCodec(settings.codec)) {
      setWebcodecsOk(true);
      return;
    }
    const d = resolveOutputDims(comp, settings);
    const fps = settings.fps != null ? settings.fps : compFps;
    void smokeEncode(settings.codec, d.width, d.height, fps).then((ok) => {
      if (!cancelled) setWebcodecsOk(ok);
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
      const ext = exportOutputExtension(settings);
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
    // see the inline warning). 8-bit export proceeds directly. Audio-only has
    // no video, so the bit-depth gate doesn't apply.
    if (exportIncludesVideo(settings) && settings.bitDepth === 10) {
      setConfirmExperimental(true);
      return;
    }
    void doExport();
  }

  const canExport =
    !!location &&
    filename.trim().length > 0 &&
    // Need at least one stream; video (if included) needs its WebCodecs probe.
    !!(settings?.includeVideo || settings?.includeAudio) &&
    (!settings?.includeVideo || webcodecsOk !== null) &&
    (rangeMode === "full" || rangeStartUs < rangeEndUs);

  return (
    <>
    <AppDialog
      title={t("export_dialog.title")}
      onClose={onCancel}
      closeLabel={t("export_dialog.cancel")}
      panelClassName="settings-panel settings-panel--nav"
    >
      <div className="settings-layout">
        <div
          className="settings-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label={t("export_dialog.title")}
          onKeyDown={onNavKeyDown}
        >
          {EXPORT_CATEGORIES.map((c) => (
            <button
              key={c.id}
              ref={(el) => {
                tabRefs.current[c.id] = el;
              }}
              type="button"
              role="tab"
              id={`export-tab-${c.id}`}
              aria-selected={category === c.id}
              aria-controls={`export-panel-${c.id}`}
              tabIndex={category === c.id ? 0 : -1}
              className={[
                "settings-nav-item",
                category === c.id ? "is-active" : "",
                tabExcluded(c.id) ? "is-dim" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => setCategory(c.id)}
            >
              {t(c.labelKey)}
            </button>
          ))}
        </div>

        <div className="settings-content">
          {!settings ? (
            <p className="settings-blurb">…</p>
          ) : (
            <>
              <div
                role="tabpanel"
                id="export-panel-general"
                aria-labelledby="export-tab-general"
                hidden={category !== "general"}
                className="settings-pane"
              >
                <div className="settings-pane-title">
                  {t("export_dialog.cat_general")}
                </div>

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
                      .{exportOutputExtension(settings)}
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

                {settings.includeVideo && (
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
                )}

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
                    {t("export_dialog.content")}
                  </span>
                  <span className="export-content-checks">
                    <label className="export-check">
                      <AppCheckbox
                        checked={settings.includeVideo}
                        ariaLabel={t("export_dialog.include_video")}
                        onCheckedChange={(next) =>
                          patch({ includeVideo: next })
                        }
                      />
                      <span>{t("export_dialog.include_video")}</span>
                    </label>
                    <label className="export-check">
                      <AppCheckbox
                        checked={settings.includeAudio}
                        ariaLabel={t("export_dialog.include_audio")}
                        onCheckedChange={(next) =>
                          patch({
                            includeAudio: next,
                            audio: { ...settings.audio, include: next },
                          })
                        }
                      />
                      <span>{t("export_dialog.include_audio")}</span>
                    </label>
                  </span>
                </div>
                {!settings.includeVideo && !settings.includeAudio && (
                  <p className="settings-blurb">
                    {t("export_dialog.content_none")}
                  </p>
                )}
              </div>

              <div
                role="tabpanel"
                id="export-panel-video"
                aria-labelledby="export-tab-video"
                hidden={category !== "video"}
                className="settings-pane"
              >
                <div className="settings-pane-title">
                  {t("export_dialog.cat_video")}
                </div>

                {!exportIncludesVideo(settings) ? (
                  <p className="settings-blurb">
                    {t("export_dialog.video_excluded")}
                  </p>
                ) : (
                  <>
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
                    {t("export_dialog.encoder_engine")}
                  </span>
                  <AppSelect
                    className="export-select"
                    value={settings.encoderEngine}
                    onValueChange={(v) => {
                      const engine = v as EncoderEngine;
                      // Snap rateMode: quality (CRF) is native-only — pinning
                      // WebCodecs while holding it would leave the dialog on a
                      // combo the export silently ignores.
                      patch({
                        encoderEngine: engine,
                        ...(engine === "webcodecs" && settings.rateMode === "quality"
                          ? { rateMode: "vbr" as RateMode }
                          : {}),
                      });
                    }}
                    options={[
                      { value: "auto", label: t("export_dialog.engine_auto") },
                      { value: "native", label: t("export_dialog.engine_native") },
                      {
                        value: "webcodecs",
                        label: t("export_dialog.engine_webcodecs"),
                        disabled: isIntermediateCodec(settings.codec) || settings.bitDepth === 10,
                      },
                    ]}
                  />
                </div>

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.codec")}
                  </span>
                  <AppSelect
                    className="export-select"
                    value={settings.codec}
                    onValueChange={(v) => {
                      const codec = v as CodecId;
                      // Snap bitDepth: intermediates imply depth by profile
                      // (ProRes=10, DNxHR=8); H.264 cannot produce Hi10P
                      // output; other delivery codecs keep the existing
                      // smart-default (auto-10 on a 10-bit-capable source,
                      // once, until the user touches the selector).
                      const bitDepth: BitDepth = isIntermediateCodec(codec)
                        ? codec === "prores"
                          ? 10
                          : 8
                        : codec === "h264"
                          ? 8
                          : !userTouchedBitDepth.current && hasTenBitSource
                            ? 10
                            : settings.bitDepth;
                      const container: Container = isIntermediateCodec(codec)
                        ? "mov"
                        : !isCodecContainerValid(codec, settings.container)
                          ? containersForCodec(codec)[0]!
                          : settings.container;
                      // Falls back to MP4/MOV → Opus (MKV-only) must also reset.
                      const audio =
                        container !== settings.container &&
                        !isAudioCodecContainerValid(settings.audio.codec, container)
                          ? { ...settings.audio, codec: "aac" as AudioCodecId }
                          : settings.audio;
                      patch({
                        codec,
                        bitDepth,
                        container,
                        audio,
                        ...(isIntermediateCodec(codec)
                          ? { rateMode: "vbr" as RateMode }
                          : {}),
                      });
                    }}
                    options={[
                      { value: "h264", label: "H.264" },
                      { value: "av1", label: "AV1" },
                      { value: "hevc", label: "HEVC" },
                      {
                        value: "prores",
                        label: "ProRes 422",
                        disabled: settings.encoderEngine === "webcodecs",
                      },
                      {
                        value: "dnxhr",
                        label: "DNxHR",
                        disabled: settings.encoderEngine === "webcodecs",
                      },
                    ]}
                  />
                </div>
                {settings.codec === "prores" && (
                  <div className="export-row">
                    <span className="settings-toggle-label">{t("export_dialog.prores_profile")}</span>
                    <AppSelect className="export-select" value={settings.proresProfile}
                      onValueChange={(v) => patch({ proresProfile: v as ProresProfile })}
                      options={[
                        { value: "proxy", label: "Proxy" }, { value: "lt", label: "LT" },
                        { value: "422", label: "422" }, { value: "hq", label: "422 HQ" },
                      ]} />
                  </div>
                )}
                {settings.codec === "dnxhr" && (
                  <div className="export-row">
                    <span className="settings-toggle-label">{t("export_dialog.dnxhr_profile")}</span>
                    <AppSelect className="export-select" value={settings.dnxhrProfile}
                      onValueChange={(v) => patch({ dnxhrProfile: v as DnxhrProfile })}
                      options={[
                        { value: "lb", label: "LB" }, { value: "sq", label: "SQ" }, { value: "hq", label: "HQ" },
                      ]} />
                  </div>
                )}
                <p className="settings-blurb">
                  {settings.encoderEngine === "native" || isIntermediateCodec(settings.codec) || settings.bitDepth === 10
                    ? t("export_dialog.path_native")
                    : webcodecsOk === null
                      ? t("export_dialog.checking_codec")
                      : t("export_dialog.path_webcodecs")}
                </p>

                {!isIntermediateCodec(settings.codec) && (
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
                )}
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

                {!isIntermediateCodec(settings.codec) && (
                  <>
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
                      {
                        value: "quality", label: t("export_dialog.rate_quality"),
                        disabled: settings.encoderEngine === "webcodecs" || isIntermediateCodec(settings.codec),
                      },
                    ]}
                  />
                </div>
                {settings.rateMode === "quality" && !isIntermediateCodec(settings.codec) && (
                  <div className="export-row">
                    <span className="settings-toggle-label">{t("export_dialog.crf")}</span>
                    <AppNumberField
                      value={settings.crf ?? defaultCrf(settings.codec)}
                      min={0} max={51} step={1} align="center"
                      className="settings-input-narrow"
                      ariaLabel={t("export_dialog.crf")}
                      onValueChange={(v) => patch({ crf: Math.round(v) })}
                      onClear={() => patch({ crf: null })}
                    />
                  </div>
                )}

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
                  </>
                )}
                {!isIntermediateCodec(settings.codec) && (
                  <div className="export-row">
                    <span className="settings-toggle-label">{t("export_dialog.speed_preset")}</span>
                    <AppSelect className="export-select" value={settings.preset}
                      onValueChange={(v) => patch({ preset: v as SpeedPreset })}
                      options={[
                        { value: "fast", label: t("export_dialog.preset_fast") },
                        { value: "medium", label: t("export_dialog.preset_medium") },
                        { value: "slow", label: t("export_dialog.preset_slow") },
                      ]} />
                  </div>
                )}
                  </>
                )}
              </div>

              <div
                role="tabpanel"
                id="export-panel-audio"
                aria-labelledby="export-tab-audio"
                hidden={category !== "audio"}
                className="settings-pane"
              >
                <div className="settings-pane-title">
                  {t("export_dialog.cat_audio")}
                </div>

                {!exportIncludesAudio(settings) ? (
                  <p className="settings-blurb">
                    {t("export_dialog.audio_excluded")}
                  </p>
                ) : (
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
              </div>

              <div
                role="tabpanel"
                id="export-panel-subtitle"
                aria-labelledby="export-tab-subtitle"
                hidden={category !== "subtitle"}
                className="settings-pane"
              >
                <div className="settings-pane-title">
                  {t("export_dialog.cat_subtitle")}
                </div>
                <p className="settings-blurb">
                  {t("export_dialog.subtitle_placeholder")}
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="export-footer">
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
