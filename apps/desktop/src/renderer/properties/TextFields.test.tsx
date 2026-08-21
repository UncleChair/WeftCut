// @vitest-environment jsdom
//
// The Text section's box surface: the segmented resize control, the two box
// extents, and the shrink notice. Pins the two things the mode control cannot
// get wrong — its selection is DERIVED from the box fields (so it tracks a gizmo
// drag or an MCP patch it never saw), and leaving Fixed nulls both axes in ONE
// patch (the mutation layer refuses `box_w: null` on its own).
//
// Drives the real `AttributePanel` with a fixture track, the panel-test
// convention in this folder, and the real `../i18n` — so a missing translation
// surfaces as a raw `property_panel.*` key in a query instead of passing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { LayerSummary, TrackSummary } from "../ipc";
import {
  clearGizmoProbe,
  registerGizmoProbe,
  type GizmoProbe,
} from "../preview/gizmoProbeRegistry";
import type { TextFit } from "../render/textBox";

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    updateLayer: vi.fn().mockResolvedValue(undefined),
    updateLayerParams: vi.fn().mockResolvedValue(undefined),
  };
});

import { updateLayerParams } from "../ipc";
import { AttributePanel } from "./PropertyPanel";
import { clearPropSectionMemory } from "./PropSection";

// Mock AppSwitch to a plain button so jsdom never hits Base UI's PointerEvent
// constructor — same convention as MotifFields.test.tsx.
vi.mock("../components/AppSwitch", () => ({
  AppSwitch: ({ checked, ariaLabel }: { checked: boolean; ariaLabel?: string }) => (
    <button role="switch" aria-checked={checked} aria-label={ariaLabel} />
  ),
}));

// jsdom has no PointerEvent; Base UI's Select reads MouseEvent's client coords.
(window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;

let installed: GizmoProbe | null = null;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearPropSectionMemory();
  if (installed) clearGizmoProbe(installed);
  installed = null;
});

/// Register a probe answering with a fixed measurement and/or fit. Omitting both
/// models the layer the compositor has not staged (playhead outside its span).
function installProbe(answers: {
  natural?: { w: number; h: number };
  fit?: TextFit;
}): void {
  installed = {
    canvasRect: () => null,
    naturalSizeOf: () => answers.natural ?? null,
    textFitOf: () => answers.fit ?? null,
  };
  registerGizmoProbe(installed);
}

type TextParamsFixture = Extract<LayerSummary["params"], { kind: "Text" }>;

const stat = <T,>(value: T) => ({ mode: "Static" as const, value });

function textTrack(box: Partial<TextParamsFixture>): TrackSummary {
  const params: TextParamsFixture = {
    kind: "Text",
    content: "Hello",
    font_family: "Liberation Sans",
    font_size_px: 72,
    weight: 400,
    italic: false,
    align: "Center",
    anchor_x: stat(0.5),
    anchor_y: stat(0.5),
    color: stat({ r: 255, g: 255, b: 255, a: 255 }),
    x: stat(960),
    y: stat(540),
    scale_x: stat(1),
    scale_y: stat(1),
    scale_linked: true,
    rotation_deg: stat(0),
    opacity: stat(1),
    outline: null,
    shadow: null,
    box_w: null,
    box_h: null,
    valign: "Middle",
    line_height: 0,
    letter_spacing: 0,
    ...box,
  };
  return {
    id: "track-t",
    kind: "Video",
    label: "V1",
    enabled: true,
    locked: false,
    muted: false,
    solo: false,
    role: null,
    transient: false,
    layers: [
      {
        id: "layer-t1",
        kind: "Text",
        label: "Title",
        t_start_us: 0,
        t_end_us: 2_000_000,
        enabled: true,
        locked: false,
        color_hint: "#000000",
        effects: [],
        params,
      } as LayerSummary,
    ],
  };
}

