import { describe, expect, it, vi } from "vitest";
import { UPDATE_PRIORITY, type Application } from "pixi.js";

import { setPixiPresentationVisible } from "./previewPresentation";

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
    expect(add).toHaveBeenCalledWith(render, app, UPDATE_PRIORITY.LOW);
  });
});
