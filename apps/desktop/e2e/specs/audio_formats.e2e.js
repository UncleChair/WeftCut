import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { analyze } from "../lib/analyze.mjs";

const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-audiofmt-proj");

// AUDIO-ONLY sources end-to-end, per format the import dialog offers: import
// (probe + classify as Audio) → conform (ffmpeg → VCONF) → Audio layer →
// export mix → AAC-in-mp4, verified by `media_conformance --audio` against
// the per-second tone markers (F_k = 400 + 120k Hz) baked into the fixtures.
//
// This is the pipeline gate; the FORMAT range itself is pinned cheaply by the
// Rust unit matrix (jobs::conform::tests::conform_format_matrix_*). The mp3
// fixture carries embedded attached_pic cover art — the real-world mp3 shape
// that used to misclassify as Video (probe::detect_kind regression): if that
// regresses, the placed layer is a VideoClip whose proxy can never land and
// the export-ready wait times out loudly.
const FORMATS = ["wav", "mp3", "flac", "m4a", "ogg"];

describe("audio-only format matrix (real WebView2)", function () {
  before(function () {
    mkdirSync(PROJECT_PARENT, { recursive: true });
  });

  for (const fmt of FORMATS) {
    const source = path.resolve(MEDIA_DIR, `test_tones_10s.${fmt}`);
    const output = path.resolve(os.tmpdir(), `weftcut-e2e-audiofmt-${fmt}.mp4`);

    it(`${fmt} source -> mp4 export stays aligned + faithful`, async function () {
      if (!existsSync(source)) {
        console.warn(`[e2e] SKIP: audio source not found at ${source}`);
        this.skip();
      }
      rmSync(output, { force: true });

      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () => typeof window.__weftcutTest?.newProjectAndEnter === "function",
          )) === true,
        { timeout: 30000, timeoutMsg: "newProjectAndEnter never mounted" },
      );
      const r1 = await browser.executeAsync((parent, name, done) => {
        window.__weftcutTest
          .newProjectAndEnter({
            parentFolder: parent,
            name,
            canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
          })
          .then(() => done({ ok: true }))
          .catch((e) => done({ ok: false, error: String(e) }));
      }, PROJECT_PARENT, `e2e-audiofmt-${fmt}-` + Date.now());
      if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);

      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () => typeof window.__weftcutTest?.exportClip === "function",
          )) === true,
        { timeout: 30000, timeoutMsg: "exportClip never mounted" },
      );

      await browser.execute(
        (media, out) => {
          window.__e2eExportDone = null;
          window.__weftcutTest
            .exportClip({ mediaAbsPath: media, outputAbsPath: out, settings: { container: "mp4" } })
            .then(() => { window.__e2eExportDone = { ok: true }; })
            .catch((e) => { window.__e2eExportDone = { ok: false, error: String(e) }; });
        },
        source,
        output,
      );

      let lastKind = null;
      let lastDetail = null;
      let settled = null;
      try {
        await browser.waitUntil(
          async () => {
            const snap = await browser.execute(() => {
              const st = window.__weftcutExportState;
              return {
                done: window.__e2eExportDone,
                kind: st?.kind ?? null,
                detail: st?.detail ?? null,
              };
            });
            if (snap.kind != null) lastKind = snap.kind;
            if (snap.detail != null) lastDetail = snap.detail;
            if (snap.done) { settled = snap.done; return true; }
            return false;
          },
          { timeout: 150000, interval: 1000 },
        );
      } catch (e) {
        throw new Error(
          `export never settled (kind=${lastKind}, detail=${lastDetail}): ${e.message}`,
        );
      }
      if (!settled.ok) {
        throw new Error(
          `exportClip failed: ${settled.error} | exportState kind=${lastKind} detail=${lastDetail}`,
        );
      }

      const report = analyze({ output, source, samples: [0], audio: true });
      console.log(`[e2e] audio-only report ${fmt}:`, JSON.stringify(report));

      const misaligned = report.samples.filter((s) => !s.aligned);
      if (misaligned.length > 0) {
        throw new Error("audio seconds misaligned: " +
          JSON.stringify(misaligned.map((s) => ({ second: s.second, detected: s.detected_freq }))));
      }
      expect(Math.abs(report.drift_slope - 1)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(report.offset_ms)).toBeLessThanOrEqual(66);
      expect(report.pass).toBe(true);
    });
  }
});
