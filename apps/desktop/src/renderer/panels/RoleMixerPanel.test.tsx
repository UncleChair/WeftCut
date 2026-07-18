// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../i18n";

const { setRoleGain, updateRoleFlags } = vi.hoisted(() => ({
  setRoleGain: vi.fn().mockResolvedValue(undefined),
  updateRoleFlags: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, setRoleGain, updateRoleFlags };
});

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
