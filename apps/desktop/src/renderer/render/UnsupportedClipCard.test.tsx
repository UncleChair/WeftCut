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

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, generateQuickProxy: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../state/proxyPreferenceStore", async (importActual) => {
  const actual = await importActual<typeof import("../state/proxyPreferenceStore")>();
  return { ...actual, setProxyOverride: vi.fn().mockResolvedValue(undefined) };
});

import { setAppSettings } from "../settings/appSettingsStore";
import { generateQuickProxy } from "../ipc";
import { setProxyOverride } from "../state/proxyPreferenceStore";
import { UnsupportedClipCard } from "./UnsupportedClipCard";

const MEDIA_ID = "media-123";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useDecodeComponentStore.setState({ available: false, reason: null, version: null, loaded: false });
});

describe("UnsupportedClipCard", () => {
  it("shows the Switch-to-Standard button when the ffmpeg component is available, and dispatches the patch on click", async () => {
    useDecodeComponentStore.setState({ available: true });
    render(<UnsupportedClipCard mediaId={MEDIA_ID} />);

    expect(screen.getByText("Unsupported format")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Switch to Standard" });
    await userEvent.click(button);

    expect(setAppSettings).toHaveBeenCalledWith({ decode_engine: "ffmpeg" });
  });

  it("shows the no-component body and no Switch-to-Standard button when the ffmpeg component is unavailable", () => {
    useDecodeComponentStore.setState({ available: false });
    render(<UnsupportedClipCard mediaId={MEDIA_ID} />);

    expect(
      screen.getByText(
        "This clip's format isn't supported by the Lite engine, and the Standard engine isn't installed.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch to Standard" })).toBeNull();
  });

  it("shows the Generate-proxy button regardless of component availability, and generates a proxy + sets the override on click", async () => {
    useDecodeComponentStore.setState({ available: false });
    render(<UnsupportedClipCard mediaId={MEDIA_ID} />);

    const button = screen.getByTestId("unsupported-generate-proxy");
    await userEvent.click(button);

    expect(generateQuickProxy).toHaveBeenCalledWith(MEDIA_ID);
    expect(setProxyOverride).toHaveBeenCalledWith(MEDIA_ID, true);
  });
});
