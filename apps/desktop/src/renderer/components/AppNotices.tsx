import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AppNotice } from "../../shared/ipc";

/// Surfaces app-level startup notices (e.g. "cloud API keys stored unencrypted"
/// on a keyringless Linux box) as in-flow banners below the app header. PULLS them on mount
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
    <div className="app-notices" aria-live="polite">
      {notices.map((n) => (
        <aside
          key={n.code}
          className={`app-notice-banner app-notice-${n.level} app-notice-${n.code}`}
          role="status"
        >
          <AlertTriangleIcon className="app-notice-icon" size={15} aria-hidden />
          <strong className="app-notice-title">
            {t(`app_notice.${n.code}.title`)}
          </strong>
          <span
            className="app-notice-body"
            title={t(`app_notice.${n.code}.body`)}
          >
            {t(`app_notice.${n.code}.body`)}
          </span>
          <Button
            className="app-notice-dismiss"
            variant="ghost"
            size="xs"
            onClick={() => dismiss(n.code)}
          >
            {t("app_notice.dismiss")}
          </Button>
        </aside>
      ))}
    </div>
  );
}
