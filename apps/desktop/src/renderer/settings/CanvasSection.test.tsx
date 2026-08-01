// @vitest-environment jsdom
//
// Covers the "Canvas" Settings section (exported from SettingsPanel.tsx): the
// resolution preset dropdown, the custom width/height pair behind an explicit
// Apply, and the frame-rate dropdown with its history-scoped lock. `ipc` is
// stubbed at the module boundary so each test asserts the exact
// `set_composition` patch that leaves the renderer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const ipc = vi.hoisted(() => ({ setComposition: vi.fn() }));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, ...ipc };
});

import i18n from "../i18n";
import { CanvasSection, type CompositionState } from "./SettingsPanel";

// jsdom has no PointerEvent; Base UI's Select reads MouseEvent's client coords.
(window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;

const onError = vi.fn();
const onChanged = vi.fn();

const COMP: CompositionState = {
  durationUs: 2_000_000,
  durationPinned: false,
  layersMaxEndUs: 2_000_000,
  fpsNum: 30,
  fpsDen: 1,
  width: 1920,
  height: 1080,
  fpsLocked: false,
};

function renderSection(over: Partial<CompositionState> = {}) {
  return render(
    <CanvasSection
      composition={{ ...COMP, ...over }}
      onChanged={onChanged}
      onError={onError}
    />,
  );
}

/// The section mounts locked, so almost every case has to release the guard first.
/// The switch reads "Lock canvas settings" — checked means locked, so clicking it
/// while checked is what unlocks.
function lockSwitch() {
  return screen.getByRole("switch", { name: /Lock canvas settings/ });
}
async function unlock(user: ReturnType<typeof userEvent.setup>) {
  await user.click(lockSwitch());
}

/// Switch to the custom-size editor, which is what reveals the width/height pair.
async function enterCustom(user: ReturnType<typeof userEvent.setup>) {
  await openSelect(user, "Resolution");
  await pickOption(user, "Custom");
}

/// The number fields debounce their commit; the Apply button reads the live
/// `onValueChange` value, so a plain type + click is enough — but Base UI's
/// NumberField needs the field cleared first or the digits append.
async function typeSize(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  value: string,
) {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  await user.type(field, value);
}

/// Open a Base UI Select by keyboard, NOT `user.click`: a click on the trigger
/// opens the popup only for the first Select touched in a given test file — every
/// later one leaves it `aria-expanded="false"` and the assertions silently look at
/// a closed popup. Keyboard activation (and `user.pointer`, used by `pickOption`)
/// is unaffected. Verified against AppSelect directly before writing these tests.
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

// Base UI's Select portals its popup outside the render container, so drop
// whatever `cleanup()` leaves on the body before the next test queries roles.
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  onError.mockReset();
  onChanged.mockReset();
  ipc.setComposition.mockReset().mockResolvedValue(undefined);
});

describe("CanvasSection resolution", () => {
  it("shows the current size as the selected preset", () => {
    renderSection();
    expect(
      screen.getByRole("combobox", { name: "Resolution" }).textContent,
    ).toContain("1920 × 1080");
  });

  /// A non-preset size must read as "Custom" rather than leaving the trigger
  /// blank — the size is still shown by the width/height fields below.
  it("reads a non-preset size as Custom", () => {
    renderSection({ width: 1080, height: 1920 });
    expect(
      screen.getByRole("combobox", { name: "Resolution" }).textContent,
    ).toContain("Custom");
  });

  it("a preset click sends width and height in ONE patch", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    await openSelect(user, "Resolution");
    await pickOption(user, "1280 × 720");

    await waitFor(() => expect(ipc.setComposition).toHaveBeenCalledTimes(1));
    expect(ipc.setComposition).toHaveBeenCalledWith({ width: 1280, height: 720 });
  });
});

