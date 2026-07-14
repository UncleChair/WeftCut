import { useEffect } from "react";

interface Props {
  onComplete: () => void;
}

const SPLASH_DURATION_MS = 2700;
const REDUCED_MOTION_DURATION_MS = 240;

/**
 * The launch mark is drawn from the same geometry as public/icons/icon.svg.
 * Keeping it inline lets the film and W-shaped cut animate independently,
 * while the final frame remains the real app icon rather than an imitation.
 */
export function SplashScreen({ onComplete }: Props) {
  useEffect(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timeout = window.setTimeout(
      onComplete,
      reduceMotion ? REDUCED_MOTION_DURATION_MS : SPLASH_DURATION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [onComplete]);

  return (
    <div
      className="splash-screen"
      data-drag-region
      role="status"
      aria-label="WeftCut"
    >
      <div className="splash-mark" aria-hidden="true">
        <svg viewBox="0 0 640 440" fill="none">
          <defs>
            <path
              id="splash-w-shape"
              d="M300.117 167.417L251.477 239.378C249.409 242.438 244.851 242.276 243.004 239.078L195.331 156.5C192.652 151.859 187.7 149 182.34 149H110C104.478 149 100 153.477 100 159V183C100 188.523 104.478 193 110 193H157.306C162.684 193 167.65 195.879 170.322 200.545L224.679 295.455C227.352 300.121 232.318 303 237.696 303H254.024C259.011 303 263.672 300.522 266.461 296.387L320.001 217L373.541 296.387C376.329 300.522 380.99 303 385.977 303H402.306C407.683 303 412.649 300.121 415.322 295.455L469.679 200.545C472.352 195.879 477.318 193 482.696 193H530C535.523 193 540 188.523 540 183V159C540 153.477 535.523 149 530 149H457.661C452.302 149 447.35 151.859 444.671 156.5L396.997 239.078C395.151 242.276 390.593 242.438 388.525 239.378L339.885 167.417C330.368 153.337 309.634 153.337 300.117 167.417Z"
            />
            <clipPath id="splash-w-reveal">
              <rect
                className="splash-w-reveal"
                x="88"
                y="120"
                width="464"
                height="200"
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
              <use
                href="#splash-w-shape"
                fill="black"
                stroke="black"
                strokeWidth="24"
                clipPath="url(#splash-w-reveal)"
              />
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
        </svg>
      </div>
      <div className="splash-wordmark">WeftCut</div>
    </div>
  );
}
