import { useEffect, useState } from "react";
import type { AppNotice } from "../../shared/ipc";

/// Pulls process-level capability notices once the renderer is ready. The main
/// process collects them during startup, so a pull model avoids losing notices
/// before React has mounted. These are persistent environment states rather
/// than dismissible banners; consumers decide how prominently to surface them.
export function useAppNotices(): AppNotice[] {
  const [notices, setNotices] = useState<AppNotice[]>([]);

  useEffect(() => {
    let alive = true;
    window.api.app
      .notices()
      .then((next) => {
        if (alive) setNotices(next);
      })
      .catch(() => {
        // Capability notices are best-effort and must never block the editor.
      });
    return () => {
      alive = false;
    };
  }, []);

  return notices;
}
