// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../i18n";
import { CurrentSystemStatus } from "./CurrentSystemStatus";

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("CurrentSystemStatus", () => {
  it("renders the unresolved states independently of log history", () => {
    render(
      <CurrentSystemStatus
        notices={[
          { level: "info", code: "native_decode_unavailable" },
          { level: "warn", code: "keyring_unavailable" },
        ]}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.getByText("原生解码引擎不可用")).toBeTruthy();
    expect(screen.getByText("云 API 密钥未加密")).toBeTruthy();
  });

  it("opens the matching recovery settings", async () => {
    const onOpenSettings = vi.fn();
    render(
      <CurrentSystemStatus
        notices={[{ level: "warn", code: "keyring_unavailable" }]}
        onOpenSettings={onOpenSettings}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "打开 API 密钥设置" }));
    expect(onOpenSettings).toHaveBeenCalledWith("speech");
  });
});
