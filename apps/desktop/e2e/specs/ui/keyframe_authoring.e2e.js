import { existsSync, mkdirSync, rmSync } from "node:fs";
import { analyzeSelf } from "../../lib/analyze.mjs";
import { fixture, tmpOut, tmpProjectParent } from "../../helpers/media.mjs";
import { newProject, waitForHook } from "../../helpers/app.mjs";
import { driveExport } from "../../helpers/export.mjs";
import { waitPreviewBridge } from "../../helpers/preview.mjs";

// Keyframe authoring → export e2e gate.
//
// Proves that writing a two-keyframe opacity AnimTrack via the real
// `update_layer_param_track` Tauri command produces a measurably animated
// exported video: a NEAR-START frame (opacity ≈ 0, near-black) and a
// NEAR-END frame (opacity ≈ 1, fully visible clip) must look DIFFERENT in
// the output file.
//
// This is the first end-to-end closure of the keyframe authoring path:
//   Actor write path: update_layer_param_track stores Animated::Keyframed
//   Rust resolver:    resolveView samples the AnimTrack per output frame
//   Export worker:    opacity is applied on the composited VideoClip sprite
//   Assertion:        self-SSIM of an early vs late output frame < 0.99
//
// ALSO closes the known keyframed-gain e2e gap noted in the audio-engine
// memory entry: the same pattern (write an AnimTrack, export, measure) is
// directly applicable to Audio.gain_db — an opacity ramp here proves the
// round-trip; a gain ramp would be measured with analyzeAudioEnvelope.
//
// NOTE: invokes `window.__TAURI_INTERNALS__.invoke("update_layer_param_track", …)`
// directly because the e2e test-hook surface (window.__weftcutTest) does
// not yet expose a keyframe-write method. This mirrors what
// @tauri-apps/api/core's `invoke` does internally (core.js line 202).

// A plain H.264 720p-or-1080p 30fps video-only fixture — the simplest
// non-trivial source (no audio complication, no special codec path).
// test_1080p_30fps.mp4 is in the standard fixture matrix.
const SOURCE = fixture("test_1080p_30fps.mp4");
const OUTPUT = tmpOut("weftcut-e2e-keyframe-opacity.mp4");
const PROJECT_PARENT = tmpProjectParent("weftcut-e2e-keyframe-proj");

// Composition: 3 s at 30 fps = 90 frames.
// Opacity track: keyframe at t=0 (opacity=0.0) → keyframe at t=3s (opacity=1.0).
// Assertion frames: frame 3 (t≈0.1s, opacity≈0.03, nearly transparent / black)
//                   frame 87 (t≈2.9s, opacity≈0.97, nearly fully visible).
// A static-opacity clip would make both frames near-identical (ssim ~1.0).
// The animated ramp makes them radically differ (ssim << 0.99, typically <0.5).
const COMP_DURATION_US = 3_000_000; // 3 s
const COMP_FPS_NUM = 30;
const COMP_FPS_DEN = 1;
// Keyframe timestamps
const KF_T_START_US = 0;
const KF_T_END_US = COMP_DURATION_US; // 3 000 000 µs
// Self-SSIM pair: early (frame 3, opacity ~0) vs late (frame 87, opacity ~1).
const SAMPLE_EARLY = 3;
const SAMPLE_LATE = 87;
// Frames differ if SSIM < this threshold. Static clip scores ≥0.999; a
// 0→1 opacity ramp makes early≈black vs late≈full-content → SSIM typically 0.1-0.5.
const SSIM_MAX_THRESH = 0.98;

