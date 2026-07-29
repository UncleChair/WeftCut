// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real i18n (same side-effect import AppMenuBar pulls in): the assertions
// below run against the en-US strings, so a missing help.* key fails here.
import "../i18n";
import { HelpMenu } from "./HelpMenu";
import {
  ISSUES_URL,
  LICENSE_URL,
  RELEASES_URL,
  REPO_URL,
  THIRD_PARTY_NOTICES_URL,
} from "./links";

const VERSIONS = {
  app: "1.2.3",
  electron: "39.0.0",
  chrome: "142.0.0",
  platform: "linux",
  arch: "x64",
};

function stubApi() {
  const open = vi.fn().mockResolvedValue(undefined);
  const versions = vi.fn().mockResolvedValue(VERSIONS);
  (window as unknown as { api: unknown }).api = {
    shell: { open },
    app: { versions },
  };
  return { open, versions };
}

afterEach(cleanup);

describe("HelpMenu", () => {
  it("sends the update check and issue reporter to the repo's pages", async () => {
    const { open } = stubApi();
    render(<HelpMenu />);

    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(await screen.findByText("Check for Updates…"));
    expect(open).toHaveBeenCalledWith(RELEASES_URL);

    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(await screen.findByText("Report an Issue…"));
    expect(open).toHaveBeenCalledWith(ISSUES_URL);
  });

  it("shows the main-process version identity in the About dialog", async () => {
    const { versions } = stubApi();
    render(<HelpMenu />);

    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(await screen.findByText("About WeftCut"));

    expect(versions).toHaveBeenCalledOnce();
    expect(await screen.findByText("Version 1.2.3")).toBeTruthy();
  });

  it("links the license lines in the About dialog to the repo files", async () => {
    const { open } = stubApi();
    render(<HelpMenu />);

    fireEvent.click(screen.getByRole("button", { name: /Help/ }));
    fireEvent.click(await screen.findByText("About WeftCut"));

    fireEvent.click(await screen.findByRole("button", { name: "MIT" }));
    expect(open).toHaveBeenCalledWith(LICENSE_URL);

    fireEvent.click(
      screen.getByRole("button", { name: "THIRD-PARTY-NOTICES.md" }),
    );
    expect(open).toHaveBeenCalledWith(THIRD_PARTY_NOTICES_URL);

    fireEvent.click(screen.getByRole("button", { name: "Project Page" }));
    expect(open).toHaveBeenCalledWith(REPO_URL);
  });
});
