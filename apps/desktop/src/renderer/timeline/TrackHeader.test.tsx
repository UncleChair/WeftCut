// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import "../i18n"; // real en-US bundle, so a derived lane name is the shipped string
import type { TrackSummary } from "../ipc";
import { TrackHeader } from "./TrackHeader";
import { endRename } from "./renameStore";

const ipcMocks = vi.hoisted(() => ({
  renameTrack: vi.fn().mockResolvedValue(undefined),
  updateTrackFlags: vi.fn().mockResolvedValue(undefined),
}));

// Only the two commands the header issues are stubbed; every other ipc export
// (types, helpers) stays real.
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return { ...actual, renameTrack: ipcMocks.renameTrack, updateTrackFlags: ipcMocks.updateTrackFlags };
});

function track(partial: Partial<TrackSummary> = {}): TrackSummary {
  return {
    id: "T1",
    kind: "Video",
    label: null,
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: true,
    layers: [],
    ...partial,
  };
}

function renderHeader(t: TrackSummary, onMutated = vi.fn().mockResolvedValue(undefined)) {
  const view = render(
    <TrackHeader
      track={t}
      height={56}
      isRevealed={false}
      isGroupStart={false}
      isExpanded={false}
      hasKeyframes={false}
      onToggleExpand={vi.fn()}
      onMutated={onMutated}
    />,
  );
  return { ...view, onMutated };
}

/// The header's name cell — the double-click target, and what the input replaces.
const nameCell = (container: HTMLElement): HTMLElement =>
  container.querySelector('[data-testid="track-header-name"]') as HTMLElement;
const input = (container: HTMLElement): HTMLInputElement | null =>
  container.querySelector("input") as HTMLInputElement | null;

describe("TrackHeader inline rename", () => {
  beforeEach(() => {
    endRename(); // the store is module-global; a leaked edit would open every header
    ipcMocks.renameTrack.mockClear();
    ipcMocks.updateTrackFlags.mockClear();
  });
  afterEach(() => {
    cleanup();
    endRename();
  });

  it("double-click opens an edit seeded with the stored name; Enter commits it", async () => {
    const { container, onMutated } = renderHeader(track({ label: "Titles" }));
    expect(nameCell(container).textContent).toBe("Titles");

    fireEvent.doubleClick(nameCell(container));
    const field = input(container)!;
    expect(field.value).toBe("Titles");

    fireEvent.change(field, { target: { value: "Lower thirds" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(onMutated).toHaveBeenCalled());
    // Exactly once: Enter ends the edit, so the unmounting input cannot commit
    // a second time and cost the editor two undo presses for one rename.
    expect(ipcMocks.renameTrack).toHaveBeenCalledExactlyOnceWith("T1", "Lower thirds");
    expect(input(container)).toBeNull(); // the edit closed
  });

  it("Escape abandons the edit — no command, and the name still reads as before", () => {
    const { container } = renderHeader(track({ label: "Titles" }));
    fireEvent.doubleClick(nameCell(container));
    fireEvent.change(input(container)!, { target: { value: "Discarded" } });
    fireEvent.keyDown(input(container)!, { key: "Escape" });

    expect(ipcMocks.renameTrack).not.toHaveBeenCalled();
    expect(input(container)).toBeNull();
    expect(nameCell(container).textContent).toBe("Titles");
  });

  it("clicking away commits, the same as Enter", async () => {
    const { container } = renderHeader(track({ label: "Titles" }));
    fireEvent.doubleClick(nameCell(container));
    fireEvent.change(input(container)!, { target: { value: "Overlays" } });
    fireEvent.blur(input(container)!);

    await waitFor(() => expect(ipcMocks.renameTrack).toHaveBeenCalledWith("T1", "Overlays"));
  });

  // The lane's half of ADR 0042: an emptied field is a request for the DERIVED
  // name, not an abandoned edit (which is what it means for a layer).
  it.each(["", "   "])("clearing the field to %o writes null", async (blank) => {
    const { container } = renderHeader(track({ label: "Titles" }));
    fireEvent.doubleClick(nameCell(container));
    fireEvent.change(input(container)!, { target: { value: blank } });
    fireEvent.keyDown(input(container)!, { key: "Enter" });

    await waitFor(() => expect(ipcMocks.renameTrack).toHaveBeenCalledWith("T1", null));
  });

  it("commits nothing when the name comes back unchanged", () => {
    const { container } = renderHeader(track({ label: "Titles" }));
    fireEvent.doubleClick(nameCell(container));
    fireEvent.keyDown(input(container)!, { key: "Enter" });
    expect(ipcMocks.renameTrack).not.toHaveBeenCalled();
  });

  // The skeleton is not a special case to work around: a reserved lane shows its
  // role-derived name and still opens the same edit, seeded EMPTY — the derived
  // name is not a value the editor is editing.
  it("renames a reserved A-roll lane, whose derived name seeds no draft", async () => {
    const { container } = renderHeader(track({ id: "A", role: "a-roll", transient: false }));
    expect(nameCell(container).textContent).toBe("A roll");

    fireEvent.doubleClick(nameCell(container));
    expect(input(container)!.value).toBe("");
    fireEvent.change(input(container)!, { target: { value: "Interview" } });
    fireEvent.keyDown(input(container)!, { key: "Enter" });

    await waitFor(() => expect(ipcMocks.renameTrack).toHaveBeenCalledWith("A", "Interview"));
  });

  it("the context menu's Rename opens the very same edit", async () => {
    const { container } = renderHeader(track({ label: "Titles" }));
    fireEvent.contextMenu(nameCell(container), { clientX: 40, clientY: 12 });

    const item = await waitFor(() => {
      const found = document.querySelector(".app-menu-item") as HTMLElement | null;
      expect(found).not.toBeNull();
      return found!;
    });
    expect(item.textContent).toBe("Rename");

    fireEvent.click(item);
    await waitFor(() => expect(input(container)!.value).toBe("Titles"));
  });

  // Undo must never flip a control the editor set, which is a property of the
  // flags riding the UNRECORDED channel. Renaming must not have quietly joined
  // the name to that patch: the two commands stay separate on the wire.
  it("keeps the name off the unrecorded flags channel", async () => {
    const { container } = renderHeader(track({ label: "Titles" }));
    fireEvent.doubleClick(nameCell(container));
    fireEvent.change(input(container)!, { target: { value: "Overlays" } });
    fireEvent.keyDown(input(container)!, { key: "Enter" });

    await waitFor(() => expect(ipcMocks.renameTrack).toHaveBeenCalled());
    expect(ipcMocks.updateTrackFlags).not.toHaveBeenCalled();
  });
});
