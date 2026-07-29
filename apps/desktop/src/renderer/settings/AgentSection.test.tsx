// @vitest-environment jsdom
//
// Covers the Settings "Agent" tab (AgentSection): one copyable config snippet
// per agent client (Codex / Claude / Cursor / generic), token masked until
// revealed, copy always carries the real token.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const ipc = vi.hoisted(() => ({
  getMcpInfo: vi.fn(),
  resetMcpToken: vi.fn(),
}));

vi.mock("../ipc", async (importActual) => {
  const actual = await importActual<typeof import("../ipc")>();
  return { ...actual, ...ipc };
});

import i18n from "../i18n";
import { AgentSection } from "./AgentSection";

const INFO = {
  url: "http://127.0.0.1:4711/mcp",
  bearer_token: "secret-token",
};

const clipboard = vi.hoisted(() => ({ writeText: vi.fn() }));

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  ipc.getMcpInfo.mockReset().mockResolvedValue(INFO);
  ipc.resetMcpToken.mockReset();
  clipboard.writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
});

/** Rendered snippet text (the <pre> content). */
async function snippetText(): Promise<string> {
  const pre = await screen.findByRole("tabpanel");
  return pre.querySelector("pre")?.textContent ?? "";
}

describe("AgentSection", () => {
  it("shows the Codex TOML snippet first, with the token masked", async () => {
    render(<AgentSection />);
    const text = await snippetText();
    expect(text).toContain('[mcp_servers.weftcut]');
    expect(text).toContain(`url = "${INFO.url}"`);
    expect(text).toContain("Bearer •••");
    expect(text).not.toContain(INFO.bearer_token);
  });

  it("copies the real token even while masked", async () => {
    render(<AgentSection />);
    const copy = await screen.findByRole("button", { name: "Copy config" });
    await userEvent.click(copy);
    expect(clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining(INFO.bearer_token),
    );
  });

  it("switches snippet format per client tab", async () => {
    render(<AgentSection />);
    await snippetText();

    await userEvent.click(screen.getByRole("tab", { name: "Claude" }));
    const claude = JSON.parse((await snippetText()).trim());
    expect(claude.mcpServers.weftcut.type).toBe("http");
    expect(claude.mcpServers.weftcut.url).toBe(INFO.url);

    await userEvent.click(screen.getByRole("tab", { name: "Cursor" }));
    const cursor = JSON.parse((await snippetText()).trim());
    expect(cursor.mcpServers.weftcut.url).toBe(INFO.url);
    expect(cursor.mcpServers.weftcut.type).toBeUndefined();

    await userEvent.click(screen.getByRole("tab", { name: "Generic" }));
    const generic = JSON.parse((await snippetText()).trim());
    expect(generic.mcpServers.weftcut.url).toBe(INFO.url);
  });

  it("reveals the token in the snippet on demand", async () => {
    render(<AgentSection />);
    const reveal = await screen.findByRole("button", { name: "Reveal token" });
    await userEvent.click(reveal);
    expect(await snippetText()).toContain(INFO.bearer_token);
  });
});