describe("CanvasSection lock", () => {
  /// The guard exists because nothing in this section is undoable and the rate is
  /// effectively one-way — a stray click costs more than any other settings row.
  it("mounts locked, with every control inert", () => {
    renderSection();
    expect(lockSwitch().getAttribute("aria-checked")).toBe("true"); // checked == locked
    expect(screen.getByRole("combobox", { name: "Resolution" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("combobox", { name: "Frame rate" }).hasAttribute("disabled")).toBe(true);
  });

  it("says why it is locked, not just that it is", () => {
    renderSection();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
  });

  it("turning the lock off releases the controls", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    expect(lockSwitch().getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("combobox", { name: "Resolution" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("combobox", { name: "Frame rate" }).hasAttribute("disabled")).toBe(false);
  });

  /// Re-locking has to abandon the edit, or re-opening the guard would silently
  /// resume a half-typed size the user already walked away from.
  it("re-locking drops the draft and leaves custom mode", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    await enterCustom(user);
    await typeSize(user, "Width", "4096");
    expect(screen.getByLabelText("Width")).toBeTruthy();

    await user.click(lockSwitch()); // same switch, re-engaging the lock
    expect(screen.queryByLabelText("Width")).toBeNull(); // custom mode left
    expect(ipc.setComposition).not.toHaveBeenCalled();

    await unlock(user);
    await enterCustom(user);
    // Seeded from the project again, not from the abandoned 4096.
    expect((screen.getByLabelText("Width") as HTMLInputElement).value).toContain("1,920");
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
  });

  it("the lock itself is inert while no project is open", () => {
    render(<CanvasSection composition={null} onChanged={onChanged} onError={onError} />);
    expect(lockSwitch().getAttribute("aria-disabled")).toBe("true");
  });
});

describe("CanvasSection custom size", () => {
  /// Custom is a mode, not a size: the fields are hidden until it is chosen, so the
  /// common case (pick a standard resolution) shows one control instead of four.
  it("hides the width/height pair until Custom is selected", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    expect(screen.queryByLabelText("Width")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();

    await enterCustom(user);
    expect(screen.getByLabelText("Width")).toBeTruthy();
    expect(screen.getByLabelText("Height")).toBeTruthy();
  });

  it("selecting Custom patches nothing on its own", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    await enterCustom(user);
    expect(ipc.setComposition).not.toHaveBeenCalled();
  });

  /// A size the ladder cannot represent has to show the fields unprompted —
  /// otherwise the panel would display no readout of the real size at all.
  it("reveals the fields unprompted for an off-ladder size", () => {
    renderSection({ width: 1080, height: 1920 });
    expect((screen.getByLabelText("Width") as HTMLInputElement).value).toContain("1,080");
    expect((screen.getByLabelText("Height") as HTMLInputElement).value).toContain("1,920");
  });

  it("picking a preset leaves custom mode", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    await enterCustom(user);
    await openSelect(user, "Resolution");
    await pickOption(user, "1280 × 720");

    await waitFor(() => expect(ipc.setComposition).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Width")).toBeNull();
  });
});

describe("CanvasSection custom size validation", () => {
  it("Apply is inert until the size actually differs", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    await enterCustom(user);
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
  });

  /// The whole reason Apply exists: editing width alone must not commit a
  /// 3840×1080 canvas on its way to 3840×2160.
  it("sends one patch with BOTH dimensions, never an intermediate", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    await enterCustom(user);
    await typeSize(user, "Width", "3840");
    await typeSize(user, "Height", "2160");
    expect(ipc.setComposition).not.toHaveBeenCalled(); // nothing yet — Apply gates it

    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(ipc.setComposition).toHaveBeenCalledTimes(1));
    expect(ipc.setComposition).toHaveBeenCalledWith({ width: 3840, height: 2160 });
  });

  it("rejects an odd dimension instead of letting export shave a pixel", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    await enterCustom(user);
    await typeSize(user, "Width", "1921");

    expect(screen.getByRole("alert").textContent).toContain("even numbers");
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
  });

  it("rejects a size past the 8K ceiling", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    await enterCustom(user);
    await typeSize(user, "Width", "9000");

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
  });

  it("rejects a size below the floor", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    await enterCustom(user);
    await typeSize(user, "Height", "8");

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled")).toBe(true);
  });

  it("surfaces an actor rejection through onError", async () => {
    const user = userEvent.setup();
    ipc.setComposition.mockRejectedValue(new Error("ValidationFailed"));
    renderSection();
    await unlock(user);
    await enterCustom(user);
    await typeSize(user, "Width", "1280");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("ValidationFailed")),
    );
  });
});

describe("CanvasSection frame rate", () => {
  it("offers the new-project rate ladder, NTSC family included", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    await openSelect(user, "Frame rate");

    for (const label of ["30 fps", "24 fps", "25 fps", "50 fps", "60 fps", "23.976 fps", "29.97 fps", "59.94 fps"]) {
      expect(screen.getByRole("option", { name: label })).toBeTruthy();
    }
  });

  it("sends the exact rational, not the rounded label", async () => {
    const user = userEvent.setup();
    renderSection();
    await unlock(user);
    await openSelect(user, "Frame rate");
    await pickOption(user, "29.97 fps");

    await waitFor(() => expect(ipc.setComposition).toHaveBeenCalledTimes(1));
    expect(ipc.setComposition).toHaveBeenCalledWith({ fps: { num: 30_000, den: 1001 } });
  });

  /// A rate an MCP caller set that isn't on the ladder still has to render.
  it("surfaces an off-ladder rate rather than showing an empty trigger", () => {
    renderSection({ fpsNum: 48, fpsDen: 1 });
    expect(
      screen.getByRole("combobox", { name: "Frame rate" }).textContent,
    ).toContain("48 fps");
  });

  /// `fpsLocked` outranks the section lock: releasing the guard does not make a
  /// content-locked rate editable, because that one is a data constraint.
  it("stays disabled when the project's rate is locked, even with the guard off", async () => {
    const user = userEvent.setup();
    renderSection({ fpsLocked: true });
    await unlock(user);
    expect(screen.getByRole("combobox", { name: "Frame rate" }).hasAttribute("disabled")).toBe(true);
  });

  it("states the rule once, whatever this project's state", async () => {
    const user = userEvent.setup();
    renderSection({ fpsLocked: true });
    expect(screen.getByText(/never had content/)).toBeTruthy();

    cleanup();
    renderSection();
    await unlock(user);
    expect(screen.getByRole("combobox", { name: "Frame rate" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/never had content/)).toBeTruthy();
  });
});

describe("CanvasSection with no project", () => {
  it("disables every control while composition is null", () => {
    render(
      <CanvasSection composition={null} onChanged={onChanged} onError={onError} />,
    );
    expect(screen.getByRole("combobox", { name: "Resolution" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("combobox", { name: "Frame rate" }).hasAttribute("disabled")).toBe(true);
    // No composition → no size to edit, so the custom editor is not rendered at all.
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });
});
