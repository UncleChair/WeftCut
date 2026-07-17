// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "../i18n";

vi.mock("../state/playheadStore", () => ({
  usePlayheadTimeUsThrottled: () => 0,
}));

vi.mock("./AttributePanel", () => ({
  AttributePanel: () => <div>Attribute content</div>,
}));

vi.mock("./EffectPanel", () => ({
  EffectPanel: () => <div>Effect content</div>,
}));

vi.mock("./CaptionPanel", () => ({
  CaptionPanel: () => <input aria-label="Caption draft" defaultValue="" />,
}));

vi.mock("./RoleMixerPanel", () => ({
  RoleMixerPanel: () => <div>Audio content</div>,
}));

vi.mock("./NearbyPanel", () => ({
  NearbyPanel: ({
    onPick,
  }: {
    onPick: (layerId: string, trackId: string) => void;
  }) => (
    <section aria-label="Nearby panel">
      <button type="button" onClick={() => onPick("layer-1", "track-1")}>
        Near layer
      </button>
    </section>
  ),
}));

import { RightPanel } from "./RightPanel";

afterEach(() => cleanup());

function renderPanel() {
  const onSelect = vi.fn();
  const onRevealTrack = vi.fn();
  const view = render(
    <RightPanel
      tracks={[]}
      groups={[]}
      selectedLayerId={null}
      onSelect={onSelect}
      onMutated={async () => {}}
      fpsNum={30}
      fpsDen={1}
      onRevealTrack={onRevealTrack}
    />,
  );
  return { ...view, onSelect, onRevealTrack };
}

describe("RightPanel tabs", () => {
  it("keeps Nearby above three tool tabs and starts on Properties", () => {
    renderPanel();

    expect(screen.getByRole("region", { name: "Nearby panel" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /Nearby/ })).toBeNull();
    expect(
      screen.getByRole("tab", { name: "Properties" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "Captions" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Audio" })).toBeTruthy();
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getByText("Attribute content")).toBeTruthy();
    expect(screen.getByText("Effect content")).toBeTruthy();
  });

  it("switches panels without unmounting an inactive panel's draft state", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: "Captions" }));
    const draft = screen.getByLabelText("Caption draft") as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "Keep this edit" } });

    fireEvent.click(screen.getByRole("tab", { name: "Audio" }));
    expect(screen.getByText("Audio content")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Captions" }));

    expect((screen.getByLabelText("Caption draft") as HTMLInputElement).value).toBe(
      "Keep this edit",
    );
    expect(
      screen.getByRole("tab", { name: "Captions" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("returns to Properties and reveals the track after a Nearby pick", () => {
    const { onSelect, onRevealTrack } = renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Captions" }));

    fireEvent.click(screen.getByRole("button", { name: "Near layer" }));

    expect(onSelect).toHaveBeenCalledWith("layer-1");
    expect(onRevealTrack).toHaveBeenCalledWith("track-1", "layer-1");
    expect(
      screen.getByRole("tab", { name: "Properties" }).getAttribute("aria-selected"),
    ).toBe("true");
  });
});
