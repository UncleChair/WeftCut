// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useAppNotices } from "./useAppNotices";

afterEach(() => {
  cleanup();
  delete (window as unknown as { api?: unknown }).api;
});

function Probe() {
  const notices = useAppNotices();
  return <span data-testid="count">{notices.length}</span>;
}

describe("useAppNotices", () => {
  it("pulls startup notices after mount", async () => {
    (window as unknown as { api: unknown }).api = {
      app: {
        notices: vi.fn().mockResolvedValue([
          { level: "warn", code: "keyring_unavailable" },
        ]),
      },
    };
    render(<Probe />);
    expect(await screen.findByText("1")).toBeTruthy();
  });

  it("keeps the editor clear when the pull fails", async () => {
    (window as unknown as { api: unknown }).api = {
      app: { notices: vi.fn().mockRejectedValue(new Error("offline")) },
    };
    render(<Probe />);
    expect(await screen.findByText("0")).toBeTruthy();
  });
});
