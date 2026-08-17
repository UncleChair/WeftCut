// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NumberPropField } from "./MotifPropFields";

afterEach(cleanup);

const spec = { type: "number" as const, default: 0 };

describe("NumberPropField", () => {
  it("does not reset the field from props while focused (no mid-edit clobber)", async () => {
    const { rerender } = render(
      <NumberPropField label="N" spec={spec} value={10} onCommit={() => {}} />,
    );
    const el = screen.getByLabelText("N") as HTMLInputElement;
    await userEvent.click(el); // focus → edit in progress
    // A stale round-trip (or any external change) lands while the field is
    // focused. The focus gate must keep the displayed value intact.
    rerender(<NumberPropField label="N" spec={spec} value={99} onCommit={() => {}} />);
    expect(el.value).toBe("10");
  });

  it("resyncs from props once focus has left", async () => {
    const { rerender } = render(
      <NumberPropField label="N" spec={spec} value={10} onCommit={() => {}} />,
    );
    const el = screen.getByLabelText("N") as HTMLInputElement;
    await userEvent.click(el);
    await userEvent.click(document.body); // blur
    rerender(<NumberPropField label="N" spec={spec} value={99} onCommit={() => {}} />);
    expect(el.value).toBe("99");
  });
});
