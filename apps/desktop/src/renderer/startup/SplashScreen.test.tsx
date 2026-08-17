// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import iconSvg from "../public/icons/icon.svg?raw";
import { SplashScreen } from "./SplashScreen";
import type { StartupProgress } from "./initializeRenderer";

const READY_PROGRESS: StartupProgress = {
  pending: [],
  completed: 4,
  total: 4,
};
const READY_STATUS_PROPS = {
  startupProgress: READY_PROGRESS,
  routePending: false,
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  await i18n.changeLanguage("en-US");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SplashScreen launch mark", () => {
  it("stacks the pre-rendered mark layers under the canonical pulse geometry", () => {
    const iconDocument = new DOMParser().parseFromString(iconSvg, "image/svg+xml");
    const canonicalW = iconDocument.querySelector('path[fill="#6696E6"]');
    expect(canonicalW).not.toBeNull();

    const { container } = render(
      <SplashScreen {...READY_STATUS_PROPS} ready onComplete={() => {}} />,
    );

    const mark = container.querySelector(".splash-mark");
    // Bottom → top: final film, wedge filler, W-cut filler.
    const filmLayers = mark?.querySelectorAll(".splash-film-stack img");
    expect(
      [...(filmLayers ?? [])].map((img) => img.getAttribute("src")),
    ).toEqual([
      "./splash/film-final@2x.png",
      "./splash/wedge-filler@2x.png",
      "./splash/w-cut-filler@2x.png",
    ]);

    const wPaint = mark?.querySelector(".splash-w-paint img");
    expect(wPaint?.getAttribute("src")).toBe("./splash/w-paint@2x.png");

    // Paint order: film stack, painted W, then the pulse overlay.
    expect(mark?.children[0]?.classList.contains("splash-film-stack")).toBe(
      true,
    );
    expect(mark?.children[1]?.classList.contains("splash-w-paint")).toBe(true);
    expect(mark?.children[2]?.classList.contains("splash-pulse-overlay")).toBe(
      true,
    );

    // #splash-w-shape is the icon's painted W translated +100 into the
    // 640-wide mark frame; icon.svg serializes the same geometry at +0 with
    // different rounding, so the twin check pins the mark's string directly.
    const wShape = container.querySelector("#splash-w-shape");
    expect(wShape?.getAttribute("d")).toBe(
      "M300.117 167.417L251.477 239.378C249.409 242.438 244.851 242.276 243.004 239.078L195.331 156.5C192.652 151.859 187.7 149 182.34 149H110C104.478 149 100 153.477 100 159V183C100 188.523 104.478 193 110 193H157.306C162.684 193 167.65 195.879 170.322 200.545L224.679 295.455C227.352 300.121 232.318 303 237.696 303H254.024C259.011 303 263.672 300.522 266.461 296.387L320.001 217L373.541 296.387C376.329 300.522 380.99 303 385.977 303H402.306C407.683 303 412.649 300.121 415.322 295.455L469.679 200.545C472.352 195.879 477.318 193 482.696 193H530C535.523 193 540 188.523 540 183V159C540 153.477 535.523 149 530 149H457.661C452.302 149 447.35 151.859 444.671 156.5L396.997 239.078C395.151 242.276 390.593 242.438 388.525 239.378L339.885 167.417C330.368 153.337 309.634 153.337 300.117 167.417Z",
    );
    expect(
      container.querySelector('#splash-pulse-w-clip use[href="#splash-w-shape"]'),
    ).not.toBeNull();

    const pulseTrace = container.querySelector(".splash-logo-pulse-trace");
    expect(pulseTrace?.getAttribute("clip-path")).toBe(
      "url(#splash-pulse-w-clip)",
    );
    const pulse = pulseTrace?.querySelector('g[transform="translate(100 0)"]');
    expect(
      pulse?.querySelectorAll(".logo-pulse-glow, .logo-pulse-core"),
    ).toHaveLength(2);
  });

  it("shows the checks that are currently keeping startup open", () => {
    const { container, rerender } = render(
      <SplashScreen
        ready={false}
        startupProgress={{
          pending: ["evaluation_runtime", "motif_catalog"],
          completed: 2,
          total: 4,
        }}
        routePending
        onComplete={() => {}}
      />,
    );

    expect(
      container.querySelector(".splash-progress-message")?.textContent,
    ).toBe("Checking: evaluation engine · Motif catalog");
    expect(container.querySelector(".splash-progress-count")?.textContent).toBe(
      "2/4",
    );

    rerender(
      <SplashScreen
        ready={false}
        startupProgress={READY_PROGRESS}
        routePending
        onComplete={() => {}}
      />,
    );
    expect(
      container.querySelector(".splash-progress-message")?.textContent,
    ).toBe("Checking the launch project…");
  });

  it("holds the completed mark until launch dependencies are ready", () => {
    const onComplete = vi.fn();
    const { container, rerender } = render(
      <SplashScreen
        {...READY_STATUS_PROPS}
        ready={false}
        onComplete={onComplete}
      />,
    );

    act(() => vi.advanceTimersByTime(5000));

    expect(onComplete).not.toHaveBeenCalled();
    expect(
      container.firstElementChild?.classList.contains("splash-screen-waiting"),
    ).toBe(true);
    expect(
      container.firstElementChild?.classList.contains("splash-screen-pulsing"),
    ).toBe(true);

    rerender(
      <SplashScreen {...READY_STATUS_PROPS} ready onComplete={onComplete} />,
    );
    expect(
      container.firstElementChild?.classList.contains("splash-screen-exiting"),
    ).toBe(true);

    act(() => vi.advanceTimersByTime(199));
    expect(onComplete).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("keeps the full intro when dependencies finish early", () => {
    const onComplete = vi.fn();
    const { container } = render(
      <SplashScreen {...READY_STATUS_PROPS} ready onComplete={onComplete} />,
    );

    act(() => vi.advanceTimersByTime(2499));
    expect(onComplete).not.toHaveBeenCalled();
    expect(
      container.firstElementChild?.classList.contains("splash-screen-intro"),
    ).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(
      container.firstElementChild?.classList.contains("splash-screen-exiting"),
    ).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(200));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("signals intro completion exactly when the motion finishes", () => {
    const onIntroComplete = vi.fn();
    render(
      <SplashScreen
        {...READY_STATUS_PROPS}
        ready={false}
        onIntroComplete={onIntroComplete}
        onComplete={() => {}}
      />,
    );

    act(() => vi.advanceTimersByTime(2499));
    expect(onIntroComplete).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onIntroComplete).toHaveBeenCalledOnce();

    // Still held (not ready) — the signal is about the motion, not the exit.
    act(() => vi.advanceTimersByTime(5000));
    expect(onIntroComplete).toHaveBeenCalledOnce();
  });

  it("stays open for a manually controlled development preview", () => {
    const onComplete = vi.fn();
    const { container } = render(
      <SplashScreen
        {...READY_STATUS_PROPS}
        ready
        autoComplete={false}
        onComplete={onComplete}
      />,
    );

    act(() => vi.advanceTimersByTime(5000));

    expect(onComplete).not.toHaveBeenCalled();
    expect(
      container.firstElementChild?.classList.contains("splash-screen-waiting"),
    ).toBe(true);
    expect(container.firstElementChild?.getAttribute("aria-busy")).toBe(
      "false",
    );
  });
});
