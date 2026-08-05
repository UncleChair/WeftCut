// @vitest-environment jsdom
//
// jsdom implements none of Chromium's "mousedown moves focus" behaviour, which
// makes it exactly the right harness here: every focus move these tests observe
// is one `useFocusRegions` performed itself.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";

import { useFocusRegions } from "./useFocusRegions";
import { activeRegion, setActiveRegion } from "./focusRegionStore";
import { AppInput } from "../components/AppInput";

// jsdom does not implement PointerEvent; alias it to MouseEvent so
// fireEvent.pointerDown carries a usable .button (same shim as
// TransformGizmo.test.tsx).
if (typeof window !== "undefined" && !window.PointerEvent) {
  (window as unknown as Record<string, unknown>).PointerEvent = window.MouseEvent;
}

afterEach(cleanup);
afterEach(() => setActiveRegion(null));

function Harness({ onCommit }: { onCommit: (v: string) => void }) {
  useFocusRegions();
  const [text, setText] = useState("start");
  const cancelling = useRef(false);
  return (
    <>
      <div tabIndex={-1} data-focus-region="attribute" data-testid="attribute">
        <AppInput
          value={text}
          ariaLabel="title"
          onValueChange={setText}
          onBlur={() => {
            if (cancelling.current) {
              cancelling.current = false;
              return;
            }
            onCommit(text);
          }}
          onCancel={() => {
            cancelling.current = true;
            setText("start");
          }}
        />
        {/* A composite field: the separator is not focusable, so a press on it
            would otherwise read as leaving `seg`. Mirrors the timecode field. */}
        <span data-focus-group>
          <input aria-label="seg" />
          <span data-testid="separator">:</span>
        </span>
      </div>
      <div tabIndex={-1} data-focus-region="preview" data-testid="preview">
        {/* Mirrors a gizmo handle: cancels pointerdown to kill native drag. */}
        <div
          data-testid="handle"
          onPointerDown={(e) => e.preventDefault()}
        />
      </div>
      <button data-testid="chrome">chrome</button>
    </>
  );
}

describe("useFocusRegions", () => {
  it("releases a field to the pressed region even when the press cancels pointerdown", () => {
    const onCommit = vi.fn();
    const { getByLabelText, getByTestId } = render(<Harness onCommit={onCommit} />);
    const input = getByLabelText("title") as HTMLInputElement;

    input.focus();
    fireEvent.change(input, { target: { value: "typed" } });
    fireEvent.pointerDown(getByTestId("handle"), { button: 0 });

    // The whole point: `preventDefault()` on the handle's pointerdown suppresses
    // the compatibility mousedown that would have moved focus, so without a
    // capture-phase listener the field keeps focus and the typed value is never
    // committed.
    expect(document.activeElement).toBe(getByTestId("preview"));
    expect(onCommit).toHaveBeenCalledWith("typed");
    expect(activeRegion()).toBe("preview");
  });

  it("keeps focus when the press lands on a satellite of the same field", () => {
    const { getByLabelText, getByTestId } = render(<Harness onCommit={vi.fn()} />);
    const seg = getByLabelText("seg") as HTMLInputElement;

    seg.focus();
    fireEvent.pointerDown(getByTestId("separator"), { button: 0 });

    expect(document.activeElement).toBe(seg);
  });

  it("Escape reverts the edit before the release blur can commit it", async () => {
    const onCommit = vi.fn();
    const { getByLabelText, getByTestId } = render(<Harness onCommit={onCommit} />);
    const input = getByLabelText("title") as HTMLInputElement;

    input.focus();
    fireEvent.change(input, { target: { value: "typed" } });
    // The release is deferred one microtask precisely so the field's own Escape
    // handler sets its cancel flag first. Reverse that order and Escape commits
    // the value it was supposed to discard.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("start");
    expect(document.activeElement).toBe(getByTestId("attribute"));
  });

  it("reports no region when focus moves into app chrome", () => {
    const { getByLabelText, getByTestId } = render(<Harness onCommit={vi.fn()} />);

    (getByLabelText("title") as HTMLInputElement).focus();
    expect(activeRegion()).toBe("attribute");

    getByTestId("chrome").focus();
    expect(activeRegion()).toBeNull();
  });
});
