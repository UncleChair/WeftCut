import { useState } from "react";
import { useTranslation } from "react-i18next";
import { acknowledgeMotifStaleness, type MotifStaleEntry } from "../ipc";

/// One-time on-open notice: some placed Motif layers were created at an
/// older version than the catalog now carries (docs/motifs.md "User
/// Motifs"). The layers ALREADY render with the current look (live/mutable —
/// the layer's stored version is only a seen-at marker), so this informs, it
/// doesn't offer to revert. Dismissing acknowledges: the markers bump to the
/// current version in one undo entry, so the notice doesn't repeat next open.
export function MotifStaleDialog({
  entries,
  onDone,
}: {
  entries: MotifStaleEntry[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await acknowledgeMotifStaleness();
    } catch {
      // Best-effort: a failed ack just means the notice repeats next open.
    }
    onDone();
  };
  return (
    <aside className="export-panel import-proxy-dialog motif-stale-dialog">
      <header>
        <span>{t("motif_stale.title")}</span>
        <button disabled={busy} onClick={() => void dismiss()}>
          {t("motif_stale.dismiss")}
        </button>
      </header>
      <ul className="import-proxy-list">
        {entries.map((e) => (
          <li key={e.motif_id}>
            <span className="import-proxy-clip">{e.name}</span>
            <span className="import-proxy-reason">
              {t("motif_stale.entry", {
                from: e.placed_version,
                to: e.current_version,
                n: e.layer_count,
              })}
            </span>
          </li>
        ))}
      </ul>
      <p className="import-proxy-note">{t("motif_stale.note")}</p>
    </aside>
  );
}
