import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR =
  process.env.WEFTCUT_TEST_MEDIA || path.resolve(HERE, "..", "fixtures", "media");
// apps/desktop/e2e/specs -> repo root (analyze.mjs uses the same shape from lib/).
const REPO = path.resolve(HERE, "..", "..", "..", "..");

const SOURCE_RAMP = path.resolve(MEDIA_DIR, "test_1080p_gradient10_h264.mp4");
const SOURCE_BF = path.resolve(MEDIA_DIR, "test_1080p_gradient10_h264_bf.mp4");
const SOURCE_AV1 = path.resolve(MEDIA_DIR, "test_1080p_gradient10_av1.mp4");
const SOURCE_4K = path.resolve(MEDIA_DIR, "test_2160p_gradient10_h264.mp4");
const OUTPUT_RAMP = path.resolve(os.tmpdir(), "weftcut-e2e-10bit-ramp.mp4");
const OUTPUT_BF = path.resolve(os.tmpdir(), "weftcut-e2e-10bit-bf.mp4");
const OUTPUT_AV1 = path.resolve(os.tmpdir(), "weftcut-e2e-10bit-av1.mp4");
const OUTPUT_4K = path.resolve(os.tmpdir(), "weftcut-e2e-10bit-4k.mp4");
const PROJECT_PARENT = path.resolve(os.tmpdir(), "weftcut-e2e-10bit-proj");

// 10-bit export settings: f16/WebGL2 composite -> yuv420p10le pack -> loopback
// WS -> Rust ffmpeg sink (HEVC Main10). audio.include=false keeps the gate
// video-only (the audio axis has its own specs).
const TEN_BIT_SETTINGS = {
  codec: "hevc",
  bitDepth: 10,
  container: "mp4",
  audio: { include: false },
};

// The source ramp carries ~877 distinct 10-bit luma levels across the mid-row.
// > 256 proves 10 bits survived AT ALL (an 8-bit collapse caps at 256);
// > 600 proves the decode -> f16 ingest -> pack -> encode chain didn't
// grossly band it either.
const DISTINCT_FLOOR = 600;

/// ffprobe the first video stream's named entries into a {key: value} map.
function probeVideoStream(file, entries, extraArgs = []) {
  const r = spawnSync(
    "ffprobe",
    [
      "-v", "error", "-select_streams", "v:0", ...extraArgs,
      "-show_entries", `stream=${entries}`, "-of", "default=nw=1", file,
    ],
    { encoding: "utf8" },
  );
  if (r.error || r.status !== 0) {
    throw new Error(`ffprobe failed for ${file}: ${r.stderr ?? r.error}`);
  }
  const out = {};
  for (const line of r.stdout.trim().split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/// The conformance analyzer's gradient meter — the same `media_conformance
/// --gradient-row` invocation the axis-B color probe uses (decode one frame
/// as 16-bit RGB under a forced matrix, count distinct levels + max plateau
/// across the mid-row).
function gradientReport(output, sample) {
  const r = spawnSync(
    "cargo",
    [
      "run", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml",
      "--bin", "media_conformance", "--quiet", "--",
      "--gradient-row", "--output", output, "--source", output,
      "--in-matrix", "bt709", "--in-range", "tv", "--sample", String(sample),
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `media_conformance --gradient-row exit ${r.status}: ${r.stdout}\n${r.stderr}`,
    );
  }
}

/// Boot a fresh project (1080p30 canvas) and run the REAL export of `source`
/// to `output` through the 10-bit settings. Fire-and-forget + poll the
/// mirrored frame counter so a pipeline hang reports its exact stall frame
/// (the reorder-tail deadlock class pins the counter at a chunk boundary)
/// instead of timing out blind. Returns the perf counters (or null).
async function bootAndExport(source, output, name, canvas = { width: 1920, height: 1080 }) {
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => typeof window.__weftcutTest?.newProjectAndEnter === "function",
      )) === true,
    { timeout: 30000, timeoutMsg: "newProjectAndEnter never mounted" },
  );

  const r1 = await browser.executeAsync((parent, nm, cv, done) => {
    window.__weftcutTest
      .newProjectAndEnter({
        parentFolder: parent,
        name: nm + Date.now(),
        canvas: { width: cv.width, height: cv.height, fpsNum: 30, fpsDen: 1 },
      })
      .then(() => done({ ok: true }))
      .catch((e) => done({ ok: false, error: String(e) }));
  }, PROJECT_PARENT, name, canvas);
  if (!r1.ok) throw new Error("newProjectAndEnter failed: " + r1.error);

  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () => typeof window.__weftcutTest?.exportClip === "function",
      )) === true,
    { timeout: 30000, timeoutMsg: "exportClip never mounted (editor didn't load?)" },
  );

  await browser.execute(
    (media, out, settings) => {
      window.__e2eExportDone = null;
      window.__weftcutExportPerf = null;
      window.__weftcutTest
        .exportClip({ mediaAbsPath: media, outputAbsPath: out, settings })
        .then(() => {
          window.__e2eExportDone = { ok: true };
        })
        .catch((e) => {
          window.__e2eExportDone = { ok: false, error: String(e) };
        });
    },
    source,
    output,
    TEN_BIT_SETTINGS,
  );

  let lastFrame = -1;
  let lastKind = null;
  let settled = null;
  try {
    await browser.waitUntil(
      async () => {
        const snap = await browser.execute(() => {
          const st = window.__weftcutExportState;
          return {
            done: window.__e2eExportDone,
            kind: st?.kind ?? null,
            phase: st?.progress?.phase ?? null,
            frame: st?.progress?.frame ?? null,
            detail: st?.detail ?? null,
          };
        });
        if (snap.frame != null && snap.frame !== lastFrame) {
          lastFrame = snap.frame;
          console.log(
            `[e2e] export ${snap.kind}/${snap.phase ?? "-"} frame=${snap.frame}`,
          );
        }
        if (snap.kind && snap.kind !== lastKind) {
          lastKind = snap.kind;
          console.log(
            `[e2e] export phase -> ${snap.kind}${snap.detail ? ` (${snap.detail})` : ""}`,
          );
        }
        if (snap.done) {
          settled = snap.done;
          return true;
        }
        return false;
      },
      { timeout: 560000, interval: 1000 },
    );
  } catch (e) {
    throw new Error(
      `10-bit export never settled (last kind=${lastKind}, last frame=${lastFrame}): ${e.message}`,
    );
  }
  if (!settled.ok) throw new Error("exportClip failed: " + settled.error);

  const perf = await browser.execute(() => window.__weftcutExportPerf ?? null);
  if (perf) {
    const ratio = (perf.totalDispatched / Math.max(1, perf.totalFrames)).toFixed(2);
    console.log(
      `[e2e] export perf: dispatched=${perf.totalDispatched} for ${perf.totalFrames} frames ` +
        `(${ratio}x) | decode=${perf.decodeMs}ms wait=${perf.waitMs}ms total=${perf.totalMs}ms`,
    );
  }
  return perf;
}

