/// Phase A.0 spike — validates the four load-bearing γ assumptions
/// before any of the engine skeleton gets written. Reachable via URL
/// hash `#dom-spike`; mounted from main.tsx outside the normal app
/// tree so it can run with or without an open project.
///
/// Validates, in order:
///   1. Synthetic-master drift bound — does `<video>.currentTime` stay
///      within the 100 ms nudge threshold from `docs/preview-dom.md`?
///   2. `createMediaElementSource` one-way-routing footgun — does the
///      Web Audio chain actually produce audio once wired, or does it
///      silently swallow it because we forgot to connect destination?
///   3. Scrub-via-currentTime latency — on a 1 s-GOP proxy, does
///      `video.currentTime = x` produce a visible new frame within
///      one RAF tick?
///   4. Click-free volume ramps — does
///      `gain.linearRampToValueAtTime(target, ctx.currentTime + dt)`
///      sound clean, or does it zipper?
///
/// Outputs a metrics panel; the user runs each check by interacting.
/// If any check fails, we adjust the architecture in
/// `docs/preview-dom.md` BEFORE extracting the skeleton (Phase A.3+).

import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { projectSummary, type MediaSummary } from "../../ipc";

interface DriftSample {
  /// Wall-clock ms since spike start.
  wallMs: number;
  /// `master_t - video.currentTime` in ms.
  driftMs: number;
}

const DRIFT_RING_CAP = 600; // ~10 s at 60 Hz

