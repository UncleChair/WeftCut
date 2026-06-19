import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CornerNotice } from "@/components/CornerNotice";
import type { AppNotice } from "../../shared/ipc";

/// Surfaces app-level startup notices (e.g. "cloud API keys stored unencrypted"
/// on a keyringless Linux box) as non-modal corner panels. PULLS them on mount
/// via `api.app.notices()` — a pull model, not a fire-once event, so a notice
/// raised before the renderer mounted can't be lost. Each notice's `code` keys
/// its i18n title/body; dismiss is per-notice and local (the underlying
/// condition is unchanged — this just clears the heads-up for the session).
export function AppNotices() {
  const { t } = useTranslation();
  const [notices, setNotices] = useState<AppNotice[]>([]);

  useEffect(() => {
    let alive = true;
    window.api.app
      .notices()
      .then((ns) => {
        if (alive) setNotices(ns);
      })
      .catch(() => {
        /* notices are best-effort; never block the UI on them */
      });
    return () => {
      alive = false;
    };
  }, []);

  const dismiss = (code: string) =>
    setNotices((ns) => ns.filter((n) => n.code !== code));

  return (
    <>
      {notices.map((n) => (
        <CornerNotice
          key={n.code}
          className={`app-notice app-notice-${n.code}`}
          title={t(`app_notice.${n.code}.title`)}
          actionLabel={t("app_notice.dismiss")}
          onAction={() => dismiss(n.code)}
        >
          <p className="import-proxy-note">{t(`app_notice.${n.code}.body`)}</p>
        </CornerNotice>
      ))}
    </>
  );
}
