// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AppSwitch } from "./AppSwitch";

afterEach(cleanup);

function clickWithDetail(el: Element, detail: number): void {
  el.dispatchEvent(
    new MouseEvent("click", { detail, bubbles: true, cancelable: true }),
  );
}

describe("AppSwitch — focus handling", () => {
  it("drops focus after a mouse click so Space keeps meaning transport", () => {
    const onCheckedChange = vi.fn();
    render(
      <AppSwitch checked={false} onCheckedChange={onCheckedChange} ariaLabel="Enabled" />,
    );

    const sw = screen.getByRole("switch");
    (sw as HTMLElement).focus();
    expect(document.activeElement).toBe(sw);

    // Real mouse clicks carry a click count; the control must not linger
    // as the keyboard target afterwards (a later consumed Space would
    // still flip Chromium's focus-visible heuristic and paint a ring).
    clickWithDetail(sw, 1);
    expect(document.activeElement).not.toBe(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("keeps focus on keyboard activation (synthetic click, detail 0)", () => {
    const onCheckedChange = vi.fn();
    render(
      <AppSwitch checked={false} onCheckedChange={onCheckedChange} ariaLabel="Enabled" />,
    );

    const sw = screen.getByRole("switch");
    (sw as HTMLElement).focus();

    clickWithDetail(sw, 0);
    expect(document.activeElement).toBe(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});