export function SpikePreview() {
  const [path, setPath] = useState<string>("");
  const [autoMedias, setAutoMedias] = useState<MediaSummary[]>([]);
  const [audioRouted, setAudioRouted] = useState<boolean | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [scrubLatencyMs, setScrubLatencyMs] = useState<number | null>(null);
  const [driftSamples, setDriftSamples] = useState<DriftSample[]>([]);
  const [masterT, setMasterT] = useState<number>(0);
  const [videoT, setVideoT] = useState<number>(0);
  const [playing, setPlaying] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(0.8);
  /// `<video>.duration` is `NaN` until `loadedmetadata`; mirroring it
  /// into state lets the scrub slider's `max` attribute stay a real
  /// number from the very first render.
  const [duration, setDuration] = useState<number>(60);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Synthetic master clock state.
  const startedAtMsRef = useRef<number | null>(null);
  const accumulatedPauseOffsetMsRef = useRef<number>(0);
  const pausedAtMsRef = useRef<number | null>(null);

  // Web Audio nodes.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const layerGainRef = useRef<GainNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);

  // Drift ring buffer — written every RAF tick. Set into React state
  // at ~5 Hz so the chart re-renders without thrashing.
  const driftRingRef = useRef<DriftSample[]>([]);
  const lastDriftReportRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  // Scrub-latency measurement state.
  const scrubStartMsRef = useRef<number | null>(null);

  // Auto-populate from current project so the dev doesn't have to
  // paste a path manually when a workspace is open.
  useEffect(() => {
    projectSummary()
      .then((s) => {
        // Prefer media that has a proxy ready — that's the realistic
        // DOM-preview source. Fall back to source paths if none yet.
        const withProxy = s.media.filter((m) => m.proxy_path);
        setAutoMedias(withProxy.length > 0 ? withProxy : s.media);
      })
      .catch(() => {
        // No project open — that's fine, user can paste a path.
      });
  }, []);

  // Build the Web Audio chain once a video src is set. The
  // critical assertion lives here: `createMediaElementSource` is
  // one-way — once called on an element, its audio NO LONGER plays
  // through the element's own output, only through whatever the
  // returned source is connected to. If we forget any link in
  // mediaSource → layerGain → masterGain → destination, we get
  // silent video and no error.
  useEffect(() => {
    if (!path) return;
    const video = videoRef.current;
    if (!video) return;

    // Defer AudioContext construction until first user gesture —
    // Chromium suspends contexts created before any interaction.
    // The play button click handler resumes it; here we just wire.
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch (err) {
      setAudioRouted(false);
      setAudioError(String(err));
      return;
    }
    audioCtxRef.current = ctx;

    let source: MediaElementAudioSourceNode;
    try {
      source = ctx.createMediaElementSource(video);
    } catch (err) {
      // Can throw if the same element was already wired — the
      // strict-mode double-mount case. Log and bail; the outer
      // dispose will reset.
      setAudioRouted(false);
      setAudioError(String(err));
      return;
    }
    mediaSourceRef.current = source;

    const layerGain = ctx.createGain();
    layerGain.gain.value = volume;
    layerGainRef.current = layerGain;

    const masterGain = ctx.createGain();
    masterGain.gain.value = 1.0;
    masterGainRef.current = masterGain;

    // The one-way-routing footgun: forget any of these three
    // connect() calls and audio vanishes.
    source.connect(layerGain);
    layerGain.connect(masterGain);
    masterGain.connect(ctx.destination);

    setAudioRouted(true);
    setAudioError(null);

    return () => {
      try {
        source.disconnect();
        layerGain.disconnect();
        masterGain.disconnect();
      } catch {
        // Already torn down; nothing to do.
      }
      void ctx.close().catch(() => {});
      audioCtxRef.current = null;
      mediaSourceRef.current = null;
      layerGainRef.current = null;
      masterGainRef.current = null;
    };
    // `volume` intentionally excluded: it's applied imperatively
    // below, not via re-wiring the chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Master-clock tick. RAF-driven; the source of truth for
  // "where is the playhead." Video element is the slave — nudged
  // toward this clock each tick.
  const tick = useCallback(() => {
    if (startedAtMsRef.current === null) {
      // Not playing.
      rafRef.current = requestAnimationFrame(tick);
      return;
    }
    const now = performance.now();
    const elapsedMs =
      now - startedAtMsRef.current - accumulatedPauseOffsetMsRef.current;
    setMasterT(elapsedMs / 1000);

    const video = videoRef.current;
    if (video) {
      const vT = video.currentTime;
      setVideoT(vT);
      const driftMs = elapsedMs - vT * 1000;

      // Push to ring buffer; throttle React state writes.
      const ring = driftRingRef.current;
      ring.push({ wallMs: now, driftMs });
      if (ring.length > DRIFT_RING_CAP) ring.shift();
      if (now - lastDriftReportRef.current > 200) {
        lastDriftReportRef.current = now;
        setDriftSamples([...ring]);
      }

      // Nudge if drift exceeds the plan's 100 ms threshold. The
      // spike intentionally USES this exact threshold so we get
      // real data on whether it's the right number.
      if (Math.abs(driftMs) > 100) {
        try {
          video.currentTime = elapsedMs / 1000;
        } catch {
          // Element not ready; ignore.
        }
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [tick]);

  const handlePlay = useCallback(async () => {
    const video = videoRef.current;
    const ctx = audioCtxRef.current;
    if (!video) return;
    // Chromium suspends AudioContext on construction; needs a user
    // gesture to resume.
    if (ctx && ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch (err) {
        setAudioError(`ctx.resume(): ${String(err)}`);
      }
    }
    if (startedAtMsRef.current === null) {
      startedAtMsRef.current = performance.now();
    } else if (pausedAtMsRef.current !== null) {
      accumulatedPauseOffsetMsRef.current +=
        performance.now() - pausedAtMsRef.current;
      pausedAtMsRef.current = null;
    }
    try {
      await video.play();
      setPlaying(true);
    } catch (err) {
      // Autoplay policy or src problem — surface so the dev knows.
      setAudioError(`video.play(): ${String(err)}`);
    }
  }, []);

  const handlePause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    pausedAtMsRef.current = performance.now();
    setPlaying(false);
  }, []);

  const handleScrub = useCallback((targetSec: number) => {
    const video = videoRef.current;
    if (!video) return;
    scrubStartMsRef.current = performance.now();
    try {
      video.currentTime = targetSec;
    } catch (err) {
      setAudioError(`scrub: ${String(err)}`);
    }
    // Realign master clock so we don't immediately nudge back.
    const elapsedMs = targetSec * 1000;
    if (startedAtMsRef.current !== null) {
      const now = performance.now();
      startedAtMsRef.current = now - elapsedMs - accumulatedPauseOffsetMsRef.current;
    }
  }, []);

  const handleVolume = useCallback((v: number) => {
    setVolume(v);
    const ctx = audioCtxRef.current;
    const layer = layerGainRef.current;
    if (!ctx || !layer) return;
    // Click-free ramp. 30 ms is the de-zippering window for
    // gain changes; bare `layer.gain.value = v` would pop.
    const target = ctx.currentTime + 0.03;
    layer.gain.cancelScheduledValues(ctx.currentTime);
    layer.gain.setValueAtTime(layer.gain.value, ctx.currentTime);
    layer.gain.linearRampToValueAtTime(v, target);
  }, []);

  // `seeked` event fires once the new frame is decoded + painted.
  // Measure scrub latency from request to that fire. Also mirror
  // duration into React state once metadata lands — the scrub
  // slider's `max` reads from it, and `<video>.duration` is NaN
  // until `loadedmetadata` fires.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onSeeked = () => {
      if (scrubStartMsRef.current !== null) {
        setScrubLatencyMs(performance.now() - scrubStartMsRef.current);
        scrubStartMsRef.current = null;
      }
    };
    const onLoadedMetadata = () => {
      const d = video.duration;
      if (Number.isFinite(d) && d > 0) setDuration(d);
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    return () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, [path]);

  // Drift histogram summary. p50 / p95 / max over the current ring.
  const driftStats = (() => {
    if (driftSamples.length === 0) return null;
    const abs = driftSamples.map((s) => Math.abs(s.driftMs)).sort((a, b) => a - b);
    const p = (q: number) => abs[Math.min(abs.length - 1, Math.floor(q * abs.length))];
    return {
      count: abs.length,
      p50: p(0.5),
      p95: p(0.95),
      max: abs[abs.length - 1],
    };
  })();

  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: 20,
        color: "#eee",
        background: "#1e1e1e",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ marginTop: 0 }}>DOM preview — Phase A.0 spike</h1>
      <p style={{ color: "#aaa", maxWidth: 720 }}>
        Validates γ assumptions before extracting the engine skeleton. Pick a
        media item below (proxies preferred) or paste a path. The play /
        pause / scrub / volume buttons exercise the four assumptions; the
        metrics panel reports the result.
      </p>

      {/* Source picker */}
      <section style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, margin: "12px 0 8px" }}>1. Source</h2>
        {autoMedias.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
            {autoMedias.slice(0, 8).map((m) => {
              const candidate = m.proxy_path ?? m.path;
              const isProxy = !!m.proxy_path;
              return (
                <button
                  key={m.id}
                  onClick={() => setPath(candidate)}
                  style={{
                    padding: "4px 8px",
                    fontSize: 12,
                    background: candidate === path ? "#3a6" : "#333",
                    color: "#eee",
                    border: "1px solid #555",
                    borderRadius: 4,
                    cursor: "pointer",
                  }}
                >
                  {m.label} {isProxy ? "🅿" : ""}
                </button>
              );
            })}
          </div>
        )}
        <input
          type="text"
          placeholder="Or paste absolute path…"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          style={{
            width: "100%",
            padding: 6,
            background: "#0f0f0f",
            color: "#eee",
            border: "1px solid #444",
            borderRadius: 4,
            fontFamily: "monospace",
            fontSize: 12,
          }}
        />
      </section>

      {/* Video surface */}
      <section style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, margin: "12px 0 8px" }}>2. Surface</h2>
        <video
          ref={videoRef}
          src={path ? convertFileSrc(path) : undefined}
          style={{
            width: 720,
            maxWidth: "100%",
            background: "#000",
            borderRadius: 4,
          }}
        />
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
          {playing ? (
            <button onClick={handlePause} style={spikeButton}>Pause</button>
          ) : (
            <button onClick={handlePlay} style={spikeButton}>Play</button>
          )}
          <label style={{ fontSize: 12 }}>
            Scrub:{" "}
            <input
              type="range"
              min={0}
              max={duration}
              step={0.01}
              defaultValue={0}
              onChange={(e) => handleScrub(parseFloat(e.target.value))}
              style={{ verticalAlign: "middle", width: 360 }}
            />
          </label>
          <label style={{ fontSize: 12 }}>
            Volume:{" "}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => handleVolume(parseFloat(e.target.value))}
              style={{ verticalAlign: "middle", width: 200 }}
            />{" "}
            {volume.toFixed(2)}
          </label>
        </div>
      </section>

      {/* Metrics */}
      <section>
        <h2 style={{ fontSize: 16, margin: "12px 0 8px" }}>3. Metrics</h2>
        <div style={metricsTable}>
          <div style={metricKey}>master_t</div>
          <div style={metricVal}>{masterT.toFixed(3)} s</div>

          <div style={metricKey}>video.currentTime</div>
          <div style={metricVal}>{videoT.toFixed(3)} s</div>

          <div style={metricKey}>drift p50 / p95 / max</div>
          <div style={metricVal}>
            {driftStats ? (
              <>
                {driftStats.p50.toFixed(1)} / {driftStats.p95.toFixed(1)} /{" "}
                {driftStats.max.toFixed(1)} ms{" "}
                <span style={{ color: "#888", fontSize: 11 }}>(n={driftStats.count})</span>
              </>
            ) : (
              "—"
            )}
          </div>

          <div style={metricKey}>audio routed</div>
          <div style={metricVal}>
            {audioRouted === null ? "—" : audioRouted ? "✓ yes" : "✗ no"}
            {audioError && (
              <span style={{ color: "#e44", marginLeft: 8, fontFamily: "monospace", fontSize: 11 }}>
                {audioError}
              </span>
            )}
          </div>

          <div style={metricKey}>last scrub latency</div>
          <div style={metricVal}>
            {scrubLatencyMs === null ? "—" : `${scrubLatencyMs.toFixed(0)} ms`}
          </div>

          <div style={metricKey}>volume ramp</div>
          <div style={metricVal}>
            <span style={{ color: "#888" }}>subjective — listen for clicks while sliding</span>
          </div>
        </div>

        <h3 style={{ fontSize: 13, margin: "16px 0 4px", color: "#aaa" }}>
          Expected for γ to be viable:
        </h3>
        <ul style={{ fontSize: 12, color: "#aaa", lineHeight: 1.6 }}>
          <li>drift p95 &lt; 100 ms (nudge threshold from the plan; loosen if much lower)</li>
          <li>audio routed = ✓ yes once Play is pressed</li>
          <li>scrub latency &lt; 100 ms on a 1 s-GOP proxy (visible frame within ~1 RAF)</li>
          <li>volume ramp is click-free across the full slider range</li>
        </ul>
      </section>
    </div>
  );
}

const spikeButton: React.CSSProperties = {
  padding: "6px 14px",
  background: "#3a6",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  fontSize: 13,
  cursor: "pointer",
};

const metricsTable: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "200px 1fr",
  rowGap: 4,
  columnGap: 16,
  fontSize: 13,
  background: "#0f0f0f",
  border: "1px solid #333",
  borderRadius: 4,
  padding: 12,
};

const metricKey: React.CSSProperties = {
  color: "#888",
};

const metricVal: React.CSSProperties = {
  fontFamily: "monospace",
  color: "#eee",
};
