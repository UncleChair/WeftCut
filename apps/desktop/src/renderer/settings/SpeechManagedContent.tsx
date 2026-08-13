import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CONTENT_EVENTS,
  contentCancel,
  contentDownload,
  contentList,
  contentOpenFolder,
  contentRemove,
  type ContentDownloadProgress,
  type ContentListRow,
} from "../ipc";
import { listen, type UnlistenFn } from "@/bridge/events";
import { Button } from "@/components/ui/button";

/// The ADR 0039 download affordance for one local speech backend, rendered
/// inside its LocalBackendRow. Renders nothing unless the catalog covers this
/// backend on this platform, so manual-path-only engines (FunASR today) and
/// uncovered OSes see no change. One button downloads the engine + model pair
/// sequentially with inline progress and cancel; once everything is installed
/// it collapses to a managed-content caption with Open folder / Remove.
/// Downloaded paths land in the row's pickers via the main-process auto-fill →
/// `onChanged` re-fetch, never by this component writing config itself.

type Phase =
  | { kind: "idle" }
  | { kind: "downloading"; itemId: string; received: number; total: number }
  | { kind: "error"; message: string };

export function SpeechManagedContent({
  backend,
  onChanged,
  onError,
}: {
  backend: string;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ContentListRow[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  /// The live progress subscription for the in-flight download only (the
  /// DataLocationSection pattern) — dropped in the download's finally and on
  /// unmount, even mid-stream.
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const refresh = async () => {
    try {
      const all = await contentList();
      setRows(all.filter((r) => r.item.speech?.backend === backend));
    } catch (e) {
      onError(String(e));
    }
  };

  useEffect(() => {
    void refresh();
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [backend]);

  if (rows === null) return null;
  const covered = rows.filter((r) => r.status.state !== "unavailable");
  if (covered.length === 0) return null;

  const missing = covered.filter(
    (r) => r.status.state === "not_installed" || r.status.state === "corrupt",
  );
  const hasCorrupt = covered.some((r) => r.status.state === "corrupt");
  const allInstalled = missing.length === 0;
  const prereqKeys = [
    ...new Set(
      covered
        .map((r) => r.item.prerequisiteKey)
        .filter((k): k is string => k !== undefined),
    ),
  ];

  const download = async () => {
    onError("");
    setBusy(true);
    setPhase({ kind: "downloading", itemId: "", received: 0, total: 0 });
    try {
      unlistenRef.current = await listen<ContentDownloadProgress>(
        CONTENT_EVENTS.progress,
        (e) => {
          const p = e.payload;
          if (p.phase === "done" || p.phase === "error") return;
          setPhase((s) =>
            s.kind === "downloading"
              ? {
                  kind: "downloading",
                  itemId: p.itemId,
                  received: p.receivedBytes,
                  total: p.totalBytes,
                }
              : s,
          );
        },
      );
      for (const row of missing) {
        setPhase({
          kind: "downloading",
          itemId: row.item.id,
          received: 0,
          total: 0,
        });
        const result = await contentDownload(row.item.id);
        if (!result.ok) {
          setPhase(
            "cancelled" in result
              ? { kind: "idle" }
              : { kind: "error", message: result.error },
          );
          return;
        }
      }
      setPhase({ kind: "idle" });
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
      setBusy(false);
      // Refresh both surfaces even on failure/cancel: a partial pair (engine
      // yes, model no) must render truthfully.
      await refresh();
      await onChanged();
    }
  };

  const cancel = async () => {
    if (phase.kind !== "downloading" || !phase.itemId) return;
    try {
      await contentCancel(phase.itemId);
    } catch (e) {
      onError(String(e));
    }
  };

  const remove = async () => {
    setConfirmingRemove(false);
    setBusy(true);
    onError("");
    try {
      for (const row of covered) {
        if (row.status.state === "installed" || row.status.state === "corrupt") {
          await contentRemove(row.item.id);
        }
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
      await refresh();
      await onChanged();
    }
  };

  const downloadingLabelKey =
    phase.kind === "downloading"
      ? covered.find((r) => r.item.id === phase.itemId)?.item.labelKey
      : undefined;
  const mb = (n: number): string => (n / 1048576).toFixed(1);

  return (
    <div className="settings-managed-content">
      {phase.kind === "downloading" ? (
        <div className="settings-data-migrate" aria-live="polite">
          <p className="settings-toggle-hint">
            {t("settings.content_downloading", {
              label: downloadingLabelKey
                ? t(`settings.${downloadingLabelKey}`)
                : "…",
            })}
            {phase.total > 0 &&
              ` — ${mb(phase.received)} / ${mb(phase.total)} MB`}
          </p>
          <div className="settings-key-input-row">
            <div
              className="progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              {...(phase.total > 0
                ? {
                    "aria-valuenow": Math.round(
                      (phase.received / phase.total) * 100,
                    ),
                  }
                : {})}
            >
              <div
                className="progress-fill"
                style={{
                  width: `${phase.total > 0 ? Math.round((phase.received / phase.total) * 100) : 0}%`,
                }}
              />
            </div>
            <Button size="sm" onClick={() => void cancel()}>
              {t("settings.content_cancel")}
            </Button>
          </div>
        </div>
      ) : allInstalled ? (
        <div className="settings-key-input-row">
          <span className="settings-toggle-hint">
            {t("settings.content_managed")}
          </span>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void contentOpenFolder().catch((e) => onError(String(e)))}
          >
            {t("settings.content_open_folder")}
          </Button>
          {confirmingRemove ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => void remove()}>
                {t("settings.content_remove_confirm")}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setConfirmingRemove(false)}
              >
                {t("settings.content_cancel")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => setConfirmingRemove(true)}
            >
              {t("settings.content_remove")}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="settings-key-input-row">
            <Button size="sm" disabled={busy} onClick={() => void download()}>
              {phase.kind === "error"
                ? t("settings.content_retry")
                : hasCorrupt
                  ? t("settings.content_redownload")
                  : t("settings.content_download_pair")}
            </Button>
            {phase.kind === "error" && (
              <span className="settings-test-err">✗ {phase.message}</span>
            )}
          </div>
          {prereqKeys.map((k) => (
            <p key={k} className="settings-toggle-hint">
              {t(`settings.${k}`)}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
