// @vitest-environment jsdom
//
// Covers the export dialog's rate-control group: which bitrate fields each
// rate mode exposes, and what actually leaves the dialog in `onConfirm`'s
// settings. The point of these tests is the *reachability* invariant — the
// bitrate an export runs at must always be on screen and editable, in every
// rate mode — plus the peak/target ordering the encoder seam rejects.
//
// `ipc` and the bridges are stubbed at the module boundary; the stores the
// dialog reads are stubbed to their empty state (no project summary ⇒ the
// decode-routing readout is skipped, which is not what these tests are about).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const ipc = vi.hoisted(() => ({
  exportSettingsGet: vi.fn(),
  exportSettingsSet: vi.fn(),
  workspaceDir: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, ...ipc };
});
vi.mock("@/bridge/dialog", () => ({ open: vi.fn() }));
vi.mock("@/bridge/path", () => ({
  documentDir: vi.fn().mockResolvedValue("C:/docs"),
  join: vi.fn((...parts: string[]) => Promise.resolve(parts.join("/"))),
}));
// The WebCodecs probe only gates an explicit WebCodecs pin; these tests run on
// the default (native) engine, where it is never consulted.
vi.mock("../render/exportCodecProbe", () => ({
  smokeEncode: vi.fn().mockResolvedValue(true),
}));
vi.mock("../state/projectStore", () => ({
  useProjectStore: (select: (s: unknown) => unknown) =>
    select({ summary: null, mediaById: new Map() }),
}));
vi.mock("../settings/decodeComponentStore", () => ({
  useDecodeComponentAvailable: () => true,
  useDecodeComponentReason: () => null,
}));

import i18n from "../i18n";
import type { ExportSettings } from "../render/exportSettings";
import { ExportSettingsDialog } from "./ExportSettingsDialog";

// jsdom has no PointerEvent; Base UI's Select reads MouseEvent's client coords.
(window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;

const COMP = { width: 1920, height: 1080, fps_num: 30, fps_den: 1 };
const DURATION_US = 10_000_000;
/// Medium H.264 at 1080p30: 1920×1080×30×0.129 = 8_024_832 bps, the bpp
/// heuristic's value, displayed rounded to 10 kbps.
const MEDIUM_MBPS = "8.02";

const onConfirm = vi.fn();
const onCancel = vi.fn();

/// Mount the dialog and wait for its async mount work (saved settings + the
/// default output location) to land, then switch to the Video pane where the
/// rate-control rows live. Panes are `hidden`, not unmounted, so a query before
/// the switch would find nothing by role.
async function renderDialog(user: ReturnType<typeof userEvent.setup>) {
  render(
    <ExportSettingsDialog
      comp={COMP}
      durationUs={DURATION_US}
      hasTenBitSource={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "Video" })).toBeTruthy(),
  );
  await user.click(screen.getByRole("tab", { name: "Video" }));
  // Export enablement waits on the output location resolving through the
  // path bridge; assertions on the button would otherwise race it.
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Export" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
}

/// Open a Base UI Select by keyboard, NOT `user.click`: a click on the trigger
/// opens the popup only for the first Select touched in a given test file — see
/// CanvasSection.test.tsx, where the same landmine is documented.
async function openSelect(user: ReturnType<typeof userEvent.setup>, name: string) {
  const trigger = screen.getByRole("combobox", { name });
  trigger.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  return trigger;
}

async function pickOption(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.pointer({
    target: screen.getByRole("option", { name: label }),
    keys: "[MouseLeft]",
  });
}

async function setRateMode(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) {
  await openSelect(user, "Rate control");
  await pickOption(user, label);
}

/// Base UI's NumberField appends to whatever is there, so every edit clears
/// first. The dialog's rate fields commit live (onValueChange), so no blur.
async function typeNumber(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string,
) {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  await user.type(field, value);
  return field;
}

function exportButton() {
  return screen.getByRole("button", { name: "Export" }) as HTMLButtonElement;
}

/// The settings object the dialog handed to `onConfirm` — what the export
/// pipeline actually receives.
function confirmedSettings(): ExportSettings {
  expect(onConfirm).toHaveBeenCalledTimes(1);
  return onConfirm.mock.calls[0]![0] as ExportSettings;
}

// Base UI portals its popups outside the render container, so drop whatever
// `cleanup()` leaves on the body before the next test queries roles.
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  onConfirm.mockReset();
  onCancel.mockReset();
  ipc.exportSettingsGet.mockReset().mockResolvedValue(null);
  ipc.exportSettingsSet.mockReset().mockResolvedValue(undefined);
  ipc.workspaceDir.mockReset().mockResolvedValue("C:/ws");
});

