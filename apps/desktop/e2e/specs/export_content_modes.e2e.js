import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Runtime smoke for per-stream export content selection (Include video /
// Include audio) through the real WebView2 + real ffmpeg. Covers the happy
// audio-only path AND the two "no available material" guards:
//   - audio-only export of a clip with NO audio stream -> "no audio material"
//   - video export of an audio-only project              -> "no video material"
// Both must error and write NO output file, not silently report success.
const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "media");
const AUDIO_VIDEO = path.resolve(MEDIA_DIR, "test_1080p_30fps_audio.mp4"); // video WITH audio
const VIDEO_NOAUDIO = path.resolve(MEDIA_DIR, "test_1080p_30fps.mp4"); // video, NO audio
const AUDIO_WAV = path.resolve(MEDIA_DIR, "test_tones_10s.wav"); // audio only
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-content-modes-proj");

async function bootProject(namePrefix) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => typeof window.__weftcutTest?.newProjectAndEnter === "function",
      )) === true,
    { timeout: 30000, timeoutMsg: "newProjectAndEnter never mounted" },
  );
  const name = namePrefix + Date.now();
  const r1 = await browser.executeAsync((parent, projName, done) => {
    window.__weftcutTest
      .newProjectAndEnter({
        parentFolder: parent,
        name: projName,
        canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
      })
      .then(() => done({ ok: true }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, PROJECT_PARENT, name);
  if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => typeof window.__weftcutTest?.exportClip === "function",
      )) === true,
    { timeout: 30000, timeoutMsg: "exportClip never mounted" },
  );
}

/// Import `source` as the only clip, run exportClip with `settings`, and poll
/// to settlement. Returns { done, kind, detail } WITHOUT throwing on failure —
/// the no-material cases settle as { ok:false } with an "error" exportState,
/// which is the expected, asserted outcome.
async function runExportClip({ source, output, settings }) {
  await bootProject("e2e-content-");
  rmSync(output, { force: true });
  await browser.execute(
    (media, out, s) => {
      window.__e2eExportDone = null;
      window.__weftcutTest
        .exportClip({ mediaAbsPath: media, outputAbsPath: out, settings: s })
        .then(() => { window.__e2eExportDone = { ok: true }; })
        .catch((e) => { window.__e2eExportDone = { ok: false, error: String(e) }; });
    },
    source,
    output,
    settings ?? null,
  );
  let kind = null;
  let detail = null;
  let done = null;
  await browser.waitUntil(
    async () => {
      const snap = await browser.execute(() => ({
        done: window.__e2eExportDone,
        kind: window.__weftcutExportState?.kind ?? null,
        detail: window.__weftcutExportState?.detail ?? null,
      }));
      if (snap.kind != null) kind = snap.kind;
      if (snap.detail != null) detail = snap.detail;
      if (snap.done) { done = snap.done; return true; }
      return false;
    },
    { timeout: 170000, interval: 1000 },
  );
  return { done, kind, detail };
}

function hasAudioStream(file) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  if (r.error) return null; // ffprobe not on PATH -> soft-skip
  return r.stdout.trim().length > 0;
}

describe("export content selection (real WebView2)", function () {
  before(function () {
    if (!existsSync(AUDIO_VIDEO) || !existsSync(VIDEO_NOAUDIO) || !existsSync(AUDIO_WAV)) {
      console.warn(`[e2e] SKIP suite: content-mode fixtures missing under ${MEDIA_DIR}`);
      this.skip();
    }
    mkdirSync(PROJECT_PARENT, { recursive: true });
  });

  it("audio-only export of a clip with audio produces an audio file with no video", async function () {
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-audioonly.m4a");
    const { done } = await runExportClip({
      source: AUDIO_VIDEO,
      output,
      settings: { includeVideo: false, includeAudio: true },
    });
    expect(done.ok).toBe(true);
    expect(existsSync(output)).toBe(true);
    const audio = hasAudioStream(output);
    if (audio !== null) expect(audio).toBe(true);
  });

  it("audio-only export of a clip with NO audio errors with 'no audio material' and writes nothing", async function () {
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-noaudio.m4a");
    const { done, kind } = await runExportClip({
      source: VIDEO_NOAUDIO,
      output,
      settings: { includeVideo: false, includeAudio: true },
    });
    expect(kind).toBe("error");
    expect(done.ok).toBe(false); // exportClip threw: no output file produced
    expect(existsSync(output)).toBe(false);
  });

  it("video export of an audio-only project errors with 'no video material' and writes nothing", async function () {
    const output = path.resolve(os.tmpdir(), "weftcut-e2e-novideo.mp4");
    const { done, kind } = await runExportClip({
      source: AUDIO_WAV,
      output,
      settings: { includeVideo: true, includeAudio: true },
    });
    expect(kind).toBe("error");
    expect(done.ok).toBe(false);
    expect(existsSync(output)).toBe(false);
  });
});
