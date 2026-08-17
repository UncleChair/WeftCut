// @vitest-environment jsdom
//
// Integration coverage for the Motif fallback form: schema in → fields out →
// commits out. Pins the panel-side commit contract — every field edit lands as
// ONE `updateLayerParams` patch carrying ONLY the changed key (the state
// actor's key-wise props merge depends on that), string/number commit on
// blur/Enter, enum commits immediately, color commits debounced. Also pins the
// panel's 7-char color truncation: an 8-digit prop value displays and commits
// without its alpha byte.
//
// Field queries use case-insensitive `.`-separator patterns (e.g. /^bg.color$/i)
// so they match the label whether it renders as the raw prop key or its
// Title Case form — the queries pin wiring and commit shape, not label cosmetics.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { LayerSummary, TrackSummary } from "../ipc";

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return {
    ...actual,
    updateLayer: vi.fn().mockResolvedValue(undefined),
    updateLayerParams: vi.fn().mockResolvedValue(undefined),
  };
});

import { updateLayerParams } from "../ipc";
import { setUserMotifs, type MotifManifest } from "../render/motifs/catalog";
import { clearPropSectionMemory } from "./PropSection";

// Mock AppSwitch to a plain button so jsdom never hits Base UI's PointerEvent
// constructor — same convention as panels/AttributePanel.test.tsx.
vi.mock("../components/AppSwitch", () => ({
  AppSwitch: ({ checked, onCheckedChange, ariaLabel, disabled }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

import { AttributePanel } from "./PropertyPanel";

// jsdom has no PointerEvent; Base UI's Select reads MouseEvent's client coords.
(window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  clearPropSectionMemory();
  setUserMotifs([]);
});

// One prop per PropSpec variant, plus a second number so BOTH sides of the
// step heuristic (≤10-wide range → 0.1, otherwise 1) are exercised.
const TEST_MANIFEST: MotifManifest = {
  id: "test-props-motif",
  name: "Test Props",
  version: 1,
  size: [640, 360],
  default_duration_s: 5,
  status: "installed",
  props_schema: {
    title: { type: "string", default: "Hello", max_length: 40 },
    bg_color: { type: "color", default: "#00000000" },
    speed: { type: "number", default: 1, min: 0, max: 4 },
    count: { type: "number", default: 50, min: 0, max: 100 },
    effect: { type: "enum", default: "karaoke", options: ["typewriter", "karaoke"] },
  },
};

function motifTrack(motifId: string, props: Record<string, unknown>): TrackSummary {
  return {
    id: "track-m",
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
        id: "layer-m1",
        kind: "Motif",
        label: "Badge",
        t_start_us: 0,
        t_end_us: 2_000_000,
        enabled: true,
        locked: false,
        color_hint: "#000000",
        effects: [],
        params: {
          kind: "Motif",
          motif_id: motifId,
          x: { mode: "Static", value: 0 },
          y: { mode: "Static", value: 0 },
          scale_x: { mode: "Static", value: 1 },
          scale_y: { mode: "Static", value: 1 },
          scale_linked: true,
          rotation_deg: { mode: "Static", value: 0 },
          anchor_x: { mode: "Static", value: 0.5 },
          anchor_y: { mode: "Static", value: 0.5 },
          opacity: { mode: "Static", value: 1 },
          src_in_us: 0,
          props,
        },
      } as LayerSummary,
    ],
  };
}

const DEFAULT_PROPS = {
  title: "Hello",
  bg_color: "#11223344",
  speed: 1,
  count: 50,
  effect: "karaoke",
};

function renderMotifPanel(
  motifId = TEST_MANIFEST.id,
  props: Record<string, unknown> = DEFAULT_PROPS,
) {
  setUserMotifs([TEST_MANIFEST]);
  render(
    <AttributePanel
      tracks={[motifTrack(motifId, props)]}
      selectedLayerId="layer-m1"
      onMutated={vi.fn().mockResolvedValue(undefined)}
      fpsNum={30}
      fpsDen={1}
      currentTimeUs={1_000_000}
    />,
  );
  return screen.getByRole("region", { name: "Props" });
}

/// Open a Base UI Select by keyboard, NOT `user.click` — a click on the
/// trigger opens the popup only for the first Select touched in a test file
/// (see ExportSettingsDialog.test.tsx, where the landmine is documented).
async function openSelect(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
  trigger.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
}

describe("MotifFields form generation", () => {
  it("renders one field per props_schema entry inside the Props section", () => {
    const section = renderMotifPanel();
    expect(within(section).getByLabelText(/^title$/i)).toBeTruthy();
    const swatch = within(section).getByLabelText(/^bg.color$/i) as HTMLInputElement;
    expect(swatch.type).toBe("color");
    expect(within(section).getByLabelText(/^speed$/i)).toBeTruthy();
    expect(within(section).getByLabelText(/^count$/i)).toBeTruthy();
    expect(within(section).getByRole("combobox", { name: /^effect$/i })).toBeTruthy();
    // One field row per schema entry — nothing dropped, nothing invented.
    expect(section.querySelectorAll(".prop-field").length).toBe(5);
  });

  it("shows the unknown note (and no Props section) for a motif missing from the catalog", () => {
    setUserMotifs([TEST_MANIFEST]);
    render(
      <AttributePanel
        tracks={[motifTrack("builtin/removed", {})]}
        selectedLayerId="layer-m1"
        onMutated={vi.fn().mockResolvedValue(undefined)}
        fpsNum={30}
        fpsDen={1}
        currentTimeUs={1_000_000}
      />,
    );
    expect(
      screen.getByText("Unknown motif — its props can't be edited here."),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Props" })).toBeNull();
    expect(updateLayerParams).not.toHaveBeenCalled();
  });
});

describe("MotifFields commit contract", () => {
  it("commits a string edit on Enter as one single-key props patch", async () => {
    const user = userEvent.setup();
    const section = renderMotifPanel();
    const input = within(section).getByLabelText(/^title$/i);
    await user.clear(input);
    await user.type(input, "Brand new");
    expect(updateLayerParams).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-m1", {
        kind: "Motif",
        props: { title: "Brand new" },
      }),
    );
    expect(updateLayerParams).toHaveBeenCalledTimes(1);
  });

  it("commits an enum pick immediately as one single-key props patch", async () => {
    const user = userEvent.setup();
    const section = renderMotifPanel();
    await openSelect(user, within(section).getByRole("combobox", { name: /^effect$/i }));
    await user.pointer({
      target: screen.getByRole("option", { name: "typewriter" }),
      keys: "[MouseLeft]",
    });
    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-m1", {
        kind: "Motif",
        props: { effect: "typewriter" },
      }),
    );
    expect(updateLayerParams).toHaveBeenCalledTimes(1);
  });

  it("commits a number edit as one single-key props patch, stepping ≤10-wide ranges by 0.1", async () => {
    const user = userEvent.setup();
    const section = renderMotifPanel();
    // speed spans 0..4 → the small-range heuristic applies: one arrow = +0.1.
    const speed = within(section).getByLabelText(/^speed$/i) as HTMLInputElement;
    await user.click(speed);
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(speed.value).toBe("1.1"));
    await user.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-m1", {
        kind: "Motif",
        props: { speed: 1.1 },
      }),
    );
    // count spans 0..100 → whole steps.
    const count = within(section).getByLabelText(/^count$/i) as HTMLInputElement;
    await user.click(count);
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(count.value).toBe("51"));
    await user.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-m1", {
        kind: "Motif",
        props: { count: 51 },
      }),
    );
    expect(updateLayerParams).toHaveBeenCalledTimes(2);
  });

  it("shows an 8-digit color truncated to 7 chars and debounce-commits the alpha-less pick", async () => {
    const section = renderMotifPanel();
    const swatch = within(section).getByLabelText(/^bg.color$/i) as HTMLInputElement;
    // Display truncation: the stored "#11223344" loses its alpha byte in the
    // swatch (`<input type="color">` can only hold an RGB triplet).
    expect(swatch.value).toBe("#112233");
    // Two rapid picks — a drag through the OS dialog — coalesce into ONE
    // debounced commit carrying the LAST value, alpha gone (pinned tradeoff:
    // a panel color edit drops any trailing alpha the default carried).
    fireEvent.change(swatch, { target: { value: "#ff0000" } });
    fireEvent.change(swatch, { target: { value: "#00ff00" } });
    expect(updateLayerParams).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(updateLayerParams).toHaveBeenCalledWith("layer-m1", {
        kind: "Motif",
        props: { bg_color: "#00ff00" },
      }),
    );
    expect(updateLayerParams).toHaveBeenCalledTimes(1);
  });

  it("falls back to the spec default in the swatch when the prop value is missing", () => {
    const section = renderMotifPanel(TEST_MANIFEST.id, { ...DEFAULT_PROPS, bg_color: undefined });
    const swatch = within(section).getByLabelText(/^bg.color$/i) as HTMLInputElement;
    // The 8-digit schema default "#00000000" truncates the same way.
    expect(swatch.value).toBe("#000000");
  });
});
