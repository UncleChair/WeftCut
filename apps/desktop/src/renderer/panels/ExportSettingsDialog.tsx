import { open as openDialog } from "@/bridge/dialog";
import { documentDir, join } from "@/bridge/path";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { exportSettingsGet, exportSettingsSet, workspaceDir, type MediaSummary } from "../ipc";
import { formatTimecode } from "../frames";
import {
  resolveMarkedRange,
  useRangeInUs,
  useRangeOutUs,
} from "../state/rangeStore";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppNumberField } from "../components/AppNumberField";
import { AppCheckbox } from "../components/AppCheckbox";
import { AppSelect } from "../components/AppSelect";
import { AppTimecodeField } from "../components/AppTimecodeField";
import { Button } from "@/components/ui/button";
import { smokeEncode } from "../render/exportCodecProbe";
import {
  resolveExportDecodeRouting,
  routingSourceCounts,
} from "../render/exportDecodeRouting";
import { referencedVideoMediaIds } from "../render/activeVideoLayers";
import { useProjectStore } from "../state/projectStore";
import {
  useDecodeComponentAvailable,
  useDecodeComponentReason,
} from "../settings/decodeComponentStore";
import { decodeEngineOptions } from "../settings/decodeEngineOptions";
import {
  type BitDepth,
  type CodecId,
  type Container,
  type DnxhrProfile,
  type EncoderEngine,
  type ExportDecodeEngine,
  type ExportSettings,
  type ProresProfile,
  type QualityPreset,
  type RateMode,
  type SpeedPreset,
  bitrateConstraintIssue,
  bufferSizeApplies,
  compositeBitDepth,
  computeBitrate,
  containersForCodec,
  defaultCrf,
  isBitrateRateMode,
  maxBitrateApplies,
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

/// Where the exported span comes from. `marked` reads the timeline's in/out
/// points (`rangeStore.ts`) and is the default whenever they exist — picking a
/// range belongs on the timeline, where the playhead and the clips are visible;
/// this dialog only confirms the choice. `custom` remains for typing an exact
/// timecode without leaving the dialog.
type RangeMode = "full" | "marked" | "custom";

interface Props {
  comp: Comp;
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

export function ExportSettingsDialog({ comp, durationUs, hasTenBitSource, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  // Read from the store rather than taken as a prop: the dialog is modal, so
  // nothing can move the marks while it is open, and a prop would have to be
  // threaded through App purely to be snapshotted at the same instant.
  const markedInUs = useRangeInUs();
  const markedOutUs = useRangeOutUs();
  const markedRange = resolveMarkedRange(markedInUs, markedOutUs, durationUs);
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [location, setLocation] = useState<string>("");
  const [filename, setFilename] = useState<string>("weftcut-export");
  /// True once a one-frame WebCodecs smoke-encode confirms the current
  /// codec/dims/fps combo actually encodes; false if it fails; null while
  /// checking. Purely informational (which branch encodes is decided by
  /// resolveEncodeTarget, not by this probe) — it gates the Export button
  /// against a mid-check state and drives the blurb text below.
  const [webcodecsOk, setWebcodecsOk] = useState<boolean | null>(null);
  // Marked in/out wins the default when it exists: the user already made that
  // choice on the timeline, and silently ignoring it here would be the same
  // class of surprise as exporting a range nobody picked.
  const [rangeMode, setRangeMode] = useState<RangeMode>(() =>
    markedRange ? "marked" : "full",
  );
  // Custom seeds from the marked range so switching to it is a starting point
  // to nudge, not a blank form. Initialiser-only — later marks can't reach in
  // and overwrite what the user is typing.
  const [rangeStartUs, setRangeStartUs] = useState<number>(
    () => markedRange?.startUs ?? 0,
  );
  const [rangeEndUs, setRangeEndUs] = useState<number>(
    () => markedRange?.endUs ?? durationUs,
  );
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
    // Only an explicit WebCodecs pin ever consults this result
    // (resolveEncodeTarget ignores it for auto/native, which always resolve
    // native) — skip the round trip entirely rather than dead-waiting on
    // smokeEncode's up-to-4s deadline for a result nothing reads.
    if (settings.encoderEngine !== "webcodecs") return;
    // Intermediates (ProRes/DNxHR) are native-only — never probed via WebCodecs.
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
  }, [settings?.encoderEngine, settings?.codec, settings?.fps, settings?.resolutionHeight, comp, compFps]);

  const patch = (p: Partial<ExportSettings>) =>
    setSettings((s) => (s ? { ...s, ...p } : s));

  const decodeComponentAvailable = useDecodeComponentAvailable();
  const decodeComponentReason = useDecodeComponentReason();
  const projSummary = useProjectStore((s) => s.summary);
  const mediaById = useProjectStore((s) => s.mediaById);
  /// The one range the export runs over — shared by doExport, the Export
  /// button's own enablement, and every readout below, so none of them can
  /// disagree with the run. Null when the current inputs resolve to no usable
  /// span; nothing substitutes a fallback range on the way to the encoder.
  const chosenRange = useMemo(
    (): { startUs: number; endUs: number } | null =>
      rangeMode === "full"
        ? durationUs > 0
          ? { startUs: 0, endUs: durationUs }
          : null
        : rangeMode === "marked"
          ? markedRange
          : clampExportRange(rangeStartUs, rangeEndUs, durationUs),
    [rangeMode, markedRange, rangeStartUs, rangeEndUs, durationUs],
  );
  /// The decode-routing honesty line: same resolver, same inputs as the run
  /// (see routingSourceCounts). Recomputed on range/engine/depth edits, not
  /// just at dialog open, so it stays truthful while the user works.
  const decodeCounts = useMemo(() => {
    if (!settings || !projSummary || !exportIncludesVideo(settings)) return null;
    if (!chosenRange) return null;
    const media = [
      ...referencedVideoMediaIds(projSummary, chosenRange.startUs, chosenRange.endUs),
    ]
      .map((id) => mediaById.get(id))
      .filter((m): m is MediaSummary => !!m);
    const routing = resolveExportDecodeRouting({
      setting: settings.decodeEngine,
      componentAvailable: decodeComponentAvailable,
      bitDepth: compositeBitDepth(settings),
      media,
    });
    return routingSourceCounts(media, routing);
  }, [settings, projSummary, mediaById, chosenRange, decodeComponentAvailable]);

  /// The target bitrate this export would actually run at — the quality
  /// preset's bpp heuristic, or the user's custom override. Recomputed from the
  /// SAME resolver the run uses (computeBitrate over the resolved output dims +
  /// fps), so the number on screen under a preset is the number ffmpeg gets,
  /// not an independent restatement. Zero before settings load.
  const outFps = settings?.fps != null ? settings.fps : compFps;
  const effectiveBitrate = useMemo(() => {
    if (!settings) return 0;
    const d = resolveOutputDims(comp, settings);
    return computeBitrate(settings, d.width, d.height, outFps);
  }, [settings, comp, outFps]);
  /// Non-null when the peak/target pair can't be encoded as typed. Mirrors the
  /// Rust seam's rejection so the dialog explains it here instead of failing at
  /// ffmpeg launch, and gates the Export button below.
  const bitrateIssue = settings
    ? bitrateConstraintIssue(settings, effectiveBitrate)
    : null;

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
    // Unreachable through the UI (`canExport` gates on the same value), but
    // this is the one place a bad range would reach the encoder, so it refuses
    // rather than substituting one.
    if (!chosenRange) return;
    if (submittingRef.current) return; // guard against double-fire
    submittingRef.current = true;
    try {
      const ext = exportOutputExtension(settings);
      const out = await join(location, `${filename.trim()}.${ext}`);
      await exportSettingsSet(settings).catch(() => {});
      onConfirm(settings, out, chosenRange);
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
    // no video, so the bit-depth gate doesn't apply. Intermediates are
    // excluded: ProRes's bitDepth is always 10 as its STANDARD format (not
    // the experimental delivery-codec 10-bit lane), and DNxHR is always 8.
    if (
      exportIncludesVideo(settings) &&
      !isIntermediateCodec(settings.codec) &&
      settings.bitDepth === 10
    ) {
      setConfirmExperimental(true);
      return;
    }
    void doExport();
  }

  const canExport =
    !!location &&
    filename.trim().length > 0 &&
    // Need at least one stream; video (if included) needs its WebCodecs probe
    // to have settled — but only under an explicit WebCodecs pin (auto/native
    // never consult the probe, so it never gates them).
    !!(settings?.includeVideo || settings?.includeAudio) &&
    (!settings?.includeVideo ||
      settings?.encoderEngine !== "webcodecs" ||
      webcodecsOk === true) &&
    // The SAME value the run uses, not a re-derived `start < end`: the two
    // disagreed on a range typed past the end of the project, which is how a
    // rejected range used to slip through as a whole-project export.
    chosenRange !== null &&
    // A peak under the target is rejected at the encoder seam, so stop here
    // rather than after the motif bake and a spawned ffmpeg.
    bitrateIssue === null;

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
                      ariaLabel={t("export_dialog.container")}
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
                    ariaLabel={t("export_dialog.range")}
                    value={rangeMode}
                    onValueChange={(v) => setRangeMode(v as RangeMode)}
                    options={[
                      { value: "full", label: t("export_dialog.range_full") },
                      {
                        value: "marked",
                        label: t("export_dialog.range_marked"),
                        // Nothing to export from an unmarked timeline, and a
                        // selectable option that resolves to nothing would just
                        // dead-end on a disabled Export button.
                        disabled: markedRange === null,
                      },
                      { value: "custom", label: t("export_dialog.range_custom") },
                    ]}
                  />
                </div>
                {rangeMode === "marked" && markedRange && (
                  // Read-only: marks are edited on the timeline, where the
                  // playhead and the clips are visible.
                  <div className="export-row">
                    <span className="settings-toggle-label">
                      {t("export_dialog.range_marked")}
                    </span>
                    <span className="settings-toggle-hint">
                      {formatTimecode(markedRange.startUs, comp.fps_num, comp.fps_den)}
                      {" → "}
                      {formatTimecode(markedRange.endUs, comp.fps_num, comp.fps_den)}
                    </span>
                  </div>
                )}
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
                      </span>
                    </div>
                  </>
                )}

                {/* Only an unresolvable range gets a row: it is the sole
                    explanation for a disabled Export button. */}
                {chosenRange === null && (
                  <p className="settings-warn">
                    {rangeMode === "marked"
                      ? t("export_dialog.range_marked_none")
                      : t("export_dialog.range_invalid")}
                  </p>
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
                    ariaLabel={t("export_dialog.resolution")}
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
                    ariaLabel={t("export_dialog.fps")}
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
                    ariaLabel={t("export_dialog.encoder_engine")}
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
                    {t("export_dialog.decode_engine")}
                  </span>
                  <AppSelect
                    className="export-select"
                    ariaLabel={t("export_dialog.decode_engine")}
                    value={settings.decodeEngine}
                    onValueChange={(v) => {
                      // Mirrors the disabled option defensively — a Standard
                      // pin without the component would only degrade back to
                      // auto at resolve time anyway.
                      if (v === "ffmpeg" && !decodeComponentAvailable) return;
                      patch({ decodeEngine: v as ExportDecodeEngine });
                    }}
                    options={decodeEngineOptions(t, decodeComponentAvailable)}
                  />
                </div>
                {!decodeComponentAvailable && (
                  <p className="settings-blurb">
                    {t("settings.decode_engine_unavailable", {
                      reason: decodeComponentReason ?? "",
                    })}
                  </p>
                )}
                {decodeCounts && (
                  <p className={decodeCounts.proxy > 0 ? "settings-warn" : "settings-blurb"}>
                    {t("export_dialog.decode_summary", {
                      originals: decodeCounts.originals,
                      proxy: decodeCounts.proxy,
                    })}
                  </p>
                )}

                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.codec")}
                  </span>
                  <AppSelect
                    className="export-select"
                    ariaLabel={t("export_dialog.codec")}
                    value={settings.codec}
                    onValueChange={(v) => {
                      const codec = v as CodecId;
                      // Snap bitDepth: intermediates imply depth by profile
                      // (ProRes=10, DNxHR=8); H.264 cannot produce Hi10P
                      // output; other delivery codecs keep the existing
                      // smart-default (auto-10 on a 10-bit-capable source,
                      // once, until the user touches the selector) —
                      // suppressed under an explicit WebCodecs pin, which is
                      // 8-bit-only (would auto-snap into an invalid combo).
                      const bitDepth: BitDepth = isIntermediateCodec(codec)
                        ? codec === "prores"
                          ? 10
                          : 8
                        : codec === "h264"
                          ? 8
                          : !userTouchedBitDepth.current &&
                              hasTenBitSource &&
                              settings.encoderEngine !== "webcodecs"
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
                    <AppSelect className="export-select"
                      ariaLabel={t("export_dialog.prores_profile")}
                      value={settings.proresProfile}
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
                    <AppSelect className="export-select"
                      ariaLabel={t("export_dialog.dnxhr_profile")}
                      value={settings.dnxhrProfile}
                      onValueChange={(v) => patch({ dnxhrProfile: v as DnxhrProfile })}
                      options={[
                        { value: "lb", label: "LB" }, { value: "sq", label: "SQ" }, { value: "hq", label: "HQ" },
                      ]} />
                  </div>
                )}
                {/* Everything but an explicit WebCodecs pin shows the native
                    wording — see `webcodecsOk`. */}
                <p className="settings-blurb">
                  {settings.encoderEngine !== "webcodecs"
                    ? t("export_dialog.path_native")
                    : webcodecsOk === null
                      ? t("export_dialog.checking_codec")
                      : webcodecsOk === false
                        ? t("export_dialog.codec_unsupported", {
                            codec: settings.codec.toUpperCase(),
                          })
                        : t("export_dialog.path_webcodecs")}
                </p>

                {!isIntermediateCodec(settings.codec) && (
                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.bit_depth")}
                  </span>
                  <AppSelect
                    className="export-select"
                    ariaLabel={t("export_dialog.bit_depth")}
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
                        // 10-bit is native-only — mirrors the engine row
                        // disabling its webcodecs option at 10-bit.
                        disabled:
                          !isBitDepthValid(settings.codec, 10) ||
                          settings.encoderEngine === "webcodecs",
                      },
                    ]}
                  />
                </div>
                )}
                {!isIntermediateCodec(settings.codec) &&
                  hasTenBitSource &&
                  settings.bitDepth === 8 && (
                    <p className="settings-blurb">
                      {t("export_dialog.bit_depth_hint")}
                    </p>
                  )}
                {!isIntermediateCodec(settings.codec) && settings.bitDepth === 10 && (
                  <p className="settings-warn">
                    {t("export_dialog.bit_depth_experimental_warning")}
                  </p>
                )}

                {!isIntermediateCodec(settings.codec) && (
                  <>
                {/* Rate control leads the group: it decides whether the rows
                    below are bitrate targets or a CRF, so a mode chosen after
                    them would keep re-labelling what was just set. */}
                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.rate_mode")}
                  </span>
                  <AppSelect
                    className="export-select"
                    ariaLabel={t("export_dialog.rate_mode")}
                    value={settings.rateMode}
                    onValueChange={(v) => patch({ rateMode: v as RateMode })}
                    options={[
                      { value: "vbr", label: t("export_dialog.rate_vbr") },
                      { value: "cbr", label: t("export_dialog.rate_cbr") },
                      {
                        value: "quality", label: t("export_dialog.rate_quality"),
                        disabled: settings.encoderEngine === "webcodecs" || isIntermediateCodec(settings.codec),
                      },
                    ]}
                  />
                </div>

                {isBitrateRateMode(settings.rateMode) ? (
                  <>
                {/* The preset is a shortcut that SEEDS the target bitrate below,
                    not a parallel control — under CRF it decides nothing, which
                    is why it lives inside this branch. */}
                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.quality")}
                  </span>
                  <AppSelect
                    className="export-select"
                    ariaLabel={t("export_dialog.quality")}
                    value={settings.quality}
                    onValueChange={(v) => {
                      const quality = v as QualityPreset;
                      // Preset → drop the stale override so the bpp heuristic
                      // drives the number again. Custom → seed from what is
                      // already on screen, so the field is a value to nudge
                      // rather than a blank the export can't run without.
                      patch({
                        quality,
                        customBitrate: quality === "custom" ? effectiveBitrate : null,
                      });
                    }}
                    options={[
                      { value: "low", label: t("export_dialog.quality_low") },
                      { value: "medium", label: t("export_dialog.quality_medium") },
                      { value: "high", label: t("export_dialog.quality_high") },
                      { value: "custom", label: t("export_dialog.quality_custom") },
                    ]}
                  />
                </div>
                {/* Always visible, never preset-gated: this IS the bitrate the
                    export runs at, and under CBR it is the whole setting. Under
                    a preset it shows the heuristic's value (rounded to 10 kbps
                    for display — the run uses the exact figure); typing takes
                    the number over by flipping the preset to Custom. */}
                <div className="export-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.target_bitrate")}
                  </span>
                  <span className="export-bitrate">
                    <AppNumberField
                      value={Number((effectiveBitrate / 1_000_000).toFixed(2))}
                      min={0.1}
                      step={1}
                      align="center"
                      className="settings-input-narrow"
                      ariaLabel={t("export_dialog.target_bitrate")}
                      onValueChange={(v) =>
                        patch({
                          quality: "custom",
                          customBitrate: Math.max(1, Math.round(v * 1_000_000)),
                        })
                      }
                    />
                    <span className="settings-slider-unit">
                      {t("export_dialog.mbps")}
                    </span>
                  </span>
                </div>
                {settings.rateMode === "cbr" && (
                  <p className="settings-blurb">{t("export_dialog.cbr_hint")}</p>
                )}

                {maxBitrateApplies(settings) && (
                  <div className="export-row">
                    <span className="settings-toggle-label">
                      {t("export_dialog.max_bitrate")}
                    </span>
                    <span className="export-bitrate">
                      <AppNumberField
                        value={
                          settings.maxBitrate != null
                            ? Number((settings.maxBitrate / 1_000_000).toFixed(2))
                            : null
                        }
                        min={0.1}
                        step={1}
                        align="center"
                        className="settings-input-narrow"
                        ariaLabel={t("export_dialog.max_bitrate")}
                        onValueChange={(v) =>
                          patch({ maxBitrate: Math.max(1, Math.round(v * 1_000_000)) })
                        }
                        // Clearing the field is the only way back to uncapped
                        // ABR — the shipped default — so it must reach null,
                        // not fall back to the last typed number.
                        onClear={() => patch({ maxBitrate: null })}
                      />
                      <span className="settings-slider-unit">
                        {t("export_dialog.mbps")}
                      </span>
                    </span>
                  </div>
                )}
                {maxBitrateApplies(settings) && settings.maxBitrate == null && (
                  <p className="settings-blurb">
                    {t("export_dialog.max_bitrate_unlimited")}
                  </p>
                )}
                {bitrateIssue === "max_below_target" && (
                  <p className="settings-warn">
                    {t("export_dialog.max_bitrate_below_target")}
                  </p>
                )}
                {/* A peak/buffer has no field on a WebCodecs VideoEncoderConfig
                    (bitrate + bitrateMode is the whole surface), so the rows are
                    absent rather than dead under that pin — say why. */}
                {settings.rateMode === "vbr" &&
                  settings.encoderEngine === "webcodecs" && (
                    <p className="settings-blurb">
                      {t("export_dialog.rate_constraints_native_only")}
                    </p>
                  )}

                {bufferSizeApplies(settings) && (
                  <div className="export-row">
                    <span className="settings-toggle-label">
                      {t("export_dialog.buffer_size")}
                    </span>
                    <span className="export-bitrate">
                      <AppNumberField
                        value={
                          settings.bufferSize != null
                            ? Number((settings.bufferSize / 1_000_000).toFixed(2))
                            : null
                        }
                        min={0.1}
                        step={1}
                        align="center"
                        className="settings-input-narrow"
                        ariaLabel={t("export_dialog.buffer_size")}
                        onValueChange={(v) =>
                          patch({ bufferSize: Math.max(1, Math.round(v * 1_000_000)) })
                        }
                        onClear={() => patch({ bufferSize: null })}
                      />
                      <span className="settings-slider-unit">
                        {t("export_dialog.mbit")}
                      </span>
                    </span>
                  </div>
                )}
                {bufferSizeApplies(settings) && settings.bufferSize == null && (
                  <p className="settings-blurb">
                    {t("export_dialog.buffer_size_auto")}
                  </p>
                )}
                  </>
                ) : (
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
                    ariaLabel={t("export_dialog.keyframe_interval")}
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
                    ariaLabel={t("export_dialog.encoder_accel")}
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
                    <AppSelect className="export-select"
                      ariaLabel={t("export_dialog.speed_preset")}
                      value={settings.preset}
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
                        ariaLabel={t("export_dialog.audio_codec")}
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
                        ariaLabel={t("export_dialog.audio_bitrate")}
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
                        ariaLabel={t("export_dialog.audio_channels")}
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
                        ariaLabel={t("export_dialog.audio_sample_rate")}
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
