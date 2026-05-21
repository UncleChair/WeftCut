/// Vitest config for the renderer-fixture browser tests.
///
/// Kept SEPARATE from the default test config (which runs in Node) so:
///   - `npm test` stays fast and Node-only — devs without a Playwright
///     install don't pay the cost on every push.
///   - `npm run fixtures:render` opts into Chromium-driven runs that
///     actually exercise the renderer (WebGL + WebCodecs + Worker +
///     OffscreenCanvas — none of which exist in jsdom or Node).
///
/// First-time setup the human owns:
///   1. `npm install` in this package (pulls @vitest/browser + playwright).
///   2. `npx playwright install chromium` (downloads the Chromium binary
///      Playwright drives — ~150 MB one-time per machine).
/// CI: same two commands. The Playwright binary install is cacheable.

import { defineConfig } from "vitest/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";

const REPO_ROOT = resolve(__dirname);

export default defineConfig({
  plugins: [react()],
  test: {
    name: "fixtures-browser",
    include: ["src/**/*.browser.test.ts"],
    /// Node-side commands callable from browser tests via
    /// `import { commands } from '@vitest/browser/context'`. The
    /// MP4 round-trip path: the browser test runs the export Worker,
    /// hands the bytes to `writeFixtureMp4`, which lands them at a
    /// known path under `build/fixtures/` for the Rust
    /// `fixture_compare` CLI to consume.
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      screenshotFailures: false,
      instances: [{ browser: "chromium" }],
      commands: {
        async writeFixtureMp4(_ctx: unknown, name: string, bytes: number[]): Promise<string> {
          const path = resolve(REPO_ROOT, "build", "fixtures", `${name}.mp4`);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, new Uint8Array(bytes));
          return path;
        },
      },
    },
  },
});
