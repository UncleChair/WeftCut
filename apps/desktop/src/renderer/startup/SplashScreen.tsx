import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LogoPulsePaths } from "./LogoPulsePaths";
import type { StartupProgress } from "./initializeRenderer";

interface Props {
  /** Whether every launch dependency has settled and the destination is ready. */
  ready: boolean;
  /** Disable automatic exit when development preview is manually held open. */
  autoComplete?: boolean;
  startupProgress: StartupProgress | null;
  routePending: boolean;
  onComplete: () => void;
}

const SPLASH_INTRO_DURATION_MS = 2500;
const SPLASH_EXIT_DURATION_MS = 200;
const REDUCED_MOTION_INTRO_DURATION_MS = 120;
const REDUCED_MOTION_EXIT_DURATION_MS = 120;

/**
 * The launch mark composes pre-rendered PNG layers from public/splash: the
 * film frame with the icon's final cutout, plus film-colored filler layers
 * that CSS clip-path animations erase to replay the W cut and wedge split.
 * Only the pulse trace stays inline SVG so its clip can keep sharing the
 * icon's painted-W geometry.
 */
export function SplashScreen({
  ready,
  autoComplete = true,
  startupProgress,
  routePending,
  onComplete,
}: Props) {
  const { t } = useTranslation();
  const [reduceMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [introComplete, setIntroComplete] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setIntroComplete(true),
      reduceMotion
        ? REDUCED_MOTION_INTRO_DURATION_MS
        : SPLASH_INTRO_DURATION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [reduceMotion]);

  const exiting = introComplete && ready && autoComplete;

  useEffect(() => {
    if (!exiting) return;
    const timeout = window.setTimeout(
      onComplete,
      reduceMotion
        ? REDUCED_MOTION_EXIT_DURATION_MS
        : SPLASH_EXIT_DURATION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [exiting, onComplete, reduceMotion]);

  const phase = exiting ? "exiting" : introComplete ? "waiting" : "intro";
  const pendingChecks = startupProgress?.pending ?? [];
  const statusText = !startupProgress
    ? t("splash.starting")
    : pendingChecks.length > 0
      ? t("splash.checking", {
          items: pendingChecks
            .map((check) => t(`splash.check.${check}`))
            .join(t("splash.check_separator")),
        })
      : routePending
        ? t("splash.resolving_project")
        : t("splash.ready");

  return (
    <div
      className={`splash-screen splash-screen-${phase}${introComplete ? " splash-screen-pulsing" : ""}`}
      data-drag-region
      role="status"
      aria-busy={!ready}
      aria-atomic="true"
    >
      <div className="splash-mark" aria-hidden="true">
        <div className="splash-film-stack">
          <img
            className="splash-film-final"
            src="./splash/film-final@2x.png"
            alt=""
            draggable={false}
          />
          <img
            className="splash-wedge-filler"
            src="./splash/wedge-filler@2x.png"
            alt=""
            draggable={false}
          />
          <img
            className="splash-w-cut-filler"
            src="./splash/w-cut-filler@2x.png"
            alt=""
            draggable={false}
          />
        </div>
        <div className="splash-w-paint">
          <img src="./splash/w-paint@2x.png" alt="" draggable={false} />
        </div>
        <svg
          className="splash-pulse-overlay"
          viewBox="0 0 640 440"
          fill="none"
        >
          <defs>
            <path
              id="splash-w-shape"
              d="M300.117 167.417L251.477 239.378C249.409 242.438 244.851 242.276 243.004 239.078L195.331 156.5C192.652 151.859 187.7 149 182.34 149H110C104.478 149 100 153.477 100 159V183C100 188.523 104.478 193 110 193H157.306C162.684 193 167.65 195.879 170.322 200.545L224.679 295.455C227.352 300.121 232.318 303 237.696 303H254.024C259.011 303 263.672 300.522 266.461 296.387L320.001 217L373.541 296.387C376.329 300.522 380.99 303 385.977 303H402.306C407.683 303 412.649 300.121 415.322 295.455L469.679 200.545C472.352 195.879 477.318 193 482.696 193H530C535.523 193 540 188.523 540 183V159C540 153.477 535.523 149 530 149H457.661C452.302 149 447.35 151.859 444.671 156.5L396.997 239.078C395.151 242.276 390.593 242.438 388.525 239.378L339.885 167.417C330.368 153.337 309.634 153.337 300.117 167.417Z"
            />
            <clipPath id="splash-pulse-w-clip">
              <use href="#splash-w-shape" />
            </clipPath>
          </defs>
          <g
            className="splash-logo-pulse-trace"
            clipPath="url(#splash-pulse-w-clip)"
          >
            <LogoPulsePaths offsetX={100} />
          </g>
        </svg>
      </div>
      <div className="splash-copy">
        <div className="splash-wordmark">WeftCut</div>
        <div className="splash-progress">
          <span className="splash-progress-dot" aria-hidden="true" />
          <span className="splash-progress-message">{statusText}</span>
          {startupProgress && pendingChecks.length > 0 && (
            <span className="splash-progress-count" aria-hidden="true">
              {startupProgress.completed}/{startupProgress.total}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
