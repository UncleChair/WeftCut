// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n"; // initialize i18next so useTranslation() resolves real strings
import { useDecodeComponentStore } from "../settings/decodeComponentStore";

vi.mock("../settings/appSettingsStore", async (importActual) => {
  const actual = await importActual<typeof import("../settings/appSettingsStore")>();
  return { ...actual, setAppSettings: vi.fn().mockResolvedValue(undefined) };
});

import { setAppSettings } from "../settings/appSettingsStore";
import { UnsupportedClipCard } from "./UnsupportedClipCard";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useDecodeComponentStore.setState({ available: false, reason: null, version: null, loaded: false });
});

describe("UnsupportedClipCard", () => {
  it("shows the Switch-to-Standard button when the ffmpeg component is available, and dispatches the patch on click", async () => {
    useDecodeComponentStore.setState({ available: true });
    render(<UnsupportedClipCard />);

    expect(screen.getByText("Unsupported format")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Switch to Standard" });
    await userEvent.click(button);

    expect(setAppSettings).toHaveBeenCalledWith({ decode_engine: "ffmpeg" });
  });

  it("shows the no-component body and no button when the ffmpeg component is unavailable", () => {
    useDecodeComponentStore.setState({ available: false });
    render(<UnsupportedClipCard />);

    expect(
      screen.getByText(
        "This clip's format isn't supported by the Lite engine, and the Standard engine isn't installed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch to Standard" })).toBeNull();
  });
});
