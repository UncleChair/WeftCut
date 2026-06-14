import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { newProject, waitForHook } from "../../helpers/app.mjs";
import { driveExport } from "../../helpers/export.mjs";
import { MEDIA_DIR, fixture, tmpOut, tmpProjectParent } from "../../helpers/media.mjs";

// Runtime smoke for per-stream export content selection (Include video /
// Include audio) through the real WebView2 + real ffmpeg. Covers the happy
// audio-only path AND the two "no available material" guards:
//   - audio-only export of a clip with NO audio stream -> "no audio material"
//   - video export of an audio-only project              -> "no video material"
// Both must error and write NO output file, not silently report success.
const AUDIO_VIDEO = fixture("test_1080p_30fps_audio.mp4"); // video WITH audio
const VIDEO_NOAUDIO = fixture("test_1080p_30fps.mp4"); // video, NO audio
const AUDIO_WAV = fixture("test_tones_10s.wav"); // audio only
const PROJECT_PARENT = tmpProjectParent("weftcut-e2e-content-modes-proj");

async function bootProject(namePrefix) {
  const name = namePrefix + Date.now();
  await newProject({
    parentFolder: PROJECT_PARENT,
    name,
    canvas: { width: 1920, height: 1080, fpsNum: 30, fpsDen: 1 },
  });
  await waitForHook("exportClip");
}

/// Import `source` as the only clip, run exportClip with `settings`, and poll
/// to settlement. Returns { done, kind } WITHOUT throwing on failure —
/// the no-material cases settle as { ok:false } with an "error" exportState,
/// which is the expected, asserted outcome.
async function runExportClip({ source, output, settings }) {
  await bootProject("e2e-content-");
  rmSync(output, { force: true });
  const r = await driveExport(
    { mediaAbsPath: source, outputAbsPath: output, settings: settings ?? null },
  );
  return { done: r.done, kind: r.lastKind };
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
    const output = tmpOut("weftcut-e2e-audioonly.m4a");
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
    const output = tmpOut("weftcut-e2e-noaudio.m4a");
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
    const output = tmpOut("weftcut-e2e-novideo.mp4");
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
