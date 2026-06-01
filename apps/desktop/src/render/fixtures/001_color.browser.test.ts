/// Vitest browser-mode test for the `001_color` fixture.
///
/// Drives the export Worker end-to-end against the fixture's
/// `project.json`, writes the resulting MP4 to `build/fixtures/001_color.mp4`
/// via the Node-side `writeFixtureMp4` command (see
/// `vitest.browser.config.ts`). The Rust CLI `fixture_compare` consumes
/// that file in the second leg of `npm run fixtures:check`.
///
/// Why this exists:
///   - WebGL + WebCodecs + Worker + OffscreenCanvas only run in a real
///     browser. jsdom and pure-Node vitest can't exercise the renderer.
///   - Tauri's API helpers ARE imported transitively (projectStore,
///     runExport), but for empty-media fixtures none of them actually
///     CALL into Tauri — function refs sitting unused are harmless.
///     A future media-bearing fixture will need a different resolver
///     than `convertFileSrc`.

import { commands } from "@vitest/browser/context";
import { describe, expect, test } from "vitest";

import project from "../../../fixtures/001_color/project.json";
import manifest from "../../../fixtures/001_color/manifest.json";
import type { ProjectSummary } from "../../ipc";
import { runExport } from "../worker/runExport";
import { concatExportChunks } from "./runFixture";

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    writeFixtureMp4: (name: string, bytes: number[]) => Promise<string>;
  }
}

describe("001_color renders end-to-end through the export Worker", () => {
  test(
    "produces a non-empty MP4 + writes it to build/fixtures/",
    async () => {
      // Empty media map — 001_color references no external assets. The export
      // streams output chunks; buffer them (tiny fixture) into one MP4.
      const chunks: Uint8Array[] = [];
      const result = await runExport({
        summary: project as unknown as ProjectSummary,
        mediaById: new Map(),
        writeChunk: async (data) => {
          chunks.push(new Uint8Array(data));
        },
      });
      const videoBytes = concatExportChunks(chunks);

      expect(videoBytes.byteLength).toBeGreaterThan(0);
      expect(result.framesEncoded).toBe(result.totalFrames);
      expect(result.framesEncoded).toBeGreaterThan(0);

      // Hand the MP4 off to Node for the Rust CLI to pick up. Browser
      // mode serializes typed arrays as plain arrays through the
      // commands bridge; convert explicitly so the shape is obvious.
      const bytes = Array.from(new Uint8Array(videoBytes));
      const writtenPath = await commands.writeFixtureMp4(manifest.name, bytes);
      // eslint-disable-next-line no-console
      console.log(
        `[fixtures] wrote ${manifest.name} MP4 (${videoBytes.byteLength} bytes) → ${writtenPath}`,
      );
    },
    // The export Worker spins up Chromium WebCodecs decoders + encoders;
    // first-run encoder init can take several seconds on cold cache.
    // 90s is generous; CI tightens later if observed.
    90_000,
  );
});
