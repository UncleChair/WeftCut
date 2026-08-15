// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import "../i18n";

import type { ProjectSummary } from "../ipc";

const mocks = vi.hoisted(() => ({
  renameMarker: vi.fn(),
  logEmit: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    renameMarker: mocks.renameMarker,
    logEmit: mocks.logEmit,
  };
});

import { useProjectStore } from "../state/projectStore";
import { MarkerRenameDialog } from "./MarkerRenameDialog";
import {
  closeMarkerRenamePrompt,
  openMarkerRenamePrompt,
  useMarkerRenamePromptStore,
} from "./markerRenamePrompt";

function seedMarker(id: string, label: string): void {
  useProjectStore.setState({
    summary: {
      markers: [
        { id, t_us: 80_000, end_t_us: null, label, color_hint: "#0080ff" },
      ],
    } as unknown as ProjectSummary,
  });
}

function input(): HTMLInputElement {
  return screen.getByLabelText("Marker label") as HTMLInputElement;
}

describe("MarkerRenameDialog", () => {
  beforeEach(() => {
    mocks.renameMarker.mockReset().mockResolvedValue(undefined);
    useProjectStore.setState({ summary: null });
    closeMarkerRenamePrompt();
  });
  afterEach(cleanup);

  it("renders nothing while no marker is being renamed", () => {
    render(<MarkerRenameDialog />);
    expect(screen.queryByText("Rename Marker")).toBeNull();
  });

  it("opens prefilled with the marker's current label", () => {
    seedMarker("marker-1", "cut here");
    render(<MarkerRenameDialog />);
    act(() => openMarkerRenamePrompt("marker-1"));
    expect(screen.getByText("Rename Marker")).toBeTruthy();
    expect(input().value).toBe("cut here");
  });

  it("gates confirm on a non-empty label", () => {
    seedMarker("marker-1", "cut here");
    render(<MarkerRenameDialog />);
    act(() => openMarkerRenamePrompt("marker-1"));
    fireEvent.change(input(), { target: { value: "   " } });
    expect(
      (screen.getByText("Rename") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mocks.renameMarker).not.toHaveBeenCalled();
  });

  it("Enter submits the trimmed label and closes", async () => {
    seedMarker("marker-1", "");
    render(<MarkerRenameDialog />);
    act(() => openMarkerRenamePrompt("marker-1"));
    fireEvent.change(input(), { target: { value: "  needs VO  " } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await vi.waitFor(() => {
      expect(useMarkerRenamePromptStore.getState().markerId).toBeNull();
    });
    expect(mocks.renameMarker).toHaveBeenCalledExactlyOnceWith(
      "marker-1",
      "needs VO",
    );
  });

  it("a refusal keeps the dialog open with the typed label intact", async () => {
    seedMarker("marker-1", "old");
    mocks.renameMarker.mockRejectedValue({
      error: "MarkerNotFound",
      marker: "marker-1",
    });
    render(<MarkerRenameDialog />);
    act(() => openMarkerRenamePrompt("marker-1"));
    fireEvent.change(input(), { target: { value: "new name" } });
    fireEvent.click(screen.getByText("Rename"));
    await vi.waitFor(() => {
      expect(mocks.renameMarker).toHaveBeenCalled();
    });
    expect(useMarkerRenamePromptStore.getState().markerId).toBe("marker-1");
    expect(input().value).toBe("new name");
  });

  it("cancel closes without committing", () => {
    seedMarker("marker-1", "cut here");
    render(<MarkerRenameDialog />);
    act(() => openMarkerRenamePrompt("marker-1"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(useMarkerRenamePromptStore.getState().markerId).toBeNull();
    expect(mocks.renameMarker).not.toHaveBeenCalled();
  });
});
