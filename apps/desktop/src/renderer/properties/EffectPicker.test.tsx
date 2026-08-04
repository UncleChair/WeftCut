// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}));

import { EffectPickerList } from "./EffectPicker";
import type { EffectPickItem } from "./effectPickerMatch";

afterEach(() => cleanup());

const items: EffectPickItem[] = [
  { kind: "blur", label: "Blur", desc: "Gaussian softening", category: "blur", categoryLabel: "Blur" },
  { kind: "chromakey", label: "Chroma Key", desc: "Remove a green screen", category: "keying", categoryLabel: "Keying" },
];

function renderList(onPick = vi.fn()) {
  render(<EffectPickerList items={items} onPick={onPick} />);
  return onPick;
}

describe("EffectPickerList", () => {
  it("lists the whole catalog under its category headers before any query", () => {
    renderList();
    expect(screen.getByText("Blur", { selector: ".effect-picker-group" })).toBeTruthy();
    expect(screen.getByText("Keying", { selector: ".effect-picker-group" })).toBeTruthy();
    expect(screen.getByTestId("effect-pick-blur")).toBeTruthy();
    expect(screen.getByTestId("effect-pick-chromakey")).toBeTruthy();
    // The description line is what makes an unfamiliar filter pickable.
    expect(screen.getByText("Gaussian softening")).toBeTruthy();
  });

  it("typing narrows the list and drops the now-empty group header", async () => {
    renderList();
    await userEvent.type(screen.getByRole("searchbox"), "chroma");
    expect(screen.getByTestId("effect-pick-chromakey")).toBeTruthy();
    expect(screen.queryByTestId("effect-pick-blur")).toBeNull();
    expect(screen.queryByText("Blur", { selector: ".effect-picker-group" })).toBeNull();
  });

  it("a query matching nothing states so instead of showing an empty popup", async () => {
    renderList();
    await userEvent.type(screen.getByRole("searchbox"), "zzzzqq");
    expect(screen.getByText("effects.no_results")).toBeTruthy();
  });

  it("the first row is active by default; ArrowDown advances and Enter picks it", async () => {
    const onPick = renderList();
    const search = screen.getByRole("searchbox");
    expect(screen.getByTestId("effect-pick-blur").getAttribute("aria-selected")).toBe("true");

    await userEvent.type(search, "{ArrowDown}");
    expect(screen.getByTestId("effect-pick-chromakey").getAttribute("aria-selected")).toBe("true");

    await userEvent.type(search, "{Enter}");
    expect(onPick).toHaveBeenCalledWith("chromakey");
  });

  it("ArrowUp from the first row wraps to the last", async () => {
    const onPick = renderList();
    await userEvent.type(screen.getByRole("searchbox"), "{ArrowUp}{Enter}");
    expect(onPick).toHaveBeenCalledWith("chromakey");
  });

  it("the keyboard cursor never survives past the end of a shrinking result set", async () => {
    const onPick = renderList();
    const search = screen.getByRole("searchbox");
    await userEvent.type(search, "{ArrowDown}"); // cursor on row 1
    await userEvent.type(search, "blur"); // one result left
    await userEvent.type(search, "{Enter}");
    expect(onPick).toHaveBeenCalledWith("blur");
  });

  it("clicking a row picks it", async () => {
    const onPick = renderList();
    await userEvent.click(screen.getByTestId("effect-pick-chromakey"));
    expect(onPick).toHaveBeenCalledWith("chromakey");
  });
});
