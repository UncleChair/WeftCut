// @vitest-environment jsdom
//
// Covers all three capture-phase Delete preemptors by contract: the keyframe
// diamond, the keyframe lane, and the transition chip share this predicate
// precisely so Delete cannot mean different things depending on which
// sub-selection happens to be armed. Before it existed, the chip checked
// `isEditableTarget` and the two keyframe listeners did not — so Delete aimed
// at a character in a text field silently removed a keyframe.

import { afterEach, describe, expect, it } from "vitest";
import { subSelectionDeleteYields } from "./subSelectionDelete";
import { setActiveRegion } from "../focus/focusRegionStore";

afterEach(() => {
  setActiveRegion(null);
  document.body.innerHTML = "";
});

function timelineTarget(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

describe("subSelectionDeleteYields", () => {
  it("claims Delete while the timeline region owns the keyboard", () => {
    setActiveRegion("timeline");
    expect(subSelectionDeleteYields(timelineTarget())).toBe(false);
  });

  it("stands down while a text field is focused", () => {
    setActiveRegion("timeline");
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(subSelectionDeleteYields(input)).toBe(true);
  });

  it("stands down while another region owns the keyboard", () => {
    setActiveRegion("preview");
    expect(subSelectionDeleteYields(timelineTarget())).toBe(true);
  });

  it("stands down when no region owns the keyboard", () => {
    expect(subSelectionDeleteYields(timelineTarget())).toBe(true);
  });
});
