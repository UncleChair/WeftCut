// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import "../i18n"; // initialize i18next with en-US translations so t(key) resolves
import type { AnimTrack, Interpolation } from "../ipc";
import { EASING_PRESETS } from "../../shared/easing";
import { clearEasingPreview, getEasingPreview } from "../keyframe/easingPreviewStore";
import en from "../i18n/locales/en-US";
import zh from "../i18n/locales/zh-CN";

// Stub AppSlider to a controlled range input so jsdom can drive onValueChange
// (drag) and onValueCommitted (release) deterministically — Base UI's real
// slider needs pointer capture jsdom doesn't implement (mirrors the
// RoleMixerPanel.test.tsx stub).
vi.mock("../components/AppSlider", () => ({
  AppSlider: ({
    value,
    min,
    max,
    step,
    ariaLabel,
    onValueChange,
    onValueCommitted,
  }: {
    value: number;
    min: number;
    max: number;
    step?: number;
    ariaLabel?: string;
    onValueChange: (v: number) => void;
    onValueCommitted?: (v: number) => void;
  }) => (
    <input
      type="range"
      role="slider"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onValueChange(Number(e.currentTarget.value))}
      onPointerUp={(e) => onValueCommitted?.(Number(e.currentTarget.value))}
    />
  ),
}));

import { EasingMenu } from "./EasingMenu";

afterEach(() => {
  cleanup();
  clearEasingPreview();
});

