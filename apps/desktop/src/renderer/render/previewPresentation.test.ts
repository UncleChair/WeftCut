import { describe, expect, it, vi } from "vitest";
import { UPDATE_PRIORITY, type Application } from "pixi.js";

import {
  installTimedPresent,
  setPixiPresentationVisible,
} from "./previewPresentation";

describe("setPixiPresentationVisible", () => {
  it("removes only Pixi presentation and restores it idempotently", () => {
    const add = vi.fn();
    const remove = vi.fn();
    const render = vi.fn();
    const app = { ticker: { add, remove }, render } as unknown as Application;

    setPixiPresentationVisible(app, false);
    setPixiPresentationVisible(app, false);
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(render, app);
    expect(add).not.toHaveBeenCalled();

    setPixiPresentationVisible(app, true);
    setPixiPresentationVisible(app, true);
    expect(add).toHaveBeenCalledOnce();
    // The re-added listener is the STAGE.Present wrapper, not `app.render`
    // itself — identity can't be asserted, so assert it presents.
    expect(add).toHaveBeenCalledWith(
      expect.any(Function),
      app,
      UPDATE_PRIORITY.LOW,
    );
    const listener = add.mock.calls[0]![0] as () => void;
    listener();
    expect(render).toHaveBeenCalledOnce();
  });

  it("re-adds the same listener object so remove keeps matching", () => {
    const add = vi.fn();
    const remove = vi.fn();
    const app = {
      ticker: { add, remove },
      render: vi.fn(),
    } as unknown as Application;

    setPixiPresentationVisible(app, false);
    setPixiPresentationVisible(app, true);
    setPixiPresentationVisible(app, false);
    setPixiPresentationVisible(app, true);

    expect(add.mock.calls[0]![0]).toBe(add.mock.calls[1]![0]);
    // Second hide must remove what the first re-show added, or the present
    // listener would leak and Pixi would render twice per tick.
    expect(remove.mock.calls[1]![0]).toBe(add.mock.calls[0]![0]);
  });

  it("installTimedPresent swaps Pixi's listener exactly once", () => {
    const add = vi.fn();
    const remove = vi.fn();
    const render = vi.fn();
    const app = { ticker: { add, remove }, render } as unknown as Application;

    installTimedPresent(app);
    // A second install would register the same closure twice and silently
    // render the whole scene twice per tick.
    installTimedPresent(app);

    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(render, app);
    expect(add).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith(
      expect.any(Function),
      app,
      UPDATE_PRIORITY.LOW,
    );
    (add.mock.calls[0]![0] as () => void)();
    expect(render).toHaveBeenCalledOnce();

    // After install, a hide takes the timed closure off, not `app.render`.
    setPixiPresentationVisible(app, false);
    expect(remove.mock.calls[1]![0]).toBe(add.mock.calls[0]![0]);
  });
});
