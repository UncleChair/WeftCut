import { expect, test } from "@playwright/test";
import { launchApp } from "./helpers/driver";

test("dev splash toggle remains clickable above the splash drag region", async () => {
  const { app, page } = await launchApp();

  try {
    const play = page.getByRole("button", { name: "Play splash" });
    await expect(play).toBeVisible();
    await play.click();

    const exit = page.getByRole("button", { name: "Exit splash" });
    await expect(exit).toBeVisible();
    await expect(page.locator(".splash-screen")).toBeVisible();
    expect(
      await exit.evaluate((button) =>
        getComputedStyle(button).getPropertyValue("-webkit-app-region"),
      ),
    ).toBe("no-drag");
    await exit.click();

    await expect(play).toBeVisible();
    await expect(page.locator(".splash-screen")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