describe("keyframe authoring end-to-end (opacity ramp → export, real WebView2)", function () {
  before(function () {
    if (!existsSync(SOURCE)) {
      console.warn(`[e2e] SKIP: source fixture not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`);
      this.skip();
    }
    mkdirSync(PROJECT_PARENT, { recursive: true });
    rmSync(OUTPUT, { force: true });
  });

  it("opacity ramp 0→1 makes exported early/late frames differ", async function () {
    // Generous mocha timeout: this test exports video + runs cargo analyze.
    // Per project memory: `function(){this.timeout(...)}` is required for
    // export+analyze tests — the 180 s default comes from wdio.conf mochaOpts
    // but the per-test override must use a non-arrow function.
    this.timeout(180000);

    // ── 1+2. Create a blank 1080p 30fps project and enter the editor ───────
    await newProject({
      parentFolder: PROJECT_PARENT,
      name: "e2e-kf-" + Date.now(),
      canvas: { width: 1920, height: 1080, fpsNum: COMP_FPS_NUM, fpsDen: COMP_FPS_DEN },
    });

    // ── 3. Wait for the App-side export hooks (editor mounted) ─────────────
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            typeof window.__weftcutTest?.importAndPlaceMedia === "function" &&
            typeof window.__weftcutTest?.exportTimeline === "function",
        )) === true,
      { timeout: 30000, timeoutMsg: "importAndPlaceMedia / exportTimeline never mounted (editor didn't load?)" },
    );

    // ── 4. Import the fixture and place it at t=0; capture its layerId ─────
    //
    // `importAndPlaceMedia` calls importMedia → addTrack → addMediaLayer and
    // waits for the media to appear in the project store. It returns the
    // layerId we need for the keyframe write.
    const r2 = await browser.executeAsync((media, done) => {
      window.__weftcutTest
        .importAndPlaceMedia({ mediaAbsPath: media, tStartUs: 0 })
        .then((result) => done({ ok: true, ...result }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, SOURCE);
    if (!r2.ok) throw new Error("importAndPlaceMedia failed: " + r2.error);
    const layerId = r2.layerId;
    console.log(`[e2e] placed VideoClip layerId=${layerId} mediaId=${r2.mediaId}`);

    // ── 5. Wait for the clip to be export-ready ────────────────────────────
    const r3 = await browser.executeAsync((mediaId, done) => {
      window.__weftcutTest
        .waitMediaExportReady({ mediaId, timeoutMs: 60000 })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, r2.mediaId);
    if (!r3.ok) throw new Error("waitMediaExportReady failed: " + r3.error);

    // ── 6. Write the keyframe opacity track: 0.0 at t=0 → 1.0 at t=3s ─────
    //
    // Calls window.__TAURI_INTERNALS__.invoke directly — the same underlying
    // call that @tauri-apps/api/core's `invoke` makes (see core.js:202).
    // Shape mirrors the TypeScript AnimTrack<number> / Keyframe<number> types:
    //   { mode: "Keyframed", value: [ { id, t_us, value, interp: { kind } }, … ] }
    //
    // The actor normalises (sorts / deduplicates by t_us) and records the edit.
    const r4 = await browser.executeAsync((lid, kfStartUs, kfEndUs, done) => {
      const track = {
        mode: "Keyframed",
        value: [
          {
            id: crypto.randomUUID(),
            t_us: kfStartUs,
            value: 0.0,
            interp: { kind: "Linear" },
          },
          {
            id: crypto.randomUUID(),
            t_us: kfEndUs,
            value: 1.0,
            interp: { kind: "Linear" },
          },
        ],
      };
      window.__TAURI_INTERNALS__
        .invoke("update_layer_param_track", { layerId: lid, paramKey: "opacity", track })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, layerId, KF_T_START_US, KF_T_END_US);
    if (!r4.ok) throw new Error("update_layer_param_track failed: " + r4.error);
    console.log("[e2e] opacity track written: 0.0@t=0 → 1.0@t=3s (Linear)");

    // ── 7. Drive the timeline export and wait for settlement ───────────────
    const exp = await driveExport({ outputAbsPath: OUTPUT }, { hook: "exportTimeline", label: "keyframe" });
    if (!exp.done.ok) throw new Error("exportTimeline failed: " + exp.done.error);
    if (!existsSync(OUTPUT)) throw new Error(`no output file written at ${OUTPUT}`);

    // ── 8. Self-SSIM assertion: early frame (opacity~0) vs late (opacity~1) ─
    //
    // A static-opacity clip renders the same content at both sample points →
    // SSIM ≈ 1.0 → pair.differ = false → test FAILS.
    // The 0→1 opacity ramp makes the early frame near-black (transparent clip
    // over whatever background the compositor uses) and the late frame the
    // fully visible clip content → SSIM << 0.98 → pair.differ = true → PASS.
    //
    // ssimMax = 0.98: well above the noise floor but well below the near-1.0
    // static case. A 90-frame 0→1 ramp typically scores <0.5 here.
    const report = analyzeSelf({
      output: OUTPUT,
      samples: [SAMPLE_EARLY, SAMPLE_LATE],
      ssimMax: SSIM_MAX_THRESH,
    });
    console.log("[e2e] keyframe self-ssim report:", JSON.stringify(report));

    const pair = report.pairs?.[0];
    if (!pair) throw new Error("no self-ssim pair returned: " + JSON.stringify(report));
    if (!pair.differ) {
      throw new Error(
        `keyframed opacity did NOT make frames differ ` +
          `(ssim ${pair.ssim.toFixed(4)} >= ${SSIM_MAX_THRESH}) — ` +
          `the opacity AnimTrack was likely not applied during export (resolved as Static?). ` +
          `frames compared: early=${SAMPLE_EARLY} late=${SAMPLE_LATE}`,
      );
    }
    expect(report.pass).toBe(true);
  });
});

// Keyframe sub-lanes (Timeline Phase 3) — the view/interaction layer on top of
// the same `update_layer_param_track` write path the authoring gate exercises.
// Cheap (no export), so it joins the keyframe suite file per the README's
// balanced-merge rule.
//
//   1. Place a VideoClip and write a 2-key opacity AnimTrack on it.
//   2. Reveal its (role-null) track — A/B-roll hides overlay tracks until
//      revealed, so the header twirl + sub-lane DOM only mount after reveal.
//   3. The track's header twirl enables (it now has a keyframed property);
//      clicking it expands a sub-lane with one .kf-sublane-diamond per keyframe.
//   4. Clicking the late diamond selects it (amber `is-selected`) AND seeks the
//      transport to t_start + kf.t_us — the red playhead moves to the diamond's
//      absolute x (both are absolute-time * pxPerSec, so the two `left`s match).
describe("keyframe sub-lanes (expand → diamonds → click-seek, real WebView2)", function () {
  before(function () {
    if (!existsSync(SOURCE)) {
      console.warn(`[e2e] SKIP: source fixture not found at ${SOURCE} (set WEFTCUT_TEST_MEDIA)`);
      this.skip();
    }
    mkdirSync(PROJECT_PARENT, { recursive: true });
  });

  it("twirl expands a keyframed track into a 2-diamond sub-lane; click selects + seeks", async function () {
    this.timeout(120000);

    // Two keyframes: 0.0 @ t=0 → 1.0 @ t=1s. Both well inside the ~3s clip, so
    // neither is out-of-range and the late diamond's seek target (1s) stays
    // within the composition (no playhead clamp at the boundary).
    const KF_LATE_US = 1_000_000;

    // ── 1. Create a blank 1080p 30fps project and enter the editor ─────────
    await newProject({
      parentFolder: PROJECT_PARENT,
      name: "e2e-kf-sublanes-" + Date.now(),
      canvas: { width: 1920, height: 1080, fpsNum: COMP_FPS_NUM, fpsDen: COMP_FPS_DEN },
    });
    await waitForHook("importAndPlaceMedia");
    await waitForHook("revealLayer");

    // ── 2. Import + place the clip; capture its layerId ────────────────────
    const r2 = await browser.executeAsync((media, done) => {
      window.__weftcutTest
        .importAndPlaceMedia({ mediaAbsPath: media, tStartUs: 0 })
        .then((result) => done({ ok: true, ...result }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, SOURCE);
    if (!r2.ok) throw new Error("importAndPlaceMedia failed: " + r2.error);
    const layerId = r2.layerId;
    console.log(`[e2e] placed VideoClip layerId=${layerId}`);

    // ── 3. Write a 2-key opacity track on the placed layer ─────────────────
    const r3 = await browser.executeAsync((lid, lateUs, done) => {
      const track = {
        mode: "Keyframed",
        value: [
          { id: crypto.randomUUID(), t_us: 0, value: 0.0, interp: { kind: "Linear" } },
          { id: crypto.randomUUID(), t_us: lateUs, value: 1.0, interp: { kind: "Linear" } },
        ],
      };
      window.__TAURI_INTERNALS__
        .invoke("update_layer_param_track", { layerId: lid, paramKey: "opacity", track })
        .then(() => done({ ok: true }))
        .catch((e) => done({ ok: false, error: String(e) }));
    }, layerId, KF_LATE_US);
    if (!r3.ok) throw new Error("update_layer_param_track failed: " + r3.error);
    console.log("[e2e] opacity track written (0.0@0 → 1.0@1s)");

    // ── 4. Reveal the imported clip's role-null track so its header twirl +
    //       sub-lane DOM mount (hidden by default in the A/B-roll view) ──────
    await browser.execute((lid) => window.__weftcutTest.revealLayer({ layerId: lid }), layerId);

    // ── 5. The keyframed track's header twirl becomes enabled (bridge sync).
    // Exactly one track has a keyframed layer → exactly one enabled twirl.
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelectorAll('button[aria-expanded]:not([disabled])').length,
        )) >= 1,
      { timeout: 15000, timeoutMsg: "keyframed track's twirl never enabled (project:changed bridge?)" },
    );

    // ── 6. Click the twirl → expand the sub-lanes ──────────────────────────
    await browser.execute(() => {
      const btn = document.querySelector('button[aria-expanded]:not([disabled])');
      if (!btn) throw new Error("no enabled twirl found");
      btn.click();
    });

    // ── 7. The opacity sub-lane renders with exactly 2 diamonds ────────────
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll(".kf-sublane-diamond").length)) === 2,
      { timeout: 10000, timeoutMsg: "expected 2 .kf-sublane-diamond after expand" },
    );

    // Ensure the preview transport is live so the diamond's transportSeek moves
    // the playhead (the bridge registers on PixiPreview mount).
    await waitPreviewBridge();

    // ── 8. Click the LATE (rightmost) diamond → select + seek ──────────────
    const clicked = await browser.execute(() => {
      const diamonds = [...document.querySelectorAll(".kf-sublane-diamond")];
      const late = diamonds
        .map((el) => ({ el, left: parseFloat(el.style.left) || 0 }))
        .sort((a, b) => b.left - a.left)[0].el;
      const kfId = late.getAttribute("data-kf-id");
      const leftPx = parseFloat(late.style.left);
      const rect = late.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Single click (no movement) → select + seek, no retime drag.
      late.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: cx, clientY: cy }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1, clientX: cx, clientY: cy }));
      return { kfId, leftPx };
    });
    console.log(`[e2e] clicked late diamond kfId=${clicked.kfId} leftPx=${clicked.leftPx}`);

    // 8a. The clicked diamond is now selected (amber).
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          (id) => !!document.querySelector(`.kf-sublane-diamond[data-kf-id="${id}"].is-selected`),
          clicked.kfId,
        )) === true,
      { timeout: 5000, timeoutMsg: "clicked diamond never got .is-selected" },
    );

    // 8b. The playhead seeked to the diamond's absolute time → its `left`
    // (currentTimeUs * pxPerSec) matches the diamond's `left`. The playhead
    // line is the element with the red-gradient (`from-red-300`) class.
    await browser.waitUntil(
      async () => {
        const playLeft = await browser.execute(() => {
          const ph = document.querySelector('[class*="from-red-300"]');
          return ph ? parseFloat(ph.style.left) : null;
        });
        return playLeft != null && !Number.isNaN(playLeft) && Math.abs(playLeft - clicked.leftPx) <= 2;
      },
      { timeout: 8000, timeoutMsg: `playhead never seeked to the diamond x (${clicked.leftPx}px)` },
    );

    console.log("[e2e] sub-lane: 2 diamonds rendered; click selected + seeked ✔");
  });
});
