// @vitest-environment jsdom
//
// Integration coverage for the picker's fallback form: prop edits buffer in
// local form state (NO IPC per edit) and leave as ONE whole-props object on
// submit — the opposite commit model from the property panel's per-key
// patches. Also pins the ColorInput contract: the swatch edits the RGB
// triplet while the buffered value keeps a default's trailing alpha (shown in
// full by the `<code>` readout) until the user actually picks a color.
//
// Field queries use case-insensitive patterns so they match the label whether
// it renders as the raw prop key or its Title Case form.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n";
import type { MotifSummary } from "../ipc";

const ipcMocks = vi.hoisted(() => ({
  listMotifs: vi.fn(),
  addMotif: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, ...ipcMocks };
});
vi.mock("@/bridge/events", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@/bridge/dialog", () => ({ open: vi.fn() }));
// The preview's CDP capture has no jsdom stand-in; a never-settling promise
// parks every preview in its loading state, which the form doesn't depend on.
vi.mock("../render/motifs/host", () => ({
  captureMotifFramePngBlob: vi.fn(() => new Promise(() => {})),
}));

import { setUserMotifs } from "../render/motifs/catalog";
import { MotifPicker } from "./MotifPicker";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setUserMotifs([]);
});

const MOTIF: MotifSummary = {
  id: "badge",
  name: "Badge",
  version: 1,
  size: [640, 360],
  default_duration_s: 5,
  status: "installed",
  props_schema: {
    title: { type: "string", default: "Hello", max_length: 40 },
    // Translucent default: only the untouched buffered value may keep the
    // trailing alpha; the swatch itself can never produce one.
    accent: { type: "color", default: "#000000cc" },
    ring: { type: "color", default: "#ff4d4d" },
    speed: { type: "number", default: 1, min: 0, max: 4 },
    effect: { type: "enum", default: "karaoke", options: ["typewriter", "karaoke"] },
  },
};

const onClose = vi.fn();
const onAdded = vi.fn().mockResolvedValue(undefined);

async function renderPicker() {
  ipcMocks.listMotifs.mockResolvedValue([MOTIF]);
  ipcMocks.addMotif.mockResolvedValue("layer-new");
  render(
    <MotifPicker
      onClose={onClose}
      onAdded={onAdded}
      onDraftPlaced={vi.fn()}
      currentTimeUs={1_000_000}
      tracks={[]}
      fpsNum={30}
      fpsDen={1}
      compWidth={1920}
      compHeight={1080}
    />,
  );
  // The form mounts once the catalog fetch lands and the first card is selected.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add to timeline" })).toBeTruthy(),
  );
}

function colorSwatch(pattern: RegExp): HTMLInputElement {
  const el = screen.getByLabelText(pattern) as HTMLInputElement;
  expect(el.type).toBe("color");
  return el;
}

/// The `<code>` readout beside a color swatch — the only place the buffered
/// (possibly alpha-bearing) value is visible.
function colorReadout(swatch: HTMLInputElement): string {
  const code = swatch.closest(".motif-picker-field")?.querySelector("code");
  expect(code).toBeTruthy();
  return code!.textContent ?? "";
}

describe("MotifPicker prop form", () => {
  it("buffers edits locally and submits the whole props object in one add", async () => {
    const user = userEvent.setup();
    await renderPicker();

    const title = screen.getByLabelText(/^title$/i);
    await user.clear(title);
    await user.type(title, "Live");
    // speed spans 0..4 → the shared ≤10-wide heuristic steps by 0.1.
    const speed = screen.getByLabelText(/^speed$/i) as HTMLInputElement;
    await user.click(speed);
    await user.keyboard("{ArrowUp}");
    await waitFor(() => expect(speed.value).toBe("1.1"));

    // Buffered: nothing has left the form yet.
    expect(ipcMocks.addMotif).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Add to timeline" }));
    await vi.waitFor(() => expect(ipcMocks.addMotif).toHaveBeenCalledTimes(1));
    // Whole-object semantics: every schema key rides along, edited or not —
    // including the untouched translucent default with its alpha intact.
    expect(ipcMocks.addMotif).toHaveBeenCalledWith({
      motifId: "badge",
      tStartUs: 1_000_000,
      trackId: undefined,
      props: {
        title: "Live",
        accent: "#000000cc",
        ring: "#ff4d4d",
        speed: 1.1,
        effect: "karaoke",
      },
    });
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the full alpha-bearing value in the code readout while the swatch holds RGB only", async () => {
    await renderPicker();
    const accent = colorSwatch(/^accent$/i);
    expect(accent.value).toBe("#000000");
    expect(colorReadout(accent)).toBe("#000000cc");
  });

  it("drops the alpha once the user picks a color, and submits the pick", async () => {
    const user = userEvent.setup();
    await renderPicker();
    const accent = colorSwatch(/^accent$/i);
    fireEvent.change(accent, { target: { value: "#123456" } });
    expect(colorReadout(accent)).toBe("#123456");
    expect(ipcMocks.addMotif).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Add to timeline" }));
    await vi.waitFor(() => expect(ipcMocks.addMotif).toHaveBeenCalledTimes(1));
    const args = ipcMocks.addMotif.mock.calls[0]![0] as { props: Record<string, unknown> };
    expect(args.props["accent"]).toBe("#123456");
    // The other color stayed untouched at its default.
    expect(args.props["ring"]).toBe("#ff4d4d");
  });
});