function renderTextPanel(box: Partial<TextParamsFixture> = {}) {
  const view = render(
    <AttributePanel
      tracks={[textTrack(box)]}
      selectedLayerId="layer-t1"
      onMutated={vi.fn().mockResolvedValue(undefined)}
      fpsNum={30}
      fpsDen={1}
      currentTimeUs={1_000_000}
    />,
  );
  const rerenderWith = (next: Partial<TextParamsFixture>) =>
    view.rerender(
      <AttributePanel
        tracks={[textTrack(next)]}
        selectedLayerId="layer-t1"
        onMutated={vi.fn().mockResolvedValue(undefined)}
        fpsNum={30}
        fpsDen={1}
        currentTimeUs={1_000_000}
      />,
    );
  return { section: screen.getByRole("region", { name: "Text" }), rerenderWith };
}

const pressed = (section: HTMLElement): string[] =>
  within(section)
    .getAllByRole("button", { pressed: true })
    .map((b) => b.textContent ?? "");

describe("Text box resize mode", () => {
  it("derives its selection from the box fields, one mode per nullability", () => {
    installProbe({ natural: { w: 400, h: 90 } });

    const auto = renderTextPanel({ box_w: null, box_h: null });
    expect(pressed(auto.section)).toEqual(["Auto width"]);
    cleanup();

    const height = renderTextPanel({ box_w: 600, box_h: null });
    expect(pressed(height.section)).toEqual(["Auto height"]);
    cleanup();

    const fixed = renderTextPanel({ box_w: 600, box_h: 200 });
    expect(pressed(fixed.section)).toEqual(["Fixed"]);
  });

  it("follows the box fields when a gizmo drag or an MCP patch moves them behind the panel's back", () => {
    installProbe({ natural: { w: 400, h: 90 } });
    const { section, rerenderWith } = renderTextPanel({ box_w: null, box_h: null });
    expect(pressed(section)).toEqual(["Auto width"]);

    // An edge drag lands a width; no mode was ever written, so re-deriving is
    // the only reason the control agrees.
    rerenderWith({ box_w: 600, box_h: null });
    expect(pressed(screen.getByRole("region", { name: "Text" }))).toEqual(["Auto height"]);

    rerenderWith({ box_w: 600, box_h: 200 });
    expect(pressed(screen.getByRole("region", { name: "Text" }))).toEqual(["Fixed"]);
  });

  it("reads the illegal (null, set) pair as auto width, matching what the sprite renders", () => {
    installProbe({ natural: { w: 400, h: 90 } });
    const { section } = renderTextPanel({ box_w: null, box_h: 200 });
    expect(pressed(section)).toEqual(["Auto width"]);
  });

  it("leaves Fixed for auto width with ONE patch nulling both axes", async () => {
    const user = userEvent.setup();
    installProbe({ natural: { w: 600, h: 200 } });
    const { section } = renderTextPanel({ box_w: 600, box_h: 200 });

    await user.click(within(section).getByRole("button", { name: "Auto width" }));

    // `{ box_w: null }` alone is a refusal on a Fixed layer — the pair IS the
    // exit, and one patch is one undo entry.
    expect(updateLayerParams).toHaveBeenCalledTimes(1);
    expect(updateLayerParams).toHaveBeenCalledWith("layer-t1", {
      kind: "Text",
      box_w: null,
      box_h: null,
    });
  });

  it("leaves Fixed for auto height keeping the committed width", async () => {
    const user = userEvent.setup();
    installProbe({ natural: { w: 600, h: 200 } });
    const { section } = renderTextPanel({ box_w: 600, box_h: 200 });

    await user.click(within(section).getByRole("button", { name: "Auto height" }));

    expect(updateLayerParams).toHaveBeenCalledTimes(1);
    expect(updateLayerParams).toHaveBeenCalledWith("layer-t1", {
      kind: "Text",
      box_w: 600,
      box_h: null,
    });
  });

  it("enters Fixed from auto width by deriving both axes from the measured size", async () => {
    const user = userEvent.setup();
    installProbe({ natural: { w: 420.4, h: 96.6 } });
    const { section } = renderTextPanel({ box_w: null, box_h: null });

    await user.click(within(section).getByRole("button", { name: "Fixed" }));

    expect(updateLayerParams).toHaveBeenCalledWith("layer-t1", {
      kind: "Text",
      box_w: 420,
      box_h: 97,
    });
  });

  it("re-selecting the current mode commits nothing", async () => {
    const user = userEvent.setup();
    installProbe({ natural: { w: 600, h: 200 } });
    const { section } = renderTextPanel({ box_w: 600, box_h: 200 });

    await user.click(within(section).getByRole("button", { name: "Fixed" }));

    expect(updateLayerParams).not.toHaveBeenCalled();
  });

  it("offers an unmeasurable mode as disabled instead of committing 0 or NaN", () => {
    // Nothing staged for the layer: auto width still needs no number, the two
    // box modes have nowhere to get one.
    const { section } = renderTextPanel({ box_w: null, box_h: null });
    expect(within(section).getByRole("button", { name: "Auto width" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(within(section).getByRole("button", { name: "Auto height" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(section).getByRole("button", { name: "Fixed" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("keeps auto height reachable without a probe once a width is committed", () => {
    const { section } = renderTextPanel({ box_w: 600, box_h: 200 });
    expect(within(section).getByRole("button", { name: "Auto height" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});

describe("Text box extents", () => {
  it("disables each axis in the modes where it is auto", () => {
    installProbe({ natural: { w: 600, h: 200 } });

    const auto = renderTextPanel({ box_w: null, box_h: null });
    expect(within(auto.section).getByLabelText("Box width")).toHaveProperty("disabled", true);
    expect(within(auto.section).getByLabelText("Box height")).toHaveProperty("disabled", true);
    cleanup();

    const height = renderTextPanel({ box_w: 600, box_h: null });
    expect(within(height.section).getByLabelText("Box width")).toHaveProperty("disabled", false);
    expect(within(height.section).getByLabelText("Box height")).toHaveProperty("disabled", true);
    cleanup();

    const fixed = renderTextPanel({ box_w: 600, box_h: 200 });
    expect(within(fixed.section).getByLabelText("Box width")).toHaveProperty("disabled", false);
    expect(within(fixed.section).getByLabelText("Box height")).toHaveProperty("disabled", false);
  });

  it("shows the committed extents and commits an edit on Enter", async () => {
    const user = userEvent.setup();
    installProbe({ natural: { w: 600, h: 200 } });
    const { section } = renderTextPanel({ box_w: 600, box_h: 200 });
    const width = within(section).getByLabelText("Box width") as HTMLInputElement;
    expect(width.value).toBe("600");

    await user.click(width);
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(width.value).toBe("601"));
    await user.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-t1", { kind: "Text", box_w: 601 }),
    );
  });

  it("does not resync a focused extent from a round trip landing mid-edit", async () => {
    const user = userEvent.setup();
    installProbe({ natural: { w: 600, h: 200 } });
    const { section, rerenderWith } = renderTextPanel({ box_w: 600, box_h: 200 });
    const width = within(section).getByLabelText("Box width") as HTMLInputElement;

    await user.click(width);
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(width.value).toBe("601"));
    // A stale snapshot arrives while the field is focused. The section-wide
    // editing gate must keep the in-progress number.
    rerenderWith({ box_w: 900, box_h: 200 });
    expect(width.value).toBe("601");
  });
});

/// Open a Base UI Select by keyboard, NOT `user.click` — a click on the trigger
/// opens the popup only for the first Select touched in a test file (the landmine
/// is documented in ExportSettingsDialog.test.tsx).
async function openSelect(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  trigger.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
}

describe("Text block placement, leading and tracking", () => {
  it("renders BOTH placement axes in the Text section while the anchor pair stays in Transform", () => {
    installProbe({ natural: { w: 600, h: 200 } });
    const { section } = renderTextPanel({ align: "Right", valign: "Bottom" });
    // The two halves of the pair, side by side and showing the committed values.
    expect(within(section).getByRole("combobox", { name: "Horizontal align" }).textContent).toBe(
      "Right",
    );
    expect(within(section).getByRole("combobox", { name: "Vertical align" }).textContent).toBe(
      "Bottom",
    );
    // The section split is the disambiguation: block-inside-box here,
    // box-against-x/y over there, and never the same section.
    expect(within(section).queryByLabelText("Anchor X")).toBeNull();
    expect(within(section).queryByLabelText("Anchor Y")).toBeNull();
    const transform = screen.getByRole("region", { name: "Transform" });
    expect(within(transform).queryByRole("combobox", { name: "Horizontal align" })).toBeNull();
    expect(within(transform).queryByRole("combobox", { name: "Vertical align" })).toBeNull();
  });

  it("commits align as a plain enum, no measurement involved", async () => {
    const user = userEvent.setup();
    installProbe({ natural: { w: 600, h: 200 } });
    const { section } = renderTextPanel({ align: "Center" });

    await openSelect(user, within(section).getByRole("combobox", { name: "Horizontal align" }));
    await user.pointer({ target: screen.getByRole("option", { name: "Left" }), keys: "[MouseLeft]" });

    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-t1", { kind: "Text", align: "Left" }),
    );
    expect(updateLayerParams).toHaveBeenCalledTimes(1);
  });

  it("commits leading and tracking as scalars", async () => {
    const user = userEvent.setup();
    installProbe({ natural: { w: 600, h: 200 } });
    const { section } = renderTextPanel({ line_height: 80, letter_spacing: 0 });

    const leading = within(section).getByLabelText("Line height (px)") as HTMLInputElement;
    expect(leading.value).toBe("80");
    await user.click(leading);
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-t1", { kind: "Text", line_height: 81 }),
    );

    const tracking = within(section).getByLabelText("Letter spacing (px)") as HTMLInputElement;
    await user.click(tracking);
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-t1", {
        kind: "Text",
        letter_spacing: 0.5,
      }),
    );
  });
});

describe("Shrink notice", () => {
  const notice = () => screen.queryByTestId("text-shrink-notice");

  it("reports the size the canvas rendered, not the authored one", async () => {
    installProbe({
      natural: { w: 600, h: 200 },
      fit: { authoredPx: 72, effectivePx: 31, overflowing: false },
    });
    renderTextPanel({ box_w: 600, box_h: 200 });
    await waitFor(() => expect(notice()?.textContent).toBe("auto-reduced to 31 px"));
  });

  it("changes wording once the floor is hit and the text genuinely overflows", async () => {
    installProbe({
      natural: { w: 600, h: 200 },
      fit: { authoredPx: 72, effectivePx: 8, overflowing: true },
    });
    renderTextPanel({ box_w: 600, box_h: 200 });
    await waitFor(() => expect(notice()?.textContent).toBe("overflowing — floored at 8 px"));
  });

  it("stays absent — not NaN — for a layer whose sprite is not staged", async () => {
    renderTextPanel({ box_w: 600, box_h: 200 });
    // Give the sampler several frames to prove it never invents a number.
    await new Promise((r) => setTimeout(r, 50));
    expect(notice()).toBeNull();
    expect(screen.getByRole("region", { name: "Text" }).textContent).not.toContain("NaN");
  });

  it("stays absent when the box already fits", async () => {
    installProbe({
      natural: { w: 600, h: 200 },
      fit: { authoredPx: 72, effectivePx: 72, overflowing: false },
    });
    renderTextPanel({ box_w: 600, box_h: 200 });
    await new Promise((r) => setTimeout(r, 50));
    expect(notice()).toBeNull();
  });

  it("disappears when Fixed is left for auto height, even with a stale shrunk fit", async () => {
    // Shrink belongs to Fixed alone, so leaving it must drop the notice on the
    // panel's own authority rather than waiting for the sprite to restage.
    installProbe({
      natural: { w: 600, h: 200 },
      fit: { authoredPx: 72, effectivePx: 31, overflowing: false },
    });
    const { rerenderWith } = renderTextPanel({ box_w: 600, box_h: 200 });
    await waitFor(() => expect(notice()).not.toBeNull());

    rerenderWith({ box_w: 600, box_h: null });
    await waitFor(() => expect(notice()).toBeNull());
  });
});

describe("i18n", () => {
  it("renders no raw translation keys in the Text section", () => {
    installProbe({ natural: { w: 600, h: 200 } });
    const { section } = renderTextPanel({ box_w: 600, box_h: 200 });
    expect(section.textContent).not.toMatch(/property_panel\./);
  });
});
