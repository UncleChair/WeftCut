// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppTimecodeField } from "./AppTimecodeField";

afterEach(cleanup);

// 30 fps composition: framesPerSec = 30, so FF ranges 0..29.
const fps = { fpsNum: 30, fpsDen: 1 };
const US = 1_000_000;
const framesToUs = (frames: number) => Math.round((frames * US) / 30);

describe("AppTimecodeField", () => {
  it("renders four segments from valueUs", () => {
    // 12s 5f @30fps = 12*30 + 5 = 365 frames → 00:00:12:05
    render(<AppTimecodeField valueUs={framesToUs(365)} {...fps} onCommit={() => {}} />);
    expect((screen.getByLabelText("hours") as HTMLInputElement).value).toBe("00");
    expect((screen.getByLabelText("minutes") as HTMLInputElement).value).toBe("00");
    expect((screen.getByLabelText("seconds") as HTMLInputElement).value).toBe("12");
    expect((screen.getByLabelText("frames") as HTMLInputElement).value).toBe("05");
  });

  it("auto-advances to the next segment after two digits", async () => {
    render(<AppTimecodeField valueUs={0} {...fps} onCommit={() => {}} />);
    await userEvent.click(screen.getByLabelText("hours"));
    await userEvent.keyboard("12");
    expect(document.activeElement).toBe(screen.getByLabelText("minutes"));
  });

  it("clamps frames to fps-1 on commit (30fps → 29)", async () => {
    const onCommit = vi.fn();
    render(<AppTimecodeField valueUs={0} {...fps} onCommit={onCommit} />);
    await userEvent.click(screen.getByLabelText("frames"));
    await userEvent.keyboard("45");
    await userEvent.click(document.body); // blur the whole control → commit
    expect((screen.getByLabelText("frames") as HTMLInputElement).value).toBe("29");
    expect(onCommit).toHaveBeenCalledWith(framesToUs(29));
  });

  it("clamps seconds to 59 on commit", async () => {
    render(<AppTimecodeField valueUs={0} {...fps} onCommit={() => {}} />);
    await userEvent.click(screen.getByLabelText("seconds"));
    await userEvent.keyboard("88");
    await userEvent.click(document.body);
    expect((screen.getByLabelText("seconds") as HTMLInputElement).value).toBe("59");
  });

  it("↑ increments the focused segment, clamped", async () => {
    render(<AppTimecodeField valueUs={0} {...fps} onCommit={() => {}} />);
    const ss = screen.getByLabelText("seconds") as HTMLInputElement;
    await userEvent.click(ss);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(ss.value).toBe("02");
  });

  it("Enter commits the assembled, frame-aligned value", async () => {
    const onCommit = vi.fn();
    render(<AppTimecodeField valueUs={0} {...fps} onCommit={onCommit} />);
    await userEvent.click(screen.getByLabelText("seconds"));
    await userEvent.keyboard("10{Enter}"); // 10s = 300 frames = 10_000_000 us
    expect(onCommit).toHaveBeenCalledWith(10 * US);
  });

  it("Esc reverts the segments and calls onCancel", async () => {
    const onCancel = vi.fn();
    render(
      <AppTimecodeField
        valueUs={framesToUs(365)} // 00:00:12:05
        {...fps}
        onCommit={() => {}}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByLabelText("seconds"));
    await userEvent.keyboard("99{Escape}");
    expect(onCancel).toHaveBeenCalled();
    expect((screen.getByLabelText("seconds") as HTMLInputElement).value).toBe("12");
  });

  it("does not re-sync from valueUs while focused (no clobber mid-edit)", async () => {
    const { rerender } = render(
      <AppTimecodeField valueUs={0} {...fps} onCommit={() => {}} />,
    );
    const ss = screen.getByLabelText("seconds") as HTMLInputElement;
    await userEvent.click(ss);
    await userEvent.keyboard("25");
    // external value advances (e.g. playhead) while editing:
    rerender(<AppTimecodeField valueUs={framesToUs(900)} {...fps} onCommit={() => {}} />);
    expect(ss.value).toBe("25"); // edit preserved, not overwritten to 00:00:30:00
  });
});
