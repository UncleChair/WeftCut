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
  ],
}));

import { RoleMixerPanel } from "./RoleMixerPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RoleMixerPanel boundary", () => {
  it("renders independently and keeps existing Audio Role edits wired", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<RoleMixerPanel onMutated={onMutated} />);

    expect(screen.getByRole("region", { name: "Mixer" })).toBeTruthy();
    expect(screen.getByText("Dialogue")).toBeTruthy();
    expect(screen.getByText("Music")).toBeTruthy();

    const gain = screen.getByLabelText("Dialogue gain (dB)");
    fireEvent.change(gain, { target: { value: "-6" } });
    fireEvent.blur(gain);
    await vi.waitFor(() => expect(setRoleGain).toHaveBeenCalledWith("dialogue", -6));

    fireEvent.click(screen.getAllByLabelText("Mute this role everywhere")[0]!);
    await vi.waitFor(() =>
      expect(updateRoleFlags).toHaveBeenCalledWith("dialogue", { muted: true }),
    );
    expect(onMutated).toHaveBeenCalledTimes(2);
  });
});