// 10-bit export gates: the first time the whole pipeline (Hi10P original ->
// CPU-plane TenBitFrame lane -> RG8->f16 ingest -> f16 composite ->
// yuv420p10le pack -> loopback WS -> ffmpeg Main10 encode) runs end to end.
describe("10-bit export pipeline (real WebView2)", function () {
  before(function () {
    for (const src of [SOURCE_RAMP, SOURCE_BF, SOURCE_AV1, SOURCE_4K]) {
      if (!existsSync(src)) {
        console.warn(
          `[e2e] SKIP: source media not found at ${src} (run: node fixtures/generate-fixtures.mjs)`,
        );
        this.skip();
      }
    }
    mkdirSync(PROJECT_PARENT, { recursive: true });
    rmSync(OUTPUT_RAMP, { force: true });
    rmSync(OUTPUT_BF, { force: true });
    rmSync(OUTPUT_AV1, { force: true });
    rmSync(OUTPUT_4K, { force: true });
  });

  it("10-bit survives end-to-end (gradient ramp keeps >600 distinct steps)", async function () {
    // 1s clip = 30 frames, but the import-side proxy + the 10-bit probe chain
    // and the analyzer's cargo build all bill against this test.
    this.timeout(600000);

    await bootAndExport(SOURCE_RAMP, OUTPUT_RAMP, "e2e-10bit-ramp-");
    if (!existsSync(OUTPUT_RAMP)) {
      throw new Error(`export produced no output at ${OUTPUT_RAMP}`);
    }

    // Container/codec shape: HEVC Main 10, a 10-bit pixel format, and the
    // BT.709 limited tags the sink's ffmpeg stamps.
    const st = probeVideoStream(
      OUTPUT_RAMP,
      "codec_name,profile,pix_fmt,color_space,color_transfer,color_primaries,color_range",
    );
    console.log("[e2e] 10-bit output stream:", JSON.stringify(st));
    expect(st.codec_name).toBe("hevc");
    expect(["yuv420p10le", "p010le"]).toContain(st.pix_fmt);
    expect(st.profile).toContain("Main 10");
    expect(st.color_space).toBe("bt709");
    expect(st.color_transfer).toBe("bt709");
    expect(st.color_primaries).toBe("bt709");
    expect(st.color_range).toBe("tv");

    // Gradient meter: distinct 10-bit steps across the output's mid-row.
    // An 8-bit collapse anywhere in the chain caps this at 256.
    const report = gradientReport(OUTPUT_RAMP, 10);
    const luma = report.banding[0];
    console.log(
      `[e2e] gradient meter: distinct_levels=${luma.distinct_levels} ` +
        `max_plateau=${luma.max_plateau} (floor ${DISTINCT_FLOOR})`,
    );
    expect(luma.distinct_levels).toBeGreaterThan(DISTINCT_FLOOR);
  });

  it("AV1-10 source survives end-to-end (dav1d prefer-software lane)", async function () {
    // The second tenBitExportCapable codec: an AV1 10-bit ORIGINAL routes
    // through the same CPU-plane lane. preferSoftware is a CORRECTNESS
    // requirement here — the hardware AV1 decoder "succeeds" but emits opaque
    // format=null frames with no copyTo (probed in real WebView2); only the
    // dav1d software path yields readable I420P10 planes.
    this.timeout(600000);

    await bootAndExport(SOURCE_AV1, OUTPUT_AV1, "e2e-10bit-av1-");
    if (!existsSync(OUTPUT_AV1)) {
      throw new Error(`export produced no output at ${OUTPUT_AV1}`);
    }

    const st = probeVideoStream(
      OUTPUT_AV1,
      "codec_name,profile,pix_fmt,color_space,color_transfer,color_primaries,color_range",
    );
    console.log("[e2e] AV1-10-source output stream:", JSON.stringify(st));
    expect(st.codec_name).toBe("hevc");
    expect(["yuv420p10le", "p010le"]).toContain(st.pix_fmt);
    expect(st.profile).toContain("Main 10");
    expect(st.color_space).toBe("bt709");
    expect(st.color_range).toBe("tv");

    // The SVT-AV1 ramp decodes to ~875 distinct mid-row levels (probe) — the
    // same >600 floor proves the AV1 ingest didn't collapse to the 8-bit proxy.
    const report = gradientReport(OUTPUT_AV1, 10);
    const luma = report.banding[0];
    console.log(
      `[e2e] AV1-10 gradient meter: distinct_levels=${luma.distinct_levels} ` +
        `max_plateau=${luma.max_plateau} (floor ${DISTINCT_FLOOR})`,
    );
    expect(luma.distinct_levels).toBeGreaterThan(DISTINCT_FLOOR);
  });

  it("4K 10-bit export completes under the resolution-derived ring cap", async function () {
    // A 4K I420P10 frame is ~24.9 MB — the ring's resolution-derived
    // high-water clamps to its 20-entry floor (~500 MB) instead of the flat
    // 48 entries (~1.2 GB). Completion here is the deadlock-freedom proof at
    // the floor: the copy chain blocks at 20 entries and must always be
    // reopened by consumer-side eviction. 4K SW Hi10P decode is slow; the
    // fixture is 1s (30 frames) to keep the case bounded.
    this.timeout(600000);

    await bootAndExport(SOURCE_4K, OUTPUT_4K, "e2e-10bit-4k-", { width: 3840, height: 2160 });
    if (!existsSync(OUTPUT_4K)) {
      throw new Error(`export produced no output at ${OUTPUT_4K}`);
    }

    const st = probeVideoStream(
      OUTPUT_4K,
      "codec_name,profile,pix_fmt,width,height",
    );
    console.log("[e2e] 4K output stream:", JSON.stringify(st));
    expect(st.codec_name).toBe("hevc");
    expect(["yuv420p10le", "p010le"]).toContain(st.pix_fmt);
    expect(st.profile).toContain("Main 10");
    expect(Number(st.width)).toBe(3840);
    expect(Number(st.height)).toBe(2160);

    // 10 bits must survive at 4K too (the ramp spans 3840 columns onto 1024
    // levels — same >600 floor as the 1080p case).
    const report = gradientReport(OUTPUT_4K, 10);
    const luma = report.banding[0];
    console.log(
      `[e2e] 4K gradient meter: distinct_levels=${luma.distinct_levels} ` +
        `max_plateau=${luma.max_plateau} (floor ${DISTINCT_FLOOR})`,
    );
    expect(luma.distinct_levels).toBeGreaterThan(DISTINCT_FLOOR);
  });

  it("B-frame long-GOP 10-bit export completes (reorder-tail regression)", async function () {
    // 300 frames through the SW 10-bit decode + pack + WS + ffmpeg encode —
    // well below realtime; budget generously. A deadlock here = the reorder
    // tail regression (the frame counter pins at a chunk boundary).
    this.timeout(600000);

    const perf = await bootAndExport(SOURCE_BF, OUTPUT_BF, "e2e-10bit-bf-");
    if (!existsSync(OUTPUT_BF)) {
      throw new Error(`export produced no output at ${OUTPUT_BF}`);
    }
    if (perf && perf.totalFrames !== 300) {
      throw new Error(`expected a 300-frame plan (10s @ 30fps), got ${perf.totalFrames}`);
    }

    // Every planned frame must have reached the encoder: a wedged tail that
    // somehow resolved late would still come up short here.
    const st = probeVideoStream(OUTPUT_BF, "codec_name,nb_read_packets", [
      "-count_packets",
    ]);
    console.log("[e2e] bf output:", JSON.stringify(st));
    expect(st.codec_name).toBe("hevc");
    const packets = Number(st.nb_read_packets);
    expect(packets).toBeGreaterThanOrEqual(299);
    expect(packets).toBeLessThanOrEqual(301);
  });
});
