// @vitest-environment jsdom
//
// Covers the Settings "Agent" tab (AgentSection): a generic setup prompt for
// agent self-configuration plus one copyable config snippet per agent client
// (Codex / Claude / Cursor / generic). With the stdio shim installed
// (shim_path set) the stdio config is the primary snippet — no token in it —
// and HTTP-direct moves behind an "advanced" disclosure; without it (dev
// before build:cli) the HTTP snippet renders as primary, token masked until
// revealed, copy always carrying the real token.
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

/// shim_path absent → the pre-shim, HTTP-primary layout (dev fallback).
const INFO = {
  url: "http://127.0.0.1:4711/mcp",
  bearer_token: "secret-token",
};

const INFO_SHIM = {
  ...INFO,
  exe_path: "C:\\Program Files\\WeftCut\\WeftCut.exe",
  appimage: null,
  user_data: "C:\\ud",
  shim_path: "C:\\ud\\cli\\weftcut-mcp.cjs",
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

  it("copies a generic English setup prompt with the connection details", async () => {
    render(<AgentSection />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Copy setup prompt" }),
    );

    expect(clipboard.writeText).toHaveBeenCalledWith(
      expect.stringMatching(
        /Configure the WeftCut MCP server for me[\s\S]*URL: http:\/\/127\.0\.0\.1:4711\/mcp[\s\S]*Bearer secret-token[\s\S]*preserve all other settings/,
      ),
    );
  });

  it("copies the setup prompt in the displayed language", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<AgentSection />);
    await userEvent.click(
      await screen.findByRole("button", { name: "复制配置提示词" }),
    );

    expect(clipboard.writeText).toHaveBeenCalledWith(
      expect.stringMatching(
        /请为我配置 WeftCut MCP 服务[\s\S]*Bearer secret-token[\s\S]*保留所有其他设置和 MCP 服务/,
      ),
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

describe("AgentSection with the stdio shim installed", () => {
  beforeEach(() => {
    ipc.getMcpInfo.mockReset().mockResolvedValue(INFO_SHIM);
  });

  it("renders the stdio config as the primary snippet, with no token in it", async () => {
    render(<AgentSection />);
    const text = await snippetText();
    expect(text).toContain("[mcp_servers.weftcut]");
    expect(text).toContain("ELECTRON_RUN_AS_NODE");
    expect(text).toContain("weftcut-mcp.cjs");
    expect(text).not.toContain(INFO.url);
    expect(text).not.toContain(INFO.bearer_token);
  });

  it("stdio JSON snippet carries command/args/env and the discovery override", async () => {
    render(<AgentSection />);
    await snippetText();
    await userEvent.click(screen.getByRole("tab", { name: "Cursor" }));
    const cursor = JSON.parse((await snippetText()).trim());
    expect(cursor.mcpServers.weftcut).toEqual({
      command: INFO_SHIM.exe_path,
      args: [INFO_SHIM.shim_path],
      env: { ELECTRON_RUN_AS_NODE: "1", WEFTCUT_USERDATA: INFO_SHIM.user_data },
    });
  });

  it("the setup prompt describes the stdio transport and leaks no token", async () => {
    render(<AgentSection />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Copy setup prompt" }),
    );
    const prompt = clipboard.writeText.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Transport: stdio");
    expect(prompt).toContain(INFO_SHIM.exe_path);
    expect(prompt).toContain(`WEFTCUT_USERDATA=${INFO_SHIM.user_data}`);
    expect(prompt).not.toContain(INFO.bearer_token);
  });

  it("HTTP direct moves behind the advanced disclosure, token still masked", async () => {
    render(<AgentSection />);
    await snippetText();
    expect(screen.queryByRole("button", { name: "Reveal token" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: /HTTP direct/ }),
    );
    const panels = screen.getAllByRole("tabpanel");
    const http = panels[panels.length - 1]?.querySelector("pre")?.textContent ?? "";
    expect(http).toContain(`url = "${INFO.url}"`);
    expect(http).toContain("Bearer •••");
    expect(http).not.toContain(INFO.bearer_token);
    expect(screen.getByRole("button", { name: "Reveal token" })).toBeTruthy();
  });
});
