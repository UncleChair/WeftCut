// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../i18n"; // initialize i18next so useTranslation() resolves real strings
import { AppNotices } from "./AppNotices";

afterEach(() => {
  cleanup();
  delete (window as unknown as { api?: unknown }).api;
});

function mockNotices(notices: Array<{ level: string; code: string }>) {
  (window as unknown as { api: unknown }).api = {
    app: { notices: vi.fn().mockResolvedValue(notices) },
  };
}

describe("AppNotices", () => {
  it("pulls notices on mount and renders one per notice", async () => {
    mockNotices([{ level: "warn", code: "keyring_unavailable" }]);
    render(<AppNotices />);
    const notice = await screen.findByRole("status");
    // The code is reflected in the banner class so the right notice is keyed,
    // independent of the (i18n-translated) text.
    expect(notice.className).toContain("app-notice-keyring_unavailable");
    expect(notice.className).toContain("app-notice-banner");
    // Text is i18n-resolved (not the raw key).
    expect(notice.textContent).not.toContain("app_notice.");
  });

  it("dismisses a notice when its action button is clicked", async () => {
    mockNotices([{ level: "warn", code: "keyring_unavailable" }]);
    render(<AppNotices />);
    const notice = await screen.findByRole("status");
    await userEvent.click(within(notice).getByRole("button"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders nothing when there are no notices", async () => {
    mockNotices([]);
    render(<AppNotices />);
    await waitFor(() =>
      expect(
        (window as unknown as { api: { app: { notices: ReturnType<typeof vi.fn> } } }).api.app.notices,
      ).toHaveBeenCalled(),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});
