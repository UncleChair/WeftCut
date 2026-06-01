import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { exportSettingsGet, exportSettingsSet } from "../ipc";
import {
  type EncodePath,
  resolveEncodePath,
} from "../render/exportCodecProbe";
import {
  CONTAINERS,
  type CodecId,
  type Container,
  type ExportSettings,
  type QualityPreset,
  type RateMode,
  computeBitrate,
  containerExtension,
  downscaleFpsOptions,
  downscaleHeightOptions,
  estimateBytes,
  formatBytes,
  mergeSettings,
  resolveOutputDims,
} from "../render/exportSettings";

interface Comp {
  width: number;
  height: number;
  fps_num: number;
  fps_den: number;
}

interface Props {
  comp: Comp;
  durationUs: number;
  hasAudio: boolean;
  onCancel: () => void;
  onConfirm: (settings: ExportSettings, path: string) => void;
}

export function ExportSettingsDialog({
  comp,
  durationUs,
  hasAudio,
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [path, setPath] = useState<string>("");
  const [encodePath, setEncodePath] = useState<EncodePath | null>(null);

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

  const dims = useMemo(
    () => (settings ? resolveOutputDims(comp, settings) : null),
    [comp, settings],
  );
  const outFps = useMemo(
    () => (settings?.fps != null ? settings.fps : compFps),
    [settings, compFps],
  );
  const estimate = useMemo(() => {
    if (!settings || !dims) return 0;
    const bitrate = computeBitrate(settings, dims.width, dims.height, outFps);
    return estimateBytes(bitrate, durationUs, hasAudio);
  }, [settings, dims, outFps, durationUs, hasAudio]);

  const patch = (p: Partial<ExportSettings>) =>
    setSettings((s) => (s ? { ...s, ...p } : s));

  async function onBrowse() {
    const ext = containerExtension(settings!.container);
    const chosen = await saveDialog({
      title: t("export_dialog.choose_path"),
      defaultPath: `weftcut-export.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (typeof chosen === "string") setPath(chosen);
  }

  async function onExport() {
    if (!path || !settings) return;
    await exportSettingsSet(settings).catch(() => {});
    onConfirm(settings, path);
  }

  const canExport = !!path && encodePath !== null;

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
                    {t("export_dialog.codec")}
                  </span>
                  <select
                    className="export-select"
                    value={settings.codec}
                    onChange={(e) =>
                      patch({ codec: e.target.value as CodecId })
                    }
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
                      const c = e.target.value as Container;
                      patch({ container: c });
                      if (path) {
                        const ext = containerExtension(c);
                        setPath(path.replace(/\.[^.\\/]+$/, `.${ext}`));
                      }
                    }}
                  >
                    {CONTAINERS.map((c) => (
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

                <p className="export-estimate">
                  {t("export_dialog.estimated_size", {
                    size: formatBytes(estimate),
                  })}
                </p>

                <div className="export-row export-path-row">
                  <span className="settings-toggle-label">
                    {t("export_dialog.output_path")}
                  </span>
                  <span className="export-path">
                    <input
                      type="text"
                      className="settings-input export-path-input"
                      readOnly
                      value={path}
                    />
                    <button onClick={() => void onBrowse()}>
                      {t("export_dialog.browse")}
                    </button>
                  </span>
                </div>

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
