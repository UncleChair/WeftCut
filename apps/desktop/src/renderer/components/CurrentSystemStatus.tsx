import { AlertTriangleIcon, InfoIcon, OctagonAlertIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { AppNotice } from "../../shared/ipc";
import {
  systemSettingsTarget,
  type SystemSettingsTarget,
} from "./systemStatus";

interface Props {
  notices: AppNotice[];
  onOpenSettings: (target: SystemSettingsTarget) => void;
}

function NoticeIcon({ level }: { level: AppNotice["level"] }) {
  if (level === "error") {
    return <OctagonAlertIcon size={15} aria-hidden />;
  }
  if (level === "warn") {
    return <AlertTriangleIcon size={15} aria-hidden />;
  }
  return <InfoIcon size={15} aria-hidden />;
}

/// Current capability state pinned above System log history. Unlike the log
/// ring, this section survives Clear and cannot be evicted by later entries.
export function CurrentSystemStatus({ notices, onOpenSettings }: Props) {
  const { t } = useTranslation();

  if (notices.length === 0) return null;

  return (
    <section
      className="current-system-status"
      aria-labelledby="current-system-status-title"
    >
      <div className="system-status-header">
        <h2 id="current-system-status-title" className="system-status-title">
          {t("system_status.title")}
        </h2>
        <span className="system-status-count">
          {t("system_status.summary", { count: notices.length })}
        </span>
      </div>
      <div className="system-status-list">
        {notices.map((notice) => {
          const target = systemSettingsTarget(notice.code);
          return (
            <div
              key={notice.code}
              className={`system-status-item system-status-item-${notice.level}`}
            >
              <span className="system-status-item-icon">
                <NoticeIcon level={notice.level} />
              </span>
              <div className="system-status-item-content">
                <strong>{t(`app_notice.${notice.code}.title`)}</strong>
                <p>{t(`app_notice.${notice.code}.body`)}</p>
                {target !== null && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onOpenSettings(target)}
                  >
                    {t(`app_notice.${notice.code}.action`)}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
