import { describe, expect, it } from "vitest";

import { MAIN_WINDOW_MINIMUM_SIZE } from "./mainWindowConfig";

describe("main window constraints", () => {
  it("keeps arbitrary Dock Trees within an operable main window", () => {
    expect(MAIN_WINDOW_MINIMUM_SIZE).toEqual({
      minWidth: 960,
      minHeight: 640,
    });
  });
});

