// Phase B4 — WebCodecs + WebGL2 capability probe.
//
// Replaces B1's minimal `probeWebCodecsCapability` (decoder.ts) with
// a richer two-stage probe used by both the settings UI and B5's
// mode-resolution logic. Stage 1 is the API + isConfigSupported
// check the user can verify in the settings panel; stage 2 (real
// decode of a bundled test clip) is deferred to B6 where it lives
// alongside the mid-session fallback that triggers on the same
// failure modes.
//
// Stage 1 catches:
//   * VideoDecoder global missing (older WebView2, WebKitGTK < 2.46)
//   * isConfigSupported(avc1.640028) = false (codec rejected)
//   * WebGL2 context creation refused (headless build, GPU blocked)
//
// What this does NOT catch (and stage 2 will):
//   * "supported=true" but the decoder stalls in practice (WebKitGTK
//     historical bug)
//   * SW-only decode that can't keep up with realtime playback
//   * GPU init reports OK but draw calls produce nothing
//
// B4 is enough to make the Auto preference safe on the only
// platform we currently ship (WebView2 on Windows). Linux + macOS
// reliability waits for stage 2.

export type CapabilityStage = "api" | "codec" | "webgl2";

export interface RealtimeCapability {
  /// True iff every stage we tested passed. The Auto preference
  /// uses this to pick between realtime and segmented.
  ok: boolean;
  /// The stage that produced this report. `webgl2` = we made it
  /// all the way through. Any earlier value means we stopped there.
  stage: CapabilityStage;
  /// Human-readable detail for the settings panel. Always populated.
  detail: string;
  /// `VideoDecoder` global present.
  apiPresent: boolean;
  /// `isConfigSupported` returned true for H.264 avc1.640028.
  h264Supported: boolean;
  /// WebGL2 context could be created on a probe canvas.
  webgl2Ok: boolean;
}

/// Run the full stage-1 probe. Resolves once every stage has been
/// attempted; never throws — failures land in the returned report.
export async function probeRealtimeCapability(): Promise<RealtimeCapability> {
  const apiPresent =
    typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !==
    "undefined";
  if (!apiPresent) {
    return {
      ok: false,
      stage: "api",
      detail: "VideoDecoder global missing",
      apiPresent: false,
      h264Supported: false,
      webgl2Ok: false,
    };
  }

  let h264Supported = false;
  let codecDetail = "";
  try {
    const sup = await VideoDecoder.isConfigSupported({
      codec: "avc1.640028",
      codedWidth: 960,
      codedHeight: 540,
    });
    h264Supported = sup.supported === true;
    codecDetail = h264Supported
      ? "H.264 baseline-high supported"
      : "isConfigSupported(avc1.640028)=false";
  } catch (e) {
    codecDetail = `isConfigSupported threw: ${String(e)}`;
  }
  if (!h264Supported) {
    return {
      ok: false,
      stage: "codec",
      detail: codecDetail,
      apiPresent: true,
      h264Supported: false,
      webgl2Ok: false,
    };
  }

  const webgl2Ok = probeWebGL2();
  if (!webgl2Ok) {
    return {
      ok: false,
      stage: "webgl2",
      detail: "WebGL2 context creation failed",
      apiPresent: true,
      h264Supported: true,
      webgl2Ok: false,
    };
  }

  return {
    ok: true,
    stage: "webgl2",
    detail: "all stages passed",
    apiPresent: true,
    h264Supported: true,
    webgl2Ok: true,
  };
}

function probeWebGL2(): boolean {
  try {
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1)
        : document.createElement("canvas");
    const gl = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext(
      "webgl2",
      { failIfMajorPerformanceCaveat: false },
    );
    return gl !== null;
  } catch {
    return false;
  }
}
