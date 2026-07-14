import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { XIcon } from "lucide-react";
import type { AppNotice } from "../../shared/ipc";
import { CurrentSystemStatus } from "./CurrentSystemStatus";
import type { SystemSettingsTarget } from "./systemStatus";

interface Props {
  notices: AppNotice[];
  onClose: () => void;
  onOpenSettings: (target: SystemSettingsTarget) => void;
}

/// Dedicated capability-status surface. It is intentionally separate from
/// LogConsole: notices are interactive here, while their mirrored log entries
/// remain ordinary, non-interactive rows in the log history.
export function SystemStatusPanel({ notices, onClose, onOpenSettings }: Props) {
  const { t } = useTranslation();

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <aside className="system-status-panel" aria-label={t("system_status.title")}>
      <button
        type="button"
        className="system-status-close"
        onClick={onClose}
        aria-label={t("log.close")}
      >
        <XIcon size={14} aria-hidden />
      </button>
      <CurrentSystemStatus
        notices={notices}
        onOpenSettings={onOpenSettings}
      />
    </aside>
  );
}
