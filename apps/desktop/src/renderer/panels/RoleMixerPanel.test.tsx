// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "../i18n";
import {
  clearMasterMeter,
  publishMasterMeter,
} from "../state/masterMeterStore";

const { setRoleGain, updateRoleFlags } = vi.hoisted(() => ({
  setRoleGain: vi.fn().mockResolvedValue(undefined),
  updateRoleFlags: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, setRoleGain, updateRoleFlags };
});

// The renderer-local audition override — mocked so the tests assert the exact
// begin/clear calls the fader gesture makes without a live Compositor.
const { setRoleGainOverride, clearRoleGainOverride } = vi.hoisted(() => ({
  setRoleGainOverride: vi.fn(),
  clearRoleGainOverride: vi.fn(),
}));
vi.mock("../render/audio/roleGainOverrides", () => ({
  setRoleGainOverride,
  clearRoleGainOverride,
}));

// Stub AppSlider to a controlled range input so jsdom can drive onValueChange
// (drag) and onValueCommitted (release) deterministically — Base UI's real
// slider needs pointer capture jsdom doesn't implement. min/max come through so
// jsdom's range-value sanitizer keeps negative dB values (mirrors AppSwitch
// stubbing in EffectsSection.test.tsx).
vi.mock("../components/AppSlider", () => ({
  AppSlider: ({
    value,
    min,
    max,
    step,
    ariaLabel,
    className,
    onValueChange,
    onValueCommitted,
  }: {
    value: number;
    min: number;
    max: number;
    step?: number;
    ariaLabel?: string;
    className?: string;
    onValueChange: (v: number) => void;
    onValueCommitted?: (v: number) => void;
  }) => (
    <input
      type="range"
      role="slider"
      className={className}
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

vi.mock("../state/projectStore", () => ({
  useAudioRoles: () => [
    { role: "dialogue", gain_db: -3, muted: false, solo: false },
    { role: "music", gain_db: 2, muted: true, solo: false },
  ],
}));

import { RoleMixerPanel } from "./RoleMixerPanel";

// Force a deterministic content width so the responsive strips/rows choice is
// testable (jsdom reports 0 for every rect and has no ResizeObserver).
function withWidth(px: number) {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ width: px, height: 0, top: 0, left: 0, right: px, bottom: 0, x: 0, y: 0, toJSON: () => ({}) });
}

afterEach(() => {
  cleanup();
  clearMasterMeter();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("RoleMixerPanel", () => {
  it("keeps Dialogue/Music/SFX/Voiceover as the fixed grouping axis with every control", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    expect(screen.getByRole("region", { name: "Mixer" })).toBeTruthy();
    // All four Roles render even when the store omits some (SFX/Voiceover fall
    // back to a neutral bus).
    for (const name of ["Dialogue", "Music", "SFX", "Voiceover"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    // Each Role exposes a fader, a numeric dB entry, mute, solo, and reset.
    expect(screen.getAllByRole("slider")).toHaveLength(4);
    expect(screen.getAllByLabelText(/gain \(dB\)$/)).toHaveLength(4);
    expect(screen.getAllByLabelText("Mute this role everywhere")).toHaveLength(4);
    expect(screen.getAllByLabelText("Solo this role (mutes the others)")).toHaveLength(4);
    expect(screen.getAllByLabelText(/^Reset .+ gain to 0 dB$/)).toHaveLength(4);
  });

  it("binds the fader to the Role's committed gain", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    const fader = screen.getByLabelText("Dialogue gain fader") as HTMLInputElement;
    expect(fader.value).toBe("-3");
  });

  it("records gain edits through setRoleGain without touching the flag path", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<RoleMixerPanel onMutated={onMutated} />);

    const gain = screen.getByLabelText("Dialogue gain (dB)");
    fireEvent.change(gain, { target: { value: "-6" } });
    fireEvent.blur(gain);

    await vi.waitFor(() => expect(setRoleGain).toHaveBeenCalledWith("dialogue", -6));
    expect(updateRoleFlags).not.toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalled();
  });

  it("resets a Role to 0 dB through the recorded gain path", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<RoleMixerPanel onMutated={onMutated} />);

    fireEvent.click(screen.getByLabelText("Reset Music gain to 0 dB"));

    await vi.waitFor(() => expect(setRoleGain).toHaveBeenCalledWith("music", 0));
    expect(updateRoleFlags).not.toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalled();
  });

  it("toggles mute through the unrecorded flag path without touching gain", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<RoleMixerPanel onMutated={onMutated} />);

    fireEvent.click(screen.getAllByLabelText("Mute this role everywhere")[0]!);

    await vi.waitFor(() => expect(updateRoleFlags).toHaveBeenCalledWith("dialogue", { muted: true }));
    expect(setRoleGain).not.toHaveBeenCalled();
    expect(onMutated).toHaveBeenCalled();
  });

  it("toggles solo through the unrecorded flag path", async () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.click(screen.getAllByLabelText("Solo this role (mutes the others)")[0]!);

    await vi.waitFor(() => expect(updateRoleFlags).toHaveBeenCalledWith("dialogue", { solo: true }));
    expect(setRoleGain).not.toHaveBeenCalled();
  });

  it("presents channel strips when wide", () => {
    withWidth(500);
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByRole("region", { name: "Mixer" }).className).toContain("mixer-panel--strips");
  });

  it("presents rows when narrow", () => {
    withWidth(240);
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByRole("region", { name: "Mixer" }).className).toContain("mixer-panel--rows");
  });
});

