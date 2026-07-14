// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useShortcuts, type HandlerMap } from "./useShortcuts";
import { usePickSessionStore } from "../colorpick/pickColor";
import { parseBinding } from "./match";

// useShortcuts only reaches `logEmit` for activity-log breadcrumbs; stub the
// whole ipc surface so the dispatcher runs without a backend host (and keeps the
// test output free of unhandled `invoke` rejections).
vi.mock("../ipc", () => ({ logEmit: vi.fn(() => Promise.resolve()) }));

afterEach(cleanup);

function Harness({ handlers }: { handlers: HandlerMap }) {
  useShortcuts({ handlers });
  return null;
}

function dispatchKey(target: Element, key: string): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

function dispatchBinding(target: Element, binding: string): KeyboardEvent {
  const parsed = parseBinding(binding);
  const ev = new KeyboardEvent("keydown", {
    key: parsed.key,
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
});