describe("export dialog rate control", () => {
  // The complaint this group exists to answer: under a quality preset the
  // bitrate used to be derived and invisible, so CBR had no settable rate.
  it("shows the preset-derived target bitrate without picking Custom", async () => {
    const user = userEvent.setup();
    await renderDialog(user);

    expect(screen.getByRole("combobox", { name: "Quality" }).textContent).toContain(
      "Medium",
    );
    expect(screen.getByLabelText("Target bitrate")).toHaveProperty(
      "value",
      MEDIUM_MBPS,
    );
  });

  it("keeps the target bitrate editable under CBR, with no separate peak", async () => {
    const user = userEvent.setup();
    await renderDialog(user);
    await setRateMode(user, "CBR (constant)");

    expect(screen.getByLabelText("Target bitrate")).toBeTruthy();
    // CBR's peak IS its target, so offering a second number would be a lie.
    expect(screen.queryByLabelText("Maximum bitrate")).toBeNull();
    await typeNumber(user, "Target bitrate", "6");
    await user.click(exportButton());

    const settings = confirmedSettings();
    expect(settings.rateMode).toBe("cbr");
    expect(settings.customBitrate).toBe(6_000_000);
    // Typing the number is what takes it over from the preset.
    expect(settings.quality).toBe("custom");
  });

  it("starts VBR uncapped and sends a typed peak through", async () => {
    const user = userEvent.setup();
    await renderDialog(user);

    // Default VBR: the peak field exists but is empty — uncapped ABR, which is
    // what every project exported before this control shipped.
    expect(screen.getByLabelText("Maximum bitrate")).toHaveProperty("value", "");
    expect(screen.getByText(/Peak uncapped/)).toBeTruthy();
    // Nothing to average over yet, so no buffer row.
    expect(screen.queryByLabelText("Buffer size")).toBeNull();

    await typeNumber(user, "Maximum bitrate", "12");
    // A ceiling exists now, so the buffer becomes meaningful.
    expect(screen.getByLabelText("Buffer size")).toBeTruthy();
    await user.click(exportButton());

    const settings = confirmedSettings();
    expect(settings.maxBitrate).toBe(12_000_000);
    expect(settings.bufferSize).toBeNull(); // left on the derived default
  });

  it("blocks export while the peak is below the target, and explains why", async () => {
    const user = userEvent.setup();
    await renderDialog(user);
    await typeNumber(user, "Maximum bitrate", "4");

    // 4 Mbps peak under an ~8 Mbps target: the encoder would abandon the
    // target and emit at the ceiling, so the seam rejects it — stop here.
    await waitFor(() => expect(exportButton().disabled).toBe(true));
    expect(screen.getByText(/maximum must be at least the target/)).toBeTruthy();

    // Raising the target's own value back under the ceiling clears it.
    await typeNumber(user, "Target bitrate", "3");
    await waitFor(() => expect(exportButton().disabled).toBe(false));
  });

  it("sends an explicit buffer size when one is typed", async () => {
    const user = userEvent.setup();
    await renderDialog(user);
    await typeNumber(user, "Maximum bitrate", "12");
    await typeNumber(user, "Buffer size", "6");
    await user.click(exportButton());

    expect(confirmedSettings().bufferSize).toBe(6_000_000);
  });

  it("replaces the whole bitrate group with CRF under quality mode", async () => {
    const user = userEvent.setup();
    await renderDialog(user);
    await setRateMode(user, "Quality (CRF)");

    // A quality preset decides nothing here — it only seeds a bitrate target,
    // and CRF has none. Showing it would be a control that does nothing.
    expect(screen.queryByRole("combobox", { name: "Quality" })).toBeNull();
    expect(screen.queryByLabelText("Target bitrate")).toBeNull();
    expect(screen.queryByLabelText("Maximum bitrate")).toBeNull();
    expect(screen.getByLabelText("CRF")).toHaveProperty("value", "18");
  });

  it("restores a saved peak and buffer on reopen", async () => {
    // Round-trip check: these fields are persisted per project, so a reopened
    // dialog must show the constraint the last export ran with.
    ipc.exportSettingsGet.mockResolvedValue({
      maxBitrate: 15_000_000,
      bufferSize: 20_000_000,
    } as Partial<ExportSettings>);
    const user = userEvent.setup();
    await renderDialog(user);

    expect(screen.getByLabelText("Maximum bitrate")).toHaveProperty("value", "15");
    expect(screen.getByLabelText("Buffer size")).toHaveProperty("value", "20");
  });

  it("drops a non-positive saved peak rather than passing it to ffmpeg", async () => {
    // export.json is hand-editable, and `-maxrate 0` is a launch failure.
    ipc.exportSettingsGet.mockResolvedValue({
      maxBitrate: 0,
    } as Partial<ExportSettings>);
    const user = userEvent.setup();
    await renderDialog(user);

    expect(screen.getByLabelText("Maximum bitrate")).toHaveProperty("value", "");
    await user.click(exportButton());
    expect(confirmedSettings().maxBitrate).toBeNull();
  });
});
