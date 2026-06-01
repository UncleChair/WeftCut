import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { exportSettingsGet, exportSettingsSet } from "../ipc";
import { probeEncoderSupported, smokeEncode } from "../render/exportCodecProbe";
import {
  type CodecId,
  type ExportSettings,
  type QualityPreset,
  type RateMode,
  computeBitrate,
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

const ALL_CODECS: CodecId[] = ["h264", "av1", "hevc"];

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
  const [supported, setSupported] = useState<Set<CodecId>>(new Set(["h264"]));
  const [smokeFailed, setSmokeFailed] = useState<CodecId | null>(null);
  const [busy, setBusy] = useState(false);

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

  // Probe codecs once (uses composition dims as the representative case).
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      ALL_CODECS.map(async (c) => ({
        c,
        ok: await probeEncoderSupported(c, comp.width, comp.height, compFps),
      })),
    ).then((results) => {
      if (cancelled) return;
      setSupported(new Set(results.filter((r) => r.ok).map((r) => r.c)));
    });
    return () => {
      cancelled = true;
    };
  }, [comp.width, comp.height, compFps]);

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

  if (!settings) return null;

  const patch = (p: Partial<ExportSettings>) =>
    setSettings((s) => (s ? { ...s, ...p } : s));

  async function onSelectCodec(codec: CodecId) {
    patch({ codec });
    setSmokeFailed(null);
    if (codec !== "h264") {
      setBusy(true);
      const ok = await smokeEncode(codec, comp.width, comp.height, compFps);
      setBusy(false);
      if (!ok) setSmokeFailed(codec);
    }
  }

  async function onBrowse() {
    const chosen = await saveDialog({
      title: t("export_dialog.choose_path"),
      defaultPath: "weftcut-export.mp4",
      filters: [{ name: t("dialogs.export_filter"), extensions: ["mp4"] }],
    });
    if (typeof chosen === "string") setPath(chosen);
  }

  async function onExport() {
    if (!path || !settings) return;
    await exportSettingsSet(settings).catch(() => {});
    onConfirm(settings, path);
  }

  const canExport = !!path && !busy && !smokeFailed;

  return (
    <aside className="export-settings-dialog" role="dialog" aria-modal="true">
      <h2>{t("export_dialog.title")}</h2>

      <label>
        {t("export_dialog.resolution")}
        <select
          value={settings.resolutionHeight ?? ""}
          onChange={(e) =>
            patch({
              resolutionHeight: e.target.value ? Number(e.target.value) : null,
            })
          }
        >
          <option value="">
            {t("export_dialog.follow_comp")} ({comp.width}×{comp.height})
          </option>
          {downscaleHeightOptions(comp.height).map((h) => (
            <option key={h} value={h}>
              {h}p
            </option>
          ))}
        </select>
      </label>

      <label>
        {t("export_dialog.fps")}
        <select
          value={settings.fps ?? ""}
          onChange={(e) =>
            patch({ fps: e.target.value ? Number(e.target.value) : null })
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
      </label>

      <label>
        {t("export_dialog.codec")}
        <select
          value={settings.codec}
          onChange={(e) => void onSelectCodec(e.target.value as CodecId)}
        >
          {ALL_CODECS.filter((c) => supported.has(c)).map((c) => (
            <option key={c} value={c}>
              {c === "h264" ? "H.264" : c === "av1" ? "AV1" : "HEVC"}
            </option>
          ))}
        </select>
      </label>
      {busy && <p className="hint">{t("export_dialog.checking_codec")}</p>}
      {smokeFailed && (
        <p className="error">
          {t("export_dialog.codec_unsupported", {
            codec: smokeFailed.toUpperCase(),
          })}
        </p>
      )}

      <label>
        {t("export_dialog.quality")}
        <select
          value={settings.quality}
          onChange={(e) => patch({ quality: e.target.value as QualityPreset })}
        >
          <option value="low">{t("export_dialog.quality_low")}</option>
          <option value="medium">{t("export_dialog.quality_medium")}</option>
          <option value="high">{t("export_dialog.quality_high")}</option>
          <option value="custom">{t("export_dialog.quality_custom")}</option>
        </select>
      </label>
      {settings.quality === "custom" && (
        <label>
          {t("export_dialog.custom_bitrate")}
          <input
            type="number"
            min={500}
            step={500}
            value={
              settings.customBitrate ? settings.customBitrate / 1_000_000 : ""
            }
            onChange={(e) =>
              patch({
                customBitrate: e.target.value
                  ? Math.round(Number(e.target.value) * 1_000_000)
                  : null,
              })
            }
          />
          {t("export_dialog.mbps")}
        </label>
      )}

      <label>
        {t("export_dialog.rate_mode")}
        <select
          value={settings.rateMode}
          onChange={(e) => patch({ rateMode: e.target.value as RateMode })}
        >
          <option value="vbr">VBR</option>
          <option value="cbr">CBR</option>
        </select>
      </label>

      <p className="estimate">
        {t("export_dialog.estimated_size", { size: formatBytes(estimate) })}
      </p>

      <label>
        {t("export_dialog.output_path")}
        <input type="text" readOnly value={path} />
        <button onClick={() => void onBrowse()}>
          {t("export_dialog.browse")}
        </button>
      </label>

      <div className="actions">
        <button onClick={onCancel}>{t("export_dialog.cancel")}</button>
        <button disabled={!canExport} onClick={() => void onExport()}>
          {t("export_dialog.export")}
        </button>
      </div>
    </aside>
  );
}