const track: AnimTrack<number> = {
  mode: "Keyframed",
  value: [
    { id: "k0", t_us: 0, value: 0, interp: { kind: "Linear" } },
    { id: "k1", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
  ],
};

/// Same two keys with k0's interp swapped — each test states only the interp
/// under test.
function trackWith(interp: Interpolation): AnimTrack<number> {
  return {
    mode: "Keyframed",
    value: [
      { id: "k0", t_us: 0, value: 0, interp },
      { id: "k1", t_us: 1_000_000, value: 1, interp: { kind: "Linear" } },
    ],
  };
}

function presetInterp(id: string): Interpolation {
  return EASING_PRESETS.find((p) => p.id === id)!.interp;
}

/// Tier 2 opens only through the Tier-1 "Easing library…" row — same as a user.
function openGallery() {
  fireEvent.click(screen.getByTestId("easing-open-gallery"));
}

function resolveKey(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<any>((acc, k) => acc?.[k], obj);
}

describe("EasingMenu — tier 1 command menu", () => {
  it("right-click opens the compact command menu, not the preset wall", () => {
    render(<EasingMenu x={0} y={0} track={track} kfId="k0" onCommit={() => {}} onClose={() => {}} />);
    expect(screen.getByTestId("easing-command-menu")).toBeTruthy();
    // The five NLE commands + Smooth + the library row — and zero gallery chips.
    for (const id of ["linear", "hold", "ease_in", "ease_out", "ease_in_out"]) {
      expect(screen.getByTestId(`easing-cmd-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId("easing-smooth")).toBeTruthy();
    expect(screen.getByTestId("easing-open-gallery")).toBeTruthy();
    expect(screen.queryAllByTestId("easing-preset-chip")).toHaveLength(0);
  });

  it("a command commits the table's baked interp verbatim and closes", () => {
    const onCommit = vi.fn();
    const onClose = vi.fn();
    render(<EasingMenu x={10} y={10} track={track} kfId="k0" onCommit={onCommit} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("easing-cmd-ease_in_out"));
    const next = onCommit.mock.calls[0]![0] as Extract<AnimTrack<number>, { mode: "Keyframed" }>;
    expect(next.value.find((k) => k.id === "k0")!.interp).toEqual(presetInterp("ease_in_out"));
    expect(onClose).toHaveBeenCalled();
  });

  it("checkmarks exactly the command the reverse lookup names", () => {
    render(
      <EasingMenu x={0} y={0} track={trackWith(presetInterp("ease_in"))} kfId="k0" onCommit={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByTestId("easing-cmd-ease_in").textContent).toContain("✓");
    expect(screen.getByTestId("easing-cmd-ease_out").textContent).not.toContain("✓");
    expect(screen.getByTestId("easing-open-gallery").textContent).not.toContain("✓");
  });

  it("a gallery-only preset checkmarks the library row instead of a command", () => {
    render(
      <EasingMenu x={0} y={0} track={trackWith(presetInterp("ease_in_out_quint"))} kfId="k0" onCommit={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByTestId("easing-open-gallery").textContent).toContain("✓");
    for (const id of ["linear", "hold", "ease_in", "ease_out", "ease_in_out"]) {
      expect(screen.getByTestId(`easing-cmd-${id}`).textContent).not.toContain("✓");
    }
  });

  it("Smooth commits the smoothed track and closes", () => {
    const onCommit = vi.fn();
    const onClose = vi.fn();
    render(<EasingMenu x={0} y={0} track={track} kfId="k0" onCommit={onCommit} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("easing-smooth"));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("Smooth is disabled on a Hold keyframe — no commit possible", () => {
    const onCommit = vi.fn();
    render(
      <EasingMenu x={0} y={0} track={trackWith({ kind: "Hold" })} kfId="k0" onCommit={onCommit} onClose={() => {}} />,
    );
    const smooth = screen.getByTestId("easing-smooth") as HTMLButtonElement;
    expect(smooth.disabled).toBe(true);
    fireEvent.click(smooth);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("EasingMenu — tier 2 gallery", () => {
  it("the library row swaps to the gallery without closing the popover", () => {
    const onClose = vi.fn();
    render(<EasingMenu x={0} y={0} track={track} kfId="k0" onCommit={() => {}} onClose={onClose} />);
    openGallery();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("easing-gallery")).toBeTruthy();
    expect(screen.queryByTestId("easing-command-menu")).toBeNull();
  });

  it("renders the whole canonical table as thumbnails, one per preset", () => {
    render(<EasingMenu x={0} y={0} track={track} kfId="k0" onCommit={() => {}} onClose={() => {}} />);
    openGallery();
    const chips = screen.getAllByTestId("easing-preset-chip");
    expect(chips).toHaveLength(EASING_PRESETS.length);
    // Every thumbnail is an engine-sampled curve, not a text label.
    for (const chip of chips) {
      const pts = chip.querySelector("svg polyline")?.getAttribute("points");
      expect(pts, `${chip.getAttribute("aria-label")} thumbnail`).toBeTruthy();
    }
  });

  it("applying a gallery preset writes the table's interp verbatim (no re-derivation)", () => {
    const onCommit = vi.fn();
    render(<EasingMenu x={0} y={0} track={track} kfId="k0" onCommit={onCommit} onClose={() => {}} />);
    openGallery();
    fireEvent.click(screen.getByRole("button", { name: "Expo In" }));
    const next = onCommit.mock.calls[0]![0] as Extract<AnimTrack<number>, { mode: "Keyframed" }>;
    expect(next.value.find((k) => k.id === "k0")!.interp).toEqual(presetInterp("ease_in_expo"));
  });

  it("marks exactly the thumbnail the reverse lookup names for the current params", () => {
    render(
      <EasingMenu x={0} y={0} track={trackWith(presetInterp("ease_in_sine"))} kfId="k0" onCommit={() => {}} onClose={() => {}} />,
    );
    openGallery();
    const pressed = screen.getAllByTestId("easing-preset-chip")
      .filter((c) => c.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]!.getAttribute("aria-label")).toBe("Sine In");
  });

  it("a hand-tuned bezier selects no thumbnail (reverse lookup misses)", () => {
    const custom: Interpolation = { kind: "Bezier", p1: [0.1, 0.2], p2: [0.3, 0.4] };
    render(<EasingMenu x={0} y={0} track={trackWith(custom)} kfId="k0" onCommit={() => {}} onClose={() => {}} />);
    openGallery();
    const pressed = screen.getAllByTestId("easing-preset-chip")
      .filter((c) => c.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(0);
  });

  it("hovering a thumbnail previews it live on the curve; leaving clears", () => {
    render(<EasingMenu x={0} y={0} track={track} kfId="k0" onCommit={() => {}} onClose={() => {}} />);
    openGallery();
    const thumb = screen.getByRole("button", { name: "Bounce Out" });
    fireEvent.mouseOver(thumb);
    expect(getEasingPreview()).toEqual({ kfId: "k0", interp: presetInterp("ease_out_bounce") });
    fireEvent.mouseOut(thumb);
    expect(getEasingPreview()).toBeNull();
  });

  it("closing the menu clears an active hover preview", () => {
    const { unmount } = render(
      <EasingMenu x={0} y={0} track={track} kfId="k0" onCommit={() => {}} onClose={() => {}} />,
    );
    openGallery();
    fireEvent.mouseOver(screen.getByRole("button", { name: "Back In" }));
    expect(getEasingPreview()).not.toBeNull();
    unmount();
    expect(getEasingPreview()).toBeNull();
  });
});

describe("EasingMenu — elastic parameters (gallery view)", () => {
  const elastic: Interpolation = { kind: "Elastic", dir: "Out", amplitude: 1, period: 0.3 };

  it("shows the amplitude/period sliders only on an Elastic keyframe", () => {
    render(<EasingMenu x={0} y={0} track={trackWith(elastic)} kfId="k0" onCommit={() => {}} onClose={() => {}} />);
    openGallery();
    expect(screen.getByTestId("easing-elastic-params")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Amplitude" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Period" })).toBeTruthy();
  });

  it("shows no parameter sliders for Bounce (pure preset) or spline kinds", () => {
    render(<EasingMenu x={0} y={0} track={trackWith({ kind: "Bounce", dir: "In" })} kfId="k0" onCommit={() => {}} onClose={() => {}} />);
    openGallery();
    expect(screen.queryByTestId("easing-elastic-params")).toBeNull();
    cleanup();
    render(<EasingMenu x={0} y={0} track={track} kfId="k0" onCommit={() => {}} onClose={() => {}} />);
    openGallery();
    expect(screen.queryByTestId("easing-elastic-params")).toBeNull();
  });

  it("a slider gesture previews live and commits ONE complete Elastic interp on release", () => {
    const onCommit = vi.fn();
    render(<EasingMenu x={0} y={0} track={trackWith(elastic)} kfId="k0" onCommit={onCommit} onClose={() => {}} />);
    openGallery();
    const amp = screen.getByRole("slider", { name: "Amplitude" });
    // Mid-drag: live preview through the store, no commit yet (one undo step
    // per gesture, same convention as a tangent-handle drag).
    fireEvent.change(amp, { target: { value: "2" } });
    expect(onCommit).not.toHaveBeenCalled();
    expect(getEasingPreview()).toEqual({
      kfId: "k0",
      interp: { kind: "Elastic", dir: "Out", amplitude: 2, period: 0.3 },
    });
    // Release: exactly one commit carrying the COMPLETE interp from the
    // drag-local state — dir and the untouched period included.
    fireEvent.pointerUp(amp);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const next = onCommit.mock.calls[0]![0] as Extract<AnimTrack<number>, { mode: "Keyframed" }>;
    expect(next.value.find((k) => k.id === "k0")!.interp)
      .toEqual({ kind: "Elastic", dir: "Out", amplitude: 2, period: 0.3 });
  });

  it("a period commit keeps the amplitude a previous gesture set (drag-local, not mirror)", () => {
    const onCommit = vi.fn();
    const elasticIn: Interpolation = { kind: "Elastic", dir: "In", amplitude: 1, period: 0.3 };
    // The track prop is NEVER refreshed between the two gestures — exactly the
    // stale-mirror window — yet the second commit must carry both new params.
    render(<EasingMenu x={0} y={0} track={trackWith(elasticIn)} kfId="k0" onCommit={onCommit} onClose={() => {}} />);
    openGallery();
    const amp = screen.getByRole("slider", { name: "Amplitude" });
    fireEvent.change(amp, { target: { value: "1.5" } });
    fireEvent.pointerUp(amp);
    const per = screen.getByRole("slider", { name: "Period" });
    fireEvent.change(per, { target: { value: "0.45" } });
    fireEvent.pointerUp(per);
    expect(onCommit).toHaveBeenCalledTimes(2);
    const next = onCommit.mock.calls[1]![0] as Extract<AnimTrack<number>, { mode: "Keyframed" }>;
    expect(next.value.find((k) => k.id === "k0")!.interp)
      .toEqual({ kind: "Elastic", dir: "In", amplitude: 1.5, period: 0.45 });
  });

  it("closing the menu clears any leftover slider preview", () => {
    const { unmount } = render(
      <EasingMenu x={0} y={0} track={trackWith(elastic)} kfId="k0" onCommit={() => {}} onClose={() => {}} />,
    );
    openGallery();
    fireEvent.change(screen.getByRole("slider", { name: "Amplitude" }), { target: { value: "3" } });
    expect(getEasingPreview()).not.toBeNull();
    unmount();
    expect(getEasingPreview()).toBeNull();
  });
});

describe("EasingMenu — i18n coverage", () => {
  it("every preset/menu/family key resolves in BOTH locales", () => {
    const keys = [
      ...EASING_PRESETS.map((p) => p.labelKey),
      "keyframe.elastic_amplitude",
      "keyframe.elastic_period",
      "keyframe.procedural_badge",
      "keyframe.smooth",
      "keyframe.easing_library",
      "keyframe.family_classic",
      "keyframe.family_sine",
      "keyframe.family_quad",
      "keyframe.family_cubic",
      "keyframe.family_quart",
      "keyframe.family_quint",
      "keyframe.family_expo",
      "keyframe.family_circ",
      "keyframe.family_back",
      "keyframe.family_elastic",
      "keyframe.family_bounce",
    ];
    for (const key of keys) {
      expect(typeof resolveKey(en, key), `en-US ${key}`).toBe("string");
      expect(typeof resolveKey(zh, key), `zh-CN ${key}`).toBe("string");
      // zh-CN must be translated, not the en string pasted through (Hold/CRF-
      // style intentional identities don't exist in this key set).
      expect(resolveKey(zh, key), `zh-CN ${key} left as English`)
        .not.toBe(resolveKey(en, key));
    }
  });
});
