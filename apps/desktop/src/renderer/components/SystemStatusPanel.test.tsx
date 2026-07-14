// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";
import { SystemStatusPanel } from "./SystemStatusPanel";

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("SystemStatusPanel", () => {
  it("owns the interactive system card and closes independently", async () => {
    const onClose = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <SystemStatusPanel
        notices={[{ level: "warn", code: "keyring_unavailable" }]}
        onClose={onClose}
        onOpenSettings={onOpenSettings}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "打开 API 密钥设置" }));
    expect(onOpenSettings).toHaveBeenCalledWith("apikeys");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
