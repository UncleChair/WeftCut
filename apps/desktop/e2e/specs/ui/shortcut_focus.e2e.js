import { mkdirSync } from "node:fs";
import { newProject } from "../../helpers/app.mjs";
import { tmpProjectParent } from "../../helpers/media.mjs";

// NLE-style global transport, real WebView2.
//
// Regression gate for the reported focus bug: after importing via the File
// ("文件") menu, DOM focus is returned to the menubar trigger (Base UI restores
// it once the menu item is activated). The keyframe-editing surface is pointer-
// driven and never claims focus, so the trigger keeps it — and pressing Space
// (meant as play/pause) used to RE-OPEN the File menu because a focused Base UI
// menubar trigger treats Space as "open me".
//
// The fix dispatches `togglePlay` (Space) in the keydown CAPTURE phase, so it
// runs before the focused trigger and swallows the key. This spec drives the
// real Base UI Menubar + the real focus model:
//   - open the menu, Escape to close → focus is parked on the trigger
//   - Space must NOT re-open it (the bug-inverse)
//   - Enter (NOT a global accelerator) must STILL open it (proves the capture
//     interception is surgical to Space, not a blanket "trigger can't be keyed")

const PROJECT_PARENT = tmpProjectParent("weftcut-e2e-shortcut-focus");

const openMenuCount = () =>
  browser.execute(() => document.querySelectorAll('[role="menu"]').length);
const activeIsMenuTrigger = () =>
  browser.execute(
    () =>
      !!document.activeElement &&
      document.activeElement.classList.contains("menu-trigger"),
  );

describe("global Space wins over a focus-retained menubar trigger (real WebView2)", function () {
  before(function () {
    mkdirSync(PROJECT_PARENT, { recursive: true });
  });

  it("Space does not re-open a focused menu; Enter still does", async function () {
    this.timeout(60000);

    // A blank project is enough — the bug is purely about DOM focus + the
    // shortcut dispatcher, independent of any media or keyframe.
    await newProject({
      parentFolder: PROJECT_PARENT,
      name: "e2e-shortcut-focus-" + Date.now(),
      canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
    });

    // The menubar lives in the header; the first trigger is File.
    const fileTrigger = await $(".menu-trigger");
    await fileTrigger.waitForExist({ timeout: 15000 });

    // 1. Open the File menu by clicking the trigger.
    await fileTrigger.click();
    await browser.waitUntil(async () => (await openMenuCount()) === 1, {
      timeout: 8000,
      timeoutMsg: "menu did not open on trigger click (selector/role wrong?)",
    });

    // 2. Escape closes it; Base UI returns focus to the trigger — the same
    //    state left behind after picking 'Import Media…'.
    await browser.keys("Escape");
    await browser.waitUntil(async () => (await openMenuCount()) === 0, {
      timeout: 8000,
      timeoutMsg: "menu did not close on Escape",
    });
    expect(await activeIsMenuTrigger()).toBe(true);

    // 3. THE BUG: with the trigger focused, Space must NOT re-open the menu.
    await browser.keys("Space");
    await browser.pause(400);
    expect(await openMenuCount()).toBe(0);

    // 4. CONTROL: the trigger is still focused & operable — Enter still opens
    //    it, so the capture-phase interception is specific to Space.
    expect(await activeIsMenuTrigger()).toBe(true);
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await openMenuCount()) === 1, {
      timeout: 8000,
      timeoutMsg:
        "Enter no longer opens the focused menu — interception is over-broad",
    });

    // cleanup
    await browser.keys("Escape");
    console.log("[e2e] Space swallowed by global transport; Enter still opens menu ✔");
  });
});
