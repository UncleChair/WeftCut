describe("WeftCut launches in the real WebView2", () => {
  it("boots the frontend as Edge/WebView2 with the Tauri bridge", async () => {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30000, timeoutMsg: "never reached readyState=complete" },
    );
    const info = await browser.execute(() => ({
      hasTauri: !!(window.__TAURI_INTERNALS__ || window.__TAURI__),
      domNodes: document.querySelectorAll("*").length,
      ua: navigator.userAgent,
    }));
    expect(info.domNodes).toBeGreaterThan(10);
    expect(info.ua).toContain("Edg/");
    expect(info.hasTauri).toBe(true);
  });
});
