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
 * The launch mark uses both the painted W and its distinct mask cutout from
 * public/icons/icon.svg. Keeping them inline lets the film and cut animate
 * independently while the final frame remains pixel-identical to the icon.
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
        <svg viewBox="0 0 640 440" fill="none">
          <defs>
            <path
              id="splash-w-shape"
              d="M300.117 167.417L251.477 239.378C249.409 242.438 244.851 242.276 243.004 239.078L195.331 156.5C192.652 151.859 187.7 149 182.34 149H110C104.478 149 100 153.477 100 159V183C100 188.523 104.478 193 110 193H157.306C162.684 193 167.65 195.879 170.322 200.545L224.679 295.455C227.352 300.121 232.318 303 237.696 303H254.024C259.011 303 263.672 300.522 266.461 296.387L320.001 217L373.541 296.387C376.329 300.522 380.99 303 385.977 303H402.306C407.683 303 412.649 300.121 415.322 295.455L469.679 200.545C472.352 195.879 477.318 193 482.696 193H530C535.523 193 540 188.523 540 183V159C540 153.477 535.523 149 530 149H457.661C452.302 149 447.35 151.859 444.671 156.5L396.997 239.078C395.151 242.276 390.593 242.438 388.525 239.378L339.885 167.417C330.368 153.337 309.634 153.337 300.117 167.417Z"
            />
            <path
              id="splash-w-cutout-shape"
              d="M85.2271 137C93.0869 137 100.35 141.193 104.28 148L147.801 223.386L193.489 155.794C206.178 137.021 233.823 137.021 246.512 155.794L292.199 223.386L335.721 148C339.651 141.193 346.914 137 354.774 137H452V205H380.957L324.294 303.934C320.375 310.778 313.091 315 305.204 315H283.318C276.004 315 269.168 311.365 265.079 305.301L220 238.462L174.922 305.301C170.833 311.365 163.997 315 156.683 315H134.797C126.91 315 119.626 310.778 115.707 303.934L59.0444 205H-11.9995V137H85.2271Z"
            />
            <clipPath id="splash-w-reveal">
              <rect
                className="splash-w-reveal"
                x="88"
                y="120"
                width="464"
                height="207"
              />
            </clipPath>
            <clipPath id="splash-middle-open">
              <rect
                className="splash-middle-open"
                x="100"
                y="147"
                width="440"
                height="142"
                shapeRendering="crispEdges"
              />
            </clipPath>
            <clipPath id="splash-pulse-w-clip">
              <use href="#splash-w-shape" />
            </clipPath>
            <mask
              id="splash-icon-cutout"
              maskUnits="userSpaceOnUse"
              x="76"
              y="0"
              width="489"
              height="440"
            >
              {/* Start as an entirely intact film frame. First the W is cut
                  left-to-right; only after that finishes does the middle
                  mask opens downward into the final icon shape. */}
              <rect x="100" width="440" height="440" fill="white" />
              <g clipPath="url(#splash-middle-open)">
                <path
                  d="M100 125H149.0005L249.353 327H100V125Z"
                  fill="black"
                />
                <path
                  d="M540 125H490L386.652 327H540V125Z"
                  fill="black"
                />
              </g>
              <g clipPath="url(#splash-w-reveal)">
                <use
                  href="#splash-w-cutout-shape"
                  transform="translate(100 0)"
                  fill="black"
                  stroke="black"
                  strokeWidth="24"
                />
              </g>
            </mask>
          </defs>

          <g className="splash-icon-film" mask="url(#splash-icon-cutout)">
            <path
              d="M505 0C524.33 0 540 15.67 540 35V405C540 424.33 524.33 440 505 440H135C115.67 440 100 424.33 100 405V35C100 15.67 115.67 0 135 0H505ZM158 336C151.373 336 146 341.373 146 348V390C146 396.627 151.373 402 158 402H200C206.627 402 212 396.627 212 390V348C212 341.373 206.627 336 200 336H158ZM299 336C292.373 336 287 341.373 287 348V390C287 396.627 292.373 402 299 402H341C347.627 402 353 396.627 353 390V348C353 341.373 347.627 336 341 336H299ZM440 336C433.373 336 428 341.373 428 348V390C428 396.627 433.373 402 440 402H482C488.627 402 494 396.627 494 390V348C494 341.373 488.627 336 482 336H440ZM158 38C151.373 38 146 43.373 146 50V92C146 98.627 151.373 104 158 104H200C206.627 104 212 98.627 212 92V50C212 43.373 206.627 38 200 38H158ZM299 38C292.373 38 287 43.373 287 50V92C287 98.627 292.373 104 299 104H341C347.627 104 353 98.627 353 92V50C353 43.373 347.627 38 341 38H299ZM440 38C433.373 38 428 43.373 428 50V92C428 98.627 433.373 104 440 104H482C488.627 104 494 98.627 494 92V50C494 43.373 488.627 38 482 38H440Z"
              fill="#5B7196"
            />
          </g>

          <use
            className="splash-icon-w"
            clipPath="url(#splash-w-reveal)"
            href="#splash-w-shape"
            fill="#6696E6"
          />
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
