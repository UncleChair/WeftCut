// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { useNativeMenu } from "./nativeMenu";
import { usePickSessionStore } from "../colorpick/pickColor";
import type { MenuProjection } from "../../shared/menu";
import type { HandlerMap, OverrideMap } from "../shortcuts/useShortcuts";

// The hook is macOS-only by design; force that branch on so the projection runs
// under a Linux/Windows CI leg too.
vi.mock("@/platform", () => ({ isMac: true }));
// Activity-log breadcrumbs only — no backend host in a unit test.
vi.mock("../ipc", () => ({ logEmit: vi.fn(() => Promise.resolve()) }));
// i18next isn't initialised here; resolve a label key to itself so the
// assertions can talk about which KEY each item carries.
// `initReactI18next` is part of the mock because the real i18n singleton
// (`../i18n`, reached through any module that renders refusal copy) calls
// `.use(initReactI18next)` at import time — a mock missing it fails the whole
// file at load, before any test runs.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en-US" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const sync = vi.fn(() => Promise.resolve());
/// Registered `menu:action` listeners, so a test can play the main process.
let listeners: ((payload: unknown) => void)[] = [];

beforeEach(() => {
  sync.mockClear();
  listeners = [];
  vi.stubGlobal("window", {
    ...globalThis.window,
    api: {
      menu: { sync },
      on: (event: string, cb: (payload: unknown) => void) => {
        if (event === "menu:action") listeners.push(cb);
        return () => {
          listeners = listeners.filter((l) => l !== cb);
        };
      },
    },
  });
});

afterEach(() => {
  cleanup();
  usePickSessionStore.setState({ session: null });
  vi.unstubAllGlobals();
});

function Harness({ handlers, overrides = {} }: { handlers: HandlerMap; overrides?: OverrideMap }) {
  useNativeMenu({ handlers, overrides });
  return null;
}

/// The projection from the most recent sync.
function lastProjection(): MenuProjection {
  const call = sync.mock.calls.at(-1) as unknown as [MenuProjection] | undefined;
  if (!call) throw new Error("no projection was synced");
  return call[0];
}

/// Deliver a `menu:action` the way main does after an item is chosen.
async function chooseMenuItem(actionId: string): Promise<void> {
  // `listen()` resolves a promise before the listener is registered.
  await Promise.resolve();
  for (const l of listeners) l({ actionId });
}

describe("useNativeMenu", () => {
  it("projects only what this surface can run", async () => {
    const handlers: HandlerMap = { save: vi.fn(), openSettings: vi.fn() };
    render(<Harness handlers={handlers} />);

    expect(sync).toHaveBeenCalledTimes(1);
    const projection = lastProjection();
    expect(Object.keys(projection.actions).sort()).toEqual(["openSettings", "save"]);
    // Labels are i18n KEYS from the catalogue, never retyped strings.
    expect(projection.actions.save?.label).toBe("actions.save");
  });

  it("carries the effective binding, so a rebind reaches the menu", () => {
    render(
      <Harness handlers={{ save: vi.fn() }} overrides={{ save: ["Ctrl+Alt+S"] }} />,
    );
    expect(lastProjection().actions.save?.keys).toEqual(["Ctrl+Alt+S"]);
  });

  it("falls back to the catalogue default when the action is not rebound", () => {
    render(<Harness handlers={{ save: vi.fn() }} />);
    expect(lastProjection().actions.save?.keys).toEqual(["Mod+S"]);
  });

  it("does not resync when a render leaves the same actions available", () => {
    // Callers build the handler map inline, so its identity changes every
    // render; resyncing on that would rebuild the native menu constantly.
    const { rerender } = render(<Harness handlers={{ save: vi.fn() }} />);
    rerender(<Harness handlers={{ save: vi.fn() }} />);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("resyncs when the set of available actions changes", () => {
    const { rerender } = render(<Harness handlers={{ save: vi.fn() }} />);
    rerender(<Harness handlers={{ save: vi.fn(), export: vi.fn() }} />);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(Object.keys(lastProjection().actions).sort()).toEqual(["export", "save"]);
  });

  it("runs the chosen action through the surface's own handler", async () => {
    const save = vi.fn();
    render(<Harness handlers={{ save }} />);
    await chooseMenuItem("save");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("ignores an action this surface no longer handles", async () => {
    render(<Harness handlers={{ save: vi.fn() }} />);
    await expect(chooseMenuItem("export")).resolves.toBeUndefined();
  });

  it("stays dead while a modal color-pick session owns the keyboard", async () => {
    // The dispatcher stands down there WITHOUT preventDefault, which is what
    // lets the chord reach the menu — so the menu path must stand down too.
    const save = vi.fn();
    render(<Harness handlers={{ save }} />);
    usePickSessionStore.setState({
      session: { settle: vi.fn() } as unknown as ReturnType<
        typeof usePickSessionStore.getState
      >["session"],
    });
    await chooseMenuItem("save");
    expect(save).not.toHaveBeenCalled();
  });
});
