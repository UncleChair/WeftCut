// @vitest-environment jsdom
//
// Covers the "Preview" Settings section (PreviewSection.tsx): the decode
// engine radio cards and the playback resolution three-stop slider. The
// app-settings store and decode-component store are stubbed at the module
// boundary so each test drives exactly one state combination.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const stores = vi.hoisted(() => ({
  setAppSettings: vi.fn(),
  decodeEngine: "auto" as "auto" | "ffmpeg" | "webcodecs",
  playbackResolution: "full" as "full" | "half" | "quarter",
  componentAvailable: true,
  componentReason: null as string | null,
}));

vi.mock("./appSettingsStore", () => ({
  setAppSettings: stores.setAppSettings,
  useDecodeEngine: () => stores.decodeEngine,
  usePlaybackResolution: () => stores.playbackResolution,
}));

vi.mock("./decodeComponentStore", () => ({
  useDecodeComponentAvailable: () => stores.componentAvailable,
  useDecodeComponentReason: () => stores.componentReason,
}));

import i18n from "../i18n";
import { PreviewSection } from "./PreviewSection";

// jsdom has no PointerEvent constructor; MouseEvent carries the same client
// coordinates Base UI's radio click handler reads.
(window as unknown as { PointerEvent: unknown }).PointerEvent =
  window.MouseEvent;

const onError = vi.fn();

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  onError.mockReset();
  stores.setAppSettings.mockReset().mockResolvedValue({});
  stores.decodeEngine = "auto";
  stores.playbackResolution = "full";
  stores.componentAvailable = true;
  stores.componentReason = null;
});

describe("PreviewSection", () => {
  it("shows every engine card with its one-line trade-off", () => {
    render(<PreviewSection onError={onError} />);

    expect(
      screen.getByRole("radiogroup", { name: "Decode engine" }),
    ).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Automatic/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Standard/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Lite/ })).toBeTruthy();
    expect(screen.getByText("Picks the best engine for each clip")).toBeTruthy();
    expect(
      screen.getByText("Decodes every format, accurate colors"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Lighter on resources; supports fewer formats; colors may be slightly off",
      ),
    ).toBeTruthy();
  });

  it("shows the resolution as a three-stop slider with end captions", () => {
    render(<PreviewSection onError={onError} />);

    const slider = screen.getByRole("slider", { name: "Playback resolution" });
    expect(slider.getAttribute("aria-valuenow")).toBe("2");
    expect(slider.getAttribute("aria-valuetext")).toBe("Full");
    // End captions + one tick label per stop.
    expect(screen.getByText("Smooth")).toBeTruthy();
    expect(screen.getByText("Sharp")).toBeTruthy();
    expect(screen.getByText("1/4")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByText("Full")).toBeTruthy();
  });

  it("applies a new engine on card click", async () => {
    render(<PreviewSection onError={onError} />);

    await userEvent.click(screen.getByRole("radio", { name: /Lite/ }));
    expect(stores.setAppSettings).toHaveBeenCalledWith({
      decode_engine: "webcodecs",
    });
  });

  it("applies a new resolution on keyboard step", async () => {
    render(<PreviewSection onError={onError} />);

    const slider = screen.getByRole("slider", { name: "Playback resolution" });
    slider.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(stores.setAppSettings).toHaveBeenCalledWith({
      playback_resolution: "half",
    });
  });

  it("disables the Standard card with the reason when its component is missing", async () => {
    stores.componentAvailable = false;
    stores.componentReason = "component not installed";
    render(<PreviewSection onError={onError} />);

    const standard = screen.getByRole("radio", { name: /Standard/ });
    expect(standard.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText(/Standard engine unavailable: component not installed/),
    ).toBeTruthy();

    await userEvent.click(standard);
    expect(stores.setAppSettings).not.toHaveBeenCalled();
  });

  it("reports a failed patch through onError", async () => {
    stores.setAppSettings.mockRejectedValue(new Error("disk write failed"));
    render(<PreviewSection onError={onError} />);

    await userEvent.click(screen.getByRole("radio", { name: /Lite/ }));
    expect(onError).toHaveBeenCalledWith("Error: disk write failed");
  });
});