describe("RoleMixerPanel — Role Gain audition", () => {
  const faderFor = (role: string) =>
    screen.getByLabelText(`${role} gain fader`) as HTMLInputElement;

  it("auditions a fader drag live through the renderer-local override, recording nothing yet", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    fireEvent.change(faderFor("Dialogue"), { target: { value: "-6" } });

    // Live preview only: the override is set, no recorded command fires.
    expect(setRoleGainOverride).toHaveBeenCalledWith("dialogue", -6);
    expect(setRoleGain).not.toHaveBeenCalled();
    // The number field mirrors the drafted value so both widgets agree.
    expect((screen.getByLabelText("Dialogue gain (dB)") as HTMLInputElement).value).toBe("-6");
  });

  it("records exactly one setRoleGain on release and clears the override", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<RoleMixerPanel onMutated={onMutated} />);
    const fader = faderFor("Dialogue");

    // A drag with several intermediate steps, then release.
    fireEvent.change(fader, { target: { value: "-4" } });
    fireEvent.change(fader, { target: { value: "-5.5" } });
    fireEvent.pointerUp(fader);

    await vi.waitFor(() => expect(onMutated).toHaveBeenCalled());
    expect(setRoleGain).toHaveBeenCalledTimes(1);
    expect(setRoleGain).toHaveBeenCalledWith("dialogue", -5.5);
    expect(clearRoleGainOverride).toHaveBeenCalledWith("dialogue");
    expect(updateRoleFlags).not.toHaveBeenCalled();
  });

  it("Escape restores the original sound and value without recording a command", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    const fader = faderFor("Dialogue");

    fireEvent.change(fader, { target: { value: "-6" } });
    expect(setRoleGainOverride).toHaveBeenCalledWith("dialogue", -6);

    fireEvent.keyDown(fader, { key: "Escape" });
    // Original sound restored (override dropped) and value snapped back.
    expect(clearRoleGainOverride).toHaveBeenCalledWith("dialogue");
    expect(fader.value).toBe("-3");

    // The pointer release that still follows the Escape must record nothing.
    fireEvent.pointerUp(fader);
    expect(setRoleGain).not.toHaveBeenCalled();
  });

  it("Escape outside a gesture is inert (no override churn, no command)", () => {
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.keyDown(faderFor("Dialogue"), { key: "Escape" });
    expect(clearRoleGainOverride).not.toHaveBeenCalled();
    expect(setRoleGain).not.toHaveBeenCalled();
  });
});

describe("RoleMixerPanel — master meter", () => {
  it("shows the real master RMS/Peak from the shared store, and no per-Role meter", () => {
    publishMasterMeter({ rmsDb: -18, peakDb: -6 });
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    const meter = screen.getByRole("group", { name: "Master output meter" });
    expect(within(meter).getByText("-18.0")).toBeTruthy();
    expect(within(meter).getByText("-6.0")).toBeTruthy();
    // Exactly one meter — the master. No per-Role meters were introduced.
    expect(screen.getAllByRole("group", { name: "Master output meter" })).toHaveLength(1);
  });

  it("reads silence as −∞ rather than a number", () => {
    publishMasterMeter({ rmsDb: -Infinity, peakDb: -Infinity });
    render(<RoleMixerPanel onMutated={vi.fn().mockResolvedValue(undefined)} />);

    const meter = screen.getByRole("group", { name: "Master output meter" });
    expect(within(meter).getAllByText("−∞")).toHaveLength(2);
  });
});
