// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  useShortcuts,
  type HandlerMap,
  type OverrideMap,
} from "./useShortcuts";
import { usePickSessionStore } from "../colorpick/pickColor";
import { parseBinding } from "./match";

// useShortcuts only reaches `logEmit` for activity-log breadcrumbs; stub the
// whole ipc surface so the dispatcher runs without a backend host (and keeps the
// test output free of unhandled `invoke` rejections).
vi.mock("../ipc", () => ({ logEmit: vi.fn(() => Promise.resolve()) }));

afterEach(cleanup);

function Harness({
  handlers,
  overrides,
}: {
  handlers: HandlerMap;
  overrides?: OverrideMap;
}) {
  useShortcuts({ handlers, ...(overrides ? { overrides } : {}) });
  return null;
}

function dispatchKey(
  target: Element,
  key: string,
  init?: KeyboardEventInit,
): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(ev);
  return ev;
}

function dispatchKeyUp(target: Element, key: string): KeyboardEvent {
  const ev = new KeyboardEvent("keyup", {
    key,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
}

function dispatchBinding(target: Element, binding: string): KeyboardEvent {
  const parsed = parseBinding(binding);
  const ev = new KeyboardEvent("keydown", {
    key: parsed.key,
    ...(parsed.code ? { code: parsed.code } : {}),
    ctrlKey: parsed.ctrl,
    metaKey: parsed.meta,
    shiftKey: parsed.shift,
    altKey: parsed.alt,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
}

describe("useShortcuts — NLE-style global accelerators", () => {
  it("fires Space→togglePlay and preempts a focused control's own keydown", () => {
    const togglePlay = vi.fn();
    render(<Harness handlers={{ togglePlay }} />);

    // Stand-in for a Base UI menubar trigger that retains focus after a menu
    // action and would otherwise re-open on Space.
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    const chromeSpy = vi.fn();
    trigger.addEventListener("keydown", chromeSpy);
    trigger.focus();

    const ev = dispatchKey(trigger, " ");

    expect(togglePlay).toHaveBeenCalledTimes(1);
    // Capture-phase stopPropagation must keep the event from reaching the
    // focused control, so the menu never re-opens.
    expect(chromeSpy).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);

    trigger.remove();
  });

  it("consumes Space auto-repeat instead of leaking it to the focused control", () => {
    const togglePlay = vi.fn();
    render(<Harness handlers={{ togglePlay }} />);

    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    const chromeSpy = vi.fn();
    trigger.addEventListener("keydown", chromeSpy);
    trigger.focus();

    dispatchKey(trigger, " ");
    const repeat = dispatchKey(trigger, " ", { repeat: true });

    // The repeat must not re-fire the action, but it MUST still be
    // consumed: an unprevented repeat keydown re-arms the native button's
    // Space activation, and its keyup click would toggle the control on
    // top of playback (the original double-fire).
    expect(togglePlay).toHaveBeenCalledTimes(1);
    expect(repeat.defaultPrevented).toBe(true);
    expect(chromeSpy).not.toHaveBeenCalled();

    trigger.remove();
  });

  it("consumes the keyup paired with a consumed keydown (Base UI spans activate on keyup)", () => {
    const togglePlay = vi.fn();
    render(<Harness handlers={{ togglePlay }} />);

    // Stand-in for Base UI Switch.Root: nativeButton=false renders a
    // <span role="switch"> that Base UI toggles from its OWN keyup handler,
    // ignoring the keydown's defaultPrevented — only stopping the keyup
    // before it reaches the element keeps the switch from firing.
    const span = document.createElement("span");
    span.setAttribute("role", "switch");
    span.tabIndex = 0;
    document.body.appendChild(span);
    const keyupSpy = vi.fn();
    span.addEventListener("keyup", keyupSpy);
    span.focus();

    dispatchKey(span, " ");
    const up = dispatchKeyUp(span, " ");

    expect(togglePlay).toHaveBeenCalledTimes(1);
    expect(up.defaultPrevented).toBe(true);
    expect(keyupSpy).not.toHaveBeenCalled();

    // A keyup with no consumed keydown behind it passes through untouched.
    const strayUp = dispatchKeyUp(span, " ");
    expect(strayUp.defaultPrevented).toBe(false);
    expect(keyupSpy).toHaveBeenCalledTimes(1);

    span.remove();
  });

  it("re-fires repeatable actions on auto-repeat and keeps repeats native while editing", () => {
    const seekFrameForward = vi.fn();
    render(<Harness handlers={{ seekFrameForward }} />);

    dispatchKey(document.body, "ArrowRight");
    dispatchKey(document.body, "ArrowRight", { repeat: true });
    expect(seekFrameForward).toHaveBeenCalledTimes(2);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const ev = dispatchKey(input, "ArrowRight", { repeat: true });
    expect(seekFrameForward).toHaveBeenCalledTimes(2);
    expect(ev.defaultPrevented).toBe(false);
    input.remove();
  });

  it("yields Space when focus is inside an open overlay (role=menu)", () => {
    const togglePlay = vi.fn();
    render(<Harness handlers={{ togglePlay }} />);

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const item = document.createElement("button");
    menu.appendChild(item);
    document.body.appendChild(menu);
    const itemSpy = vi.fn();
    item.addEventListener("keydown", itemSpy);
    item.focus();

    const ev = dispatchKey(item, " ");

    // Inside an open menu, Space belongs to the menu item, not the transport.
    expect(togglePlay).not.toHaveBeenCalled();
    expect(itemSpy).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(false);

    menu.remove();
  });

  it("yields a bare-key global while a text input is focused", () => {
    const togglePlay = vi.fn();
    render(<Harness handlers={{ togglePlay }} />);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    const ev = dispatchKey(input, " ");

    expect(togglePlay).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);

    input.remove();
  });

  it("leaves M unbound and ignores a stale retired Media Pool override", () => {
    render(
      <Harness
        handlers={{}}
        overrides={{ toggleMediaPool: ["M"] } as unknown as OverrideMap}
      />,
    );

    const event = dispatchKey(document.body, "m");
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves Delete in the bubble phase so a capture-phase listener can preempt it", () => {
    const deleteSelected = vi.fn();
    render(<Harness handlers={{ deleteSelected }} />);

    // Mirrors KeyframeLane/LayerBlock: a capture-phase Delete listener that
    // claims the key for the selected keyframe before the app-level handler.
    const preempt = vi.fn((e: KeyboardEvent) => {
      if (e.key === "Delete") e.stopImmediatePropagation();
    });
    window.addEventListener("keydown", preempt, true);

    const ev = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);

    expect(preempt).toHaveBeenCalled();
    expect(deleteSelected).not.toHaveBeenCalled();

    window.removeEventListener("keydown", preempt, true);
  });

  it("dispatches timeline copy/paste chords but preserves native editing shortcuts", () => {
    const copySelected = vi.fn();
    const pasteAtPlayhead = vi.fn();
    render(<Harness handlers={{ copySelected, pasteAtPlayhead }} />);

    expect(dispatchBinding(document.body, "Mod+C").defaultPrevented).toBe(true);
    expect(dispatchBinding(document.body, "Mod+V").defaultPrevented).toBe(true);
    expect(copySelected).toHaveBeenCalledTimes(1);
    expect(pasteAtPlayhead).toHaveBeenCalledTimes(1);

    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(dispatchBinding(input, "Mod+C").defaultPrevented).toBe(false);
    expect(dispatchBinding(input, "Mod+V").defaultPrevented).toBe(false);
    expect(copySelected).toHaveBeenCalledTimes(1);
    expect(pasteAtPlayhead).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("shortcuts are inert while a color-pick session is active", () => {
    const togglePlay = vi.fn();
    render(<Harness handlers={{ togglePlay }} />);

    usePickSessionStore.setState({ session: {} as never });
    try {
      const ev = dispatchKey(document.body, " ");
      expect(togglePlay).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(false);
    } finally {
      usePickSessionStore.setState({ session: null });
    }
  });

  it("dispatches the exact Panel focus and maximize defaults", () => {
    const focusNextPanel = vi.fn();
    const focusPreviousPanel = vi.fn();
    const toggleMaximizePanel = vi.fn();
    render(
      <Harness
        handlers={{
          focusNextPanel,
          focusPreviousPanel,
          toggleMaximizePanel,
        }}
      />,
    );

    expect(
      dispatchBinding(document.body, "Ctrl+Shift+Period").defaultPrevented,
    ).toBe(true);
    expect(
      dispatchBinding(document.body, "Ctrl+Shift+Comma").defaultPrevented,
    ).toBe(true);
    expect(dispatchBinding(document.body, "Backquote").defaultPrevented).toBe(
      true,
    );
    expect(focusNextPanel).toHaveBeenCalledOnce();
    expect(focusPreviousPanel).toHaveBeenCalledOnce();
    expect(toggleMaximizePanel).toHaveBeenCalledOnce();

    const shiftedPeriod = new KeyboardEvent("keydown", {
      key: ">",
      code: "Period",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(shiftedPeriod);
    expect(shiftedPeriod.defaultPrevented).toBe(true);
    expect(focusNextPanel).toHaveBeenCalledTimes(2);
  });

  it("keeps Panel commands out of editable and transient widget contexts", () => {
    const focusNextPanel = vi.fn();
    const toggleMaximizePanel = vi.fn();
    const restoreMaximizedPanel = vi.fn();
    render(
      <Harness
        handlers={{
          focusNextPanel,
          toggleMaximizePanel,
          restoreMaximizedPanel,
        }}
      />,
    );

    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(
      dispatchBinding(input, "Ctrl+Shift+Period").defaultPrevented,
    ).toBe(false);
    expect(dispatchBinding(input, "Backquote").defaultPrevented).toBe(false);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    expect(
      dispatchBinding(button, "Ctrl+Shift+Period").defaultPrevented,
    ).toBe(false);
    expect(dispatchBinding(button, "Backquote").defaultPrevented).toBe(false);
    expect(dispatchBinding(button, "Escape").defaultPrevented).toBe(false);

    expect(focusNextPanel).not.toHaveBeenCalled();
    expect(toggleMaximizePanel).not.toHaveBeenCalled();
    expect(restoreMaximizedPanel).not.toHaveBeenCalled();
    input.remove();
    dialog.remove();
  });
});
