// @vitest-environment jsdom
// Inspector transition section: what the fields commit over the wire. The
// D5 pin lives here — the duration timecode commit sends `duration_us` ONLY
// (no extended_us), which is precisely what keeps it sanctity-preferring:
// the grow/shrink routing stays in the mutation layer, never in this panel.
// Kind/direction pairing semantics are unit-tested in transitions.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "../i18n"; // initialize i18next so t(key) resolves in chrome
import type { TransitionSummary } from "../ipc";
import { TransitionFields } from "./TransitionFields";

const ipcMocks = vi.hoisted(() => ({
  updateTransition: vi.fn().mockResolvedValue(undefined),
  removeTransition: vi.fn().mockResolvedValue(undefined),
  logEmit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    updateTransition: ipcMocks.updateTransition,
    removeTransition: ipcMocks.removeTransition,
    logEmit: ipcMocks.logEmit,
  };
});

// Wipe·left, 0.5 s, pure placement (nothing borrowed).
const transition: TransitionSummary = {
  id: "tr-1",
  from_layer: "layer-a",
  to_layer: "layer-b",
  duration_us: 500_000,
  kind: { kind: "Wipe", direction: "left" },
  extended_us: 0,
};

function renderFields() {
  return render(
    <TransitionFields
      transition={transition}
      fpsNum={30}
      fpsDen={1}
      onMutated={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

beforeEach(() => {
  ipcMocks.updateTransition.mockClear();
  ipcMocks.removeTransition.mockClear();
});
afterEach(cleanup);

describe("TransitionFields duration commit", () => {
  it("commits the parsed timecode as duration_us WITHOUT extended_us (D5: the routing stays in the mutation)", async () => {
    renderFields();
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("00:00:00:15"); // 0.5 s at 30 fps

    fireEvent.change(input, { target: { value: "2" } }); // parseTimecode: bare seconds
    fireEvent.blur(input);

    await waitFor(() =>
      expect(ipcMocks.updateTransition).toHaveBeenCalledTimes(1),
    );
    const args = ipcMocks.updateTransition.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(args).toEqual({ transitionId: "tr-1", durationUs: 2_000_000 });
    // toEqual ignores undefined-valued keys — pin the key set so a stray
    // `extendedUs` (which would turn every inspector edit into an explicit
    // borrow request) cannot slip in silently.
    expect(Object.keys(args).sort()).toEqual(["durationUs", "transitionId"]);
  });

  it("invalid input reverts to the stored duration and commits nothing", () => {
    renderFields();
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "not a timecode" } });
    fireEvent.blur(input);

    expect(input.value).toBe("00:00:00:15");
    expect(ipcMocks.updateTransition).not.toHaveBeenCalled();
  });

  it("an unchanged value commits nothing (stationary blur never mutates)", () => {
    renderFields();
    const input = screen.getByRole("textbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "00:00:00:15" } });
    fireEvent.blur(input);

    expect(ipcMocks.updateTransition).not.toHaveBeenCalled();
  });
});
