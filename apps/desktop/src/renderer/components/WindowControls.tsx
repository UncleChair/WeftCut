import { useEffect, useState } from "react";
import { getCurrentWindow } from "@/bridge/window";
import { useTranslation } from "react-i18next";

/// Caption buttons for the frameless window (`decorations: false`):
/// minimize / maximize-restore / close, Windows-styled (square, flush to
/// the corner, red close hover). Lives at the right end of whichever bar
/// is acting as the title bar (app header, startup strip, agent strip).
/// The maximize glyph tracks the real window state via onResized — the
/// drag-region double-click and Win+arrow paths change it outside our
/// buttons.
///
/// Deliberate exception to the lucide-react icon convention (ADR 0020):
/// caption buttons must read as native Windows chrome — 10px hairline
/// glyphs matching Segoe-style caption icons, which lucide's 24px-grid
/// stroke-2 drawing style cannot reproduce.
export function WindowControls() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let cancelled = false;
    const sync = () => {
      void win.isMaximized().then((m) => {
        if (!cancelled) setMaximized(m);
      });
    };
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      cancelled = true;
      void unlisten.then((f) => f());
    };
  }, []);

  const win = getCurrentWindow();
  return (
    <div className="window-controls">
      <button
        type="button"
        className="window-control"
        onClick={() => void win.minimize()}
        aria-label={t("window_controls.minimize")}
        title={t("window_controls.minimize")}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control"
        onClick={() => void win.toggleMaximize()}
        aria-label={
          maximized
            ? t("window_controls.restore")
            : t("window_controls.maximize")
        }
        title={
          maximized
            ? t("window_controls.restore")
            : t("window_controls.maximize")
        }
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M2.5 2.5V0.5h7v7H7.5"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
            <rect
              x="0.5"
              y="2.5"
              width="7"
              height="7"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect
              x="0.5"
              y="0.5"
              width="9"
              height="9"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        onClick={() => void win.close()}
        aria-label={t("window_controls.close")}
        title={t("window_controls.close")}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M0 0l10 10M10 0L0 10"
            stroke="currentColor"
            strokeWidth="1"
            fill="none"
          />
        </svg>
      </button>
    </div>
  );
}
