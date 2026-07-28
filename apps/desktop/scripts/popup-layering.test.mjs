import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { chromium } from "playwright";

const dockviewCssPath = new URL(
  "../../../node_modules/dockview-react/dist/styles/dockview.css",
  import.meta.url,
);
const menuCssPath = new URL(
  "../src/renderer/styles/menu.css",
  import.meta.url,
);
const rendererPath = fileURLToPath(
  new URL("../src/renderer/", import.meta.url),
);

async function tsxFilesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return tsxFilesUnder(path);
      return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
    }),
  );
  return nested.flat();
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Executable doesn't exist")
    ) {
      return chromium.launch({ channel: "chrome", headless: true });
    }
    throw error;
  }
}

test("every app popup Positioner stacks above Dockview resize sashes", async () => {
  const [dockviewCss, menuCss, rendererFiles] = await Promise.all([
    readFile(dockviewCssPath, "utf8"),
    readFile(menuCssPath, "utf8"),
    tsxFilesUnder(rendererPath),
  ]);
  const sashRule = /\.dv-split-view-container \.dv-sash-container \.dv-sash\s*\{(?<body>[^}]*)\}/s.exec(
    dockviewCss,
  );
  const popupRule = /\.app-popup-positioner\s*\{(?<body>[^}]*)\}/s.exec(
    menuCss,
  );
  const sashZ = Number(
    /^\s*z-index:\s*(\d+)\s*;/m.exec(
      sashRule?.groups?.body ?? "",
    )?.[1],
  );
  const popupZ = Number(
    /^\s*z-index:\s*(\d+)\s*;/m.exec(
      popupRule?.groups?.body ?? "",
    )?.[1],
  );

  assert.ok(Number.isFinite(sashZ), "Dockview sash z-index was not found");
  assert.ok(Number.isFinite(popupZ), "app popup z-index was not found");
  assert.ok(
    popupZ > sashZ,
    `app popup z-index ${popupZ} must exceed Dockview sash z-index ${sashZ}`,
  );

  const uncovered = [];
  let positionerCount = 0;
  for (const file of rendererFiles) {
    const source = await readFile(file, "utf8");
    const tags = source.match(/<[A-Za-z]+\.Positioner\b[^>]*>/gs) ?? [];
    positionerCount += tags.length;
    if (tags.some((tag) => !tag.includes('className="app-popup-positioner"'))) {
      uncovered.push(file);
    }
  }

  assert.ok(positionerCount > 0, "no Base UI Positioners were found");
  assert.deepEqual(
    uncovered,
    [],
    `Positioners missing app-popup-positioner:\n${uncovered.join("\n")}`,
  );
});

test(
  "app popup receives the pointer above a Dockview resize sash",
  { skip: process.env.POPUP_LAYERING_STATIC_ONLY === "1" },
  async (t) => {
    const [dockviewCss, menuCss] = await Promise.all([
      readFile(dockviewCssPath, "utf8"),
      readFile(menuCssPath, "utf8"),
    ]);
    const browser = await launchBrowser();
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 400, height: 240 },
    });

    await page.setContent(`
    <style>${dockviewCss}</style>
    <style>
      /* Tailwind's generated utility used by every current popup Positioner. */
      .z-50 { z-index: 50; }
      ${menuCss}

      #dock { position: absolute; inset: 0; }
      #dock-sash { left: 100px; top: 0; }
      #popup-positioner { position: fixed; left: 80px; top: 40px; }
    </style>
    <div id="dock" class="dv-split-view-container dv-horizontal">
      <div class="dv-sash-container">
        <div id="dock-sash" class="dv-sash dv-enabled"></div>
      </div>
    </div>
    <div id="popup-positioner" class="z-50 app-popup-positioner">
      <div class="app-menu-list">
        <div class="app-menu-item">Media action</div>
      </div>
    </div>
  `);

    const hit = await page.evaluate(() => {
      const target = document.elementFromPoint(102, 55);
      return {
        className:
          target instanceof HTMLElement ? target.className : String(target),
        insideMenu: target?.closest(".app-menu-list") !== null,
      };
    });

    assert.equal(
      hit.insideMenu,
      true,
      `expected the popup to receive the pointer, hit ${hit.className}`,
    );
  },
);
