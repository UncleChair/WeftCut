// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PropSection, clearPropSectionMemory } from "./PropSection";

afterEach(() => {
  cleanup();
  clearPropSectionMemory();
});

function renderSection(
  props: Partial<Parameters<typeof PropSection>[0]> = {},
) {
  return render(
    <PropSection layerKind="VideoClip" sectionId="envelope" title="Layer" {...props}>
      <p>section body</p>
    </PropSection>,
  );
}

describe("PropSection collapse defaults", () => {
  it("renders its children by default", () => {
    renderSection();
    expect(screen.getByText("section body")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Layer" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("does not mount children when defaultCollapsed", () => {
    renderSection({ defaultCollapsed: true });
    expect(screen.queryByText("section body")).toBeNull();
    expect(screen.getByRole("button", { name: "Layer" }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("PropSection toggle", () => {
  it("mounts and unmounts children as the header is clicked", () => {
    renderSection({ defaultCollapsed: true });
    const header = screen.getByRole("button", { name: "Layer" });

    fireEvent.click(header);
    expect(screen.getByText("section body")).toBeTruthy();
    expect(header.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(header);
    expect(screen.queryByText("section body")).toBeNull();
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("PropSection session memory", () => {
  it("remembers an override per layer kind across remounts", () => {
    // Expand the advanced bucket on one Video layer…
    const first = renderSection({ sectionId: "advanced", title: "Advanced", defaultCollapsed: true });
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByText("section body")).toBeTruthy();
    first.unmount();

    // …another Video layer keeps it expanded…
    const second = renderSection({ sectionId: "advanced", title: "Advanced", defaultCollapsed: true });
    expect(screen.getByText("section body")).toBeTruthy();
    second.unmount();

    // …but a Text layer still gets the collapsed default.
    renderSection({ layerKind: "Text", sectionId: "advanced", title: "Advanced", defaultCollapsed: true });
    expect(screen.queryByText("section body")).toBeNull();
  });

  it("re-derives the collapsed state when the layer kind changes on a mounted section", () => {
    const { rerender } = render(
      <PropSection layerKind="VideoClip" sectionId="advanced" title="Advanced" defaultCollapsed>
        <p>section body</p>
      </PropSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByText("section body")).toBeTruthy();

    // Same component instance, new kind: the Video expansion must not leak.
    rerender(
      <PropSection layerKind="Text" sectionId="advanced" title="Advanced" defaultCollapsed>
        <p>section body</p>
      </PropSection>,
    );
    expect(screen.queryByText("section body")).toBeNull();

    // …and switching back to Video recalls its stored override.
    rerender(
      <PropSection layerKind="VideoClip" sectionId="advanced" title="Advanced" defaultCollapsed>
        <p>section body</p>
      </PropSection>,
    );
    expect(screen.getByText("section body")).toBeTruthy();
  });
});
