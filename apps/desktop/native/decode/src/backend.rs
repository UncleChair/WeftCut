use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use crate::events::{EventSink, TsfnEventSink};
use crate::recover::LockExt;

// ── wire structs ────────────────────────────────────────────────────────────

/// One pool slot handed back by `preview_gpu_open`: the LE bytes of the shared
/// D3D11 texture's NT handle (an `i64` value, not a pointer — see
/// `preview_gpu::session::OpenInfo`). The main process re-parses these bytes
/// and passes the handle to `importSharedTexture`.
#[napi(object)]
pub struct PreviewGpuSlot {
    pub handle: Buffer,
}

/// Reply of `preview_gpu_open`: the decoded stream's dimensions + one
/// `PreviewGpuSlot` per pool slot.
#[napi(object)]
pub struct PreviewGpuOpenInfo {
    pub width: u32,
    pub height: u32,
    pub slots: Vec<PreviewGpuSlot>,
}

/// Per-metric ms summary of native preview timing (decode-bench Stage 3). Field
/// names cross to JS as camelCase: `mean_ms` -> `meanMs`, etc.
#[napi(object)]
pub struct PreviewGpuTimingSummary {
    pub count: u32,
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

/// Native timing metrics returned by `preview_gpu_take_timings`. `ack_to_emit` +
/// `lookahead_gated_skips` are the throughput-bottleneck probe (the ack->next-emit
/// gap and its lookahead-gate attribution).
#[napi(object)]
pub struct PreviewGpuTimingReport {
    pub coord_rtt: PreviewGpuTimingSummary,
    pub decode_copy: PreviewGpuTimingSummary,
    pub ack_to_emit: PreviewGpuTimingSummary,
    pub lookahead_gated_skips: u32,
    /// Frames the pump discarded as already-late instead of delivering them (see
    /// `preview_gpu::TimingReport::late_frame_drops`).
    pub late_frame_drops: u32,
    // Round-2 thread time-budget probe (see `preview_gpu::TimingReport`).
    pub inter_emit: PreviewGpuTimingSummary,
    pub inter_ack: PreviewGpuTimingSummary,
    pub recv_block: PreviewGpuTimingSummary,
    pub recv_timeout_ticks: u32,
    pub recv_ack_msgs: u32,
    pub recv_req_msgs: u32,
    // Round-3 stall attribution (see `preview_gpu::TimingReport`).
    pub eof_returns: u32,
    pub pool_full_returns: u32,
    pub acquire_failed: u32,
    pub final_free_slots: u32,
    pub final_eof: bool,
}

/// Reply of `preview_sw_open`: the decoded stream's frame dimensions.
#[napi(object)]
pub struct PreviewSwOpenInfoJs {
    pub width: u32,
    pub height: u32,
}

/// One software-decoded frame delivered to JS. `data` is tightly-packed 8-bit
/// NV12 (`Y` plane `w*h` then interleaved `UV` `w*h/2`); `format` is always
/// `"NV12"`. `pts_us`/`dur_us` cross as `f64` (napi has no ergonomic `i64`
/// binding — matches the `preview_gpu` `target_us` convention). Color tags are
/// canonical FFmpeg string names (`bt709`, `tv`, …) or `null` where the stream
/// leaves them unspecified.
#[napi(object)]
pub struct PreviewSwFrame {
    pub stream_id: String,
    pub pts_us: f64,
    pub dur_us: f64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub color_matrix: Option<String>,
    pub color_range: Option<String>,
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
    pub data: Buffer,
}

/// Verdict of a one-frame SW decode probe. `codec`/`pix_fmt` echo what
/// libavformat identified — main derives the capability-cache class key from
/// these (probe-informed, not caller-guessed).
#[napi(object)]
pub struct PreviewSwProbeResult {
    pub ok: bool,
    pub codec: Option<String>,
    pub pix_fmt: Option<String>,
    pub width: u32,
    pub height: u32,
    pub reason: Option<String>,
}

/// Verdict of a one-frame HW (d3d11va) decode probe. Unlike the SW probe,
/// main supplies `classKey` (derived from `MediaSummary` before deciding to
/// probe, since the HW probe is comparatively expensive) — this result carries
/// no codec/pix_fmt/width/height echo.
#[napi(object)]
pub struct PreviewGpuProbeResult {
    pub ok: bool,
    pub reason: Option<String>,
}

/// Move a decoded `SwFrame` into its napi wire form. `Buffer::from(f.data)` takes
/// the `Vec` by value (zero-copy Rust-side); the single budgeted copy happens
/// when napi marshals the `Buffer` across the JS boundary.
fn sw_frame_to_napi(stream_id: &str, f: crate::preview_sw::decoder::SwFrame) -> PreviewSwFrame {
    PreviewSwFrame {
        stream_id: stream_id.to_string(),
        pts_us: f.pts_us as f64,
        dur_us: f.dur_us as f64,
        width: f.width,
        height: f.height,
        format: f.format.wire_name().into(),
        color_matrix: f.color.matrix,
        color_range: f.color.range,
        color_primaries: f.color.primaries,
        color_transfer: f.color.transfer,
        data: Buffer::from(f.data),
    }
}

// ── export-decode wire structs ───────────────────────────────────────────────

/// Reply of `export_sw_open`: the decoded stream's dimensions, source color
/// tags, and source-normalized start PTS (the offset applied to every frame's
/// `pts_us`). `start_pts_us` crosses as `f64` (napi has no ergonomic `i64`),
/// matching the `pts_us`/`target_us` convention. Color tags are canonical FFmpeg
/// string names or `null` where unspecified.
#[napi(object)]
pub struct ExportSwOpenInfoJs {
    pub width: u32,
    pub height: u32,
    pub color_matrix: Option<String>,
    pub color_range: Option<String>,
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
    pub start_pts_us: f64,
}

/// One export-decoded frame delivered to JS. Same wire shape as `PreviewSwFrame`
/// but `format` follows the session's requested output — `"NV12"` (8-bit) or
/// `"I420P10"` (tightly-packed u16LE planes, `copyToTenBit` layout) — and
/// delivery is the exactly-once range contract + credit window rather than
/// best-effort preview. Crosses the boundary wrapped in an [`ExportSwMsg`] with
/// `kind == "frame"`; `session_id` is kept here too so the frame stays
/// self-identifying downstream of the wrapper.
#[napi(object)]
pub struct ExportSwFrame {
    pub session_id: String,
    pub pts_us: f64,
    pub dur_us: f64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub color_matrix: Option<String>,
    pub color_range: Option<String>,
    pub color_primaries: Option<String>,
    pub color_transfer: Option<String>,
    pub data: Buffer,
}

/// Move a decoded export `SwFrame` into its napi wire form. Like
/// `sw_frame_to_napi`: `Buffer::from(f.data)` takes the `Vec` by value
/// (zero-copy Rust-side); the single budgeted copy is napi's boundary marshal.
fn export_frame_to_napi(session_id: &str, f: crate::preview_sw::decoder::SwFrame) -> ExportSwFrame {
    ExportSwFrame {
        session_id: session_id.to_string(),
        pts_us: f.pts_us as f64,
        dur_us: f.dur_us as f64,
        width: f.width,
        height: f.height,
        format: f.format.wire_name().into(),
        color_matrix: f.color.matrix,
        color_range: f.color.range,
        color_primaries: f.color.primaries,
        color_transfer: f.color.transfer,
        data: Buffer::from(f.data),
    }
}

/// One in-band message on the per-session export channel — frames AND control
/// signals ride this single tagged shape. Rationale on the sink closure in
/// `NativeDecode::new`; TS mirror = `ExportSwMsg` in `shared/ipc.ts`.
#[napi(object)]
pub struct ExportSwMsg {
    pub session_id: String,
    /// "frame" | "rangeEnd" | "ended" | "error"
    pub kind: String,
    /// Present iff kind == "frame".
    pub frame: Option<ExportSwFrame>,
    /// Present iff kind == "error".
    pub message: Option<String>,
    /// Present iff kind == "rangeEnd": the exact completed source-time range.
    pub a_us: Option<f64>,
    pub b_us: Option<f64>,
}

/// The component's ffmpeg linkage identity — the SW capability-cache envKey.
/// Changes when the bundled/loaded avcodec changes.
#[napi]
pub fn version_info() -> String {
    format!(
        "avcodec={} avutil={}",
        ffmpeg_next::codec::version(),
        ffmpeg_next::util::version()
    )
}

/// The decode lanes THIS build actually compiled in — the component's capability
/// advertisement (ADR 0030 §Lane advertisement). `"software"` is unconditional
/// (the libavcodec SW lane builds on every platform); the `"d3d11va"` HW-preview
/// lane rides the SAME `#[cfg(windows)]` gate as the `preview_gpu` module it
/// names, so the advertisement can never claim a lane the addon didn't compile.
/// On Linux (issue #5 Block C) the copy-back HW lanes are advertised: `"nvdec"`
/// unconditionally (a missing libcuda makes the probe Err cleanly, no abort) and
/// `"vaapi"` ONLY when the bundled libva can copy back — the BtbN ffmpeg calls
/// `vaMapBuffer2` unconditionally, so a libva without it (glibc too old to load
/// the bundled >= 2.21 copy, or a stale system libva) aborts the process
/// UNCATCHABLY on the first mapped frame. The lane is gated on
/// [`crate::preview_sw::decoder::vaapi_copyback_supported`] (which also pins the
/// bundled libva so the implib resolves it) rather than advertised and later
/// crashed. Resolvers probe ONLY advertised lanes: on Linux, where
/// `preview_gpu_probe` is a by-design stub returning a "not built" verdict, the
/// d3d11va lane is never advertised and so is never probed — replacing the old
/// platform-string guard.
#[napi]
pub fn capabilities() -> Vec<String> {
    #[allow(unused_mut)]
    let mut lanes = vec!["software".to_string()];
    #[cfg(windows)]
    lanes.push("d3d11va".to_string());
    #[cfg(target_os = "linux")]
    {
        // NVDEC is safe to advertise unconditionally — a missing libcuda makes
        // the probe Err cleanly (no abort). VAAPI is gated on the bundled libva
        // being loadable + copy-back-capable (see vaapi_copyback_supported).
        lanes.push("nvdec".to_string());
        if crate::preview_sw::decoder::vaapi_copyback_supported() {
            lanes.push("vaapi".to_string());
        }
    }
    lanes
}

#[napi]
pub struct NativeDecode {
    #[cfg(windows)]
    preview_gpu: crate::preview_gpu::PreviewGpuRegistry,
    preview_sw: crate::preview_sw::PreviewSwRegistry,
    preview_sw_sinks: Arc<Mutex<HashMap<String, ThreadsafeFunction<PreviewSwFrame>>>>,
    export_sw: crate::export_sw::ExportSwRegistry,
    export_sw_sinks: Arc<Mutex<HashMap<String, ThreadsafeFunction<ExportSwMsg>>>>,
}

#[napi]
impl NativeDecode {
    /// `on_event` receives the same `{event, payload}` JSON envelope the core
    /// Backend's sink emits; main relays both through `evt:*`.
    #[napi(constructor)]
    pub fn new(on_event: ThreadsafeFunction<String>) -> Self {
        let events: Arc<dyn EventSink> = Arc::new(TsfnEventSink::new(on_event));

        // Wire the registry's poke sink to the same `events` sink every other
        // channel emits through, so `previewGpu:*` events reach Electron main
        // the same way `log:entry` / `media:*` / etc. do.
        #[cfg(windows)]
        let preview_gpu = {
            let registry = crate::preview_gpu::PreviewGpuRegistry::new();
            let sink_events = events.clone();
            registry.set_poke_sink(Box::new(move |poke| {
                use crate::preview_gpu::PreviewGpuPoke;
                match poke {
                    PreviewGpuPoke::FrameReady {
                        stream_id,
                        slot,
                        pts_us,
                        dur_us,
                    } => {
                        sink_events.emit(
                            "previewGpu:frameReady",
                            serde_json::json!({
                                "streamId": stream_id,
                                "slot": slot,
                                "ptsUs": pts_us,
                                "durUs": dur_us,
                            }),
                        );
                    }
                    PreviewGpuPoke::Eof { stream_id } => {
                        sink_events.emit(
                            "previewGpu:eof",
                            serde_json::json!({ "streamId": stream_id }),
                        );
                    }
                    PreviewGpuPoke::Error { stream_id, message } => {
                        sink_events.emit(
                            "previewGpu:error",
                            serde_json::json!({ "streamId": stream_id, "message": message }),
                        );
                    }
                }
            }));
            registry
        };
        // Software preview: the registry has a SINGLE global frame sink, so install
        // ONE routing closure here (NOT per-open, which would clobber earlier streams)
        // that dispatches each `Frame` poke to the matching stream's per-stream
        // `ThreadsafeFunction` in `preview_sw_sinks`. `Eof`/`Error` pokes have no JS
        // callback shape (the delivery contract is frame bytes only) — log them.
        // A poke whose `stream_id` has no entry drops silently — load-bearing:
        // `preview_sw_close` may DETACH a wedged session thread, so a straggler
        // can still poke after the entry is removed.
        let (preview_sw, preview_sw_sinks) = {
            let registry = crate::preview_sw::PreviewSwRegistry::new();
            let sinks: Arc<Mutex<HashMap<String, ThreadsafeFunction<PreviewSwFrame>>>> =
                Default::default();
            let sinks_for_cb = sinks.clone();
            registry.set_frame_sink(Box::new(move |poke| {
                use crate::preview_sw::SwFramePoke;
                match poke {
                    SwFramePoke::Frame { stream_id, frame } => {
                        if let Some(tsfn) = sinks_for_cb.lock_recover().get(&stream_id) {
                            let _ = tsfn.call(
                                Ok(sw_frame_to_napi(&stream_id, frame)),
                                ThreadsafeFunctionCallMode::NonBlocking,
                            );
                        }
                    }
                    SwFramePoke::Eof { stream_id } => tracing::debug!(%stream_id, "preview-sw eof"),
                    SwFramePoke::Error { stream_id, message } => {
                        tracing::warn!(%stream_id, %message, "preview-sw decode error")
                    }
                }
            }));
            (registry, sinks)
        };

        // Export software decode: same single-global-sink pattern as preview,
        // but EVERY poke — frames AND the RangeEnd/Ended/Error control signals —
        // crosses as an `ExportSwMsg` on the matching session's per-session
        // `ThreadsafeFunction`. One napi queue per session means JS observes
        // pokes in exact producer order; a second channel (e.g. the shared
        // `events` envelope) would let an `Ended` overtake the tail frames
        // emitted before it. NonBlocking on the default UNBOUNDED tsfn queue is
        // load-bearing: a bounded queue would silently drop pokes — including
        // control signals — under backpressure. Pokes for an unregistered
        // session drop silently (mirrors the preview-sw routing).
        let (export_sw, export_sw_sinks) = {
            let registry = crate::export_sw::ExportSwRegistry::new();
            let sinks: Arc<Mutex<HashMap<String, ThreadsafeFunction<ExportSwMsg>>>> =
                Default::default();
            let sinks_for_cb = sinks.clone();
            registry.set_sink(Box::new(move |poke| {
                use crate::export_sw::ExportPoke;
                let msg = match poke {
                    ExportPoke::Frame { session_id, frame } => ExportSwMsg {
                        frame: Some(export_frame_to_napi(&session_id, frame)),
                        session_id,
                        kind: "frame".into(),
                        message: None,
                        a_us: None,
                        b_us: None,
                    },
                    ExportPoke::RangeEnd {
                        session_id,
                        a_us,
                        b_us,
                    } => ExportSwMsg {
                        session_id,
                        kind: "rangeEnd".into(),
                        frame: None,
                        message: None,
                        a_us: Some(a_us as f64),
                        b_us: Some(b_us as f64),
                    },
                    ExportPoke::Ended { session_id } => ExportSwMsg {
                        session_id,
                        kind: "ended".into(),
                        frame: None,
                        message: None,
                        a_us: None,
                        b_us: None,
                    },
                    ExportPoke::Error {
                        session_id,
                        message,
                    } => ExportSwMsg {
                        session_id,
                        kind: "error".into(),
                        frame: None,
                        message: Some(message),
                        a_us: None,
                        b_us: None,
                    },
                };
                if let Some(tsfn) = sinks_for_cb.lock_recover().get(&msg.session_id) {
                    let _ = tsfn.call(Ok(msg), ThreadsafeFunctionCallMode::NonBlocking);
                }
            }));
            (registry, sinks)
        };

        NativeDecode {
            #[cfg(windows)]
            preview_gpu,
            preview_sw,
            preview_sw_sinks,
            export_sw,
            export_sw_sinks,
        }
    }
}

// ── GPU methods (Windows) ────────────────────────────────────────────────────

/// Native GPU-decode preview command surface (decode-bench Stage 2). Backed by
/// `NativeDecode::preview_gpu`; pokes (`FrameReady`/`Eof`/`Error`) surface as
/// `previewGpu:*` events through the same `events` sink every other channel
/// uses (wired in the constructor).
#[cfg(windows)]
#[napi]
impl NativeDecode {
    /// Open `path` for GPU preview: spawns the session's decode thread and
    /// returns the shared NV12 pool's slot handles + frame dimensions.
    #[napi]
    pub fn preview_gpu_open(
        &self,
        stream_id: String,
        path: String,
        pool_size: u32,
    ) -> napi::Result<PreviewGpuOpenInfo> {
        let info = self
            .preview_gpu
            .open(&stream_id, &path, pool_size)
            .map_err(napi::Error::from_reason)?;
        Ok(PreviewGpuOpenInfo {
            width: info.width,
            height: info.height,
            slots: info
                .slot_handles
                .into_iter()
                .map(|h| PreviewGpuSlot {
                    handle: Buffer::from(h.to_le_bytes().to_vec()),
                })
                .collect(),
        })
    }

    /// Move the session's decode anchor. `target_us` is an `f64` (napi has no
    /// ergonomic `i64` param binding) carrying source microseconds; cast down
    /// to the `i64` the registry expects.
    #[napi]
    pub fn preview_gpu_request_frame_at(
        &self,
        stream_id: String,
        target_us: f64,
    ) -> napi::Result<()> {
        self.preview_gpu
            .request_frame_at(&stream_id, target_us as i64)
            .map_err(napi::Error::from_reason)
    }

    /// Release a slot back to the pool after the renderer drops its last
    /// cross-process reference to the shared texture.
    #[napi]
    pub fn preview_gpu_consume_ack(&self, stream_id: String, slot: u32) -> napi::Result<()> {
        self.preview_gpu
            .consume_ack(&stream_id, slot)
            .map_err(napi::Error::from_reason)
    }

    /// Tear down a session: signals its decode thread to close and joins it.
    #[napi]
    pub fn preview_gpu_close(&self, stream_id: String) -> napi::Result<()> {
        self.preview_gpu
            .close(&stream_id)
            .map_err(napi::Error::from_reason)
    }

    /// One-frame HW decode probe: does d3d11va yield a decodable D3D11
    /// surface for this codec on this GPU? Calls the decoder-level primitive
    /// directly (no session, no pool, no poke sink) — a throwaway open +
    /// one-frame decode is self-contained and self-bounding, unlike the
    /// streaming `preview_gpu_open` session. The `D3d11Frame` on success is
    /// dropped immediately (its `Drop` releases the GPU texture); only the
    /// ok/err verdict is returned. `timeout_ms` is currently advisory (kept
    /// for API symmetry with the SW probe / design doc) — this synchronous
    /// primitive has no internal deadline machinery to wire it to.
    #[napi]
    pub fn preview_gpu_probe(
        &self,
        path: String,
        _timeout_ms: u32,
    ) -> napi::Result<PreviewGpuProbeResult> {
        match crate::preview_gpu::decoder::decode_first_d3d11_frame(&path) {
            Ok(_frame) => Ok(PreviewGpuProbeResult {
                ok: true,
                reason: None,
            }),
            Err(e) => Ok(PreviewGpuProbeResult {
                ok: false,
                reason: Some(e),
            }),
        }
    }

    /// Drain + return this session's per-frame timing samples (coord-RTT + decode/copy).
    #[napi]
    pub fn preview_gpu_take_timings(
        &self,
        stream_id: String,
    ) -> napi::Result<PreviewGpuTimingReport> {
        let rep = self
            .preview_gpu
            .take_timings(&stream_id)
            .map_err(napi::Error::from_reason)?;
        // Counts stay far under u32 in a bench window (see `note_lookahead_gated_skip`);
        // saturate defensively rather than silently wrap on the cast.
        let clamp = |n: u64| u32::try_from(n).unwrap_or(u32::MAX);
        Ok(PreviewGpuTimingReport {
            coord_rtt: to_napi_timing_summary(rep.coord_rtt),
            decode_copy: to_napi_timing_summary(rep.decode_copy),
            ack_to_emit: to_napi_timing_summary(rep.ack_to_emit),
            lookahead_gated_skips: clamp(rep.lookahead_gated_skips),
            late_frame_drops: clamp(rep.late_frame_drops),
            inter_emit: to_napi_timing_summary(rep.inter_emit),
            inter_ack: to_napi_timing_summary(rep.inter_ack),
            recv_block: to_napi_timing_summary(rep.recv_block),
            recv_timeout_ticks: clamp(rep.recv_timeout_ticks),
            recv_ack_msgs: clamp(rep.recv_ack_msgs),
            recv_req_msgs: clamp(rep.recv_req_msgs),
            eof_returns: clamp(rep.eof_returns),
            pool_full_returns: clamp(rep.pool_full_returns),
            acquire_failed: clamp(rep.acquire_failed),
            final_free_slots: rep.final_free_slots,
            final_eof: rep.final_eof,
        })
    }
}

#[cfg(windows)]
fn to_napi_timing_summary(s: crate::preview_gpu::TimingSummary) -> PreviewGpuTimingSummary {
    PreviewGpuTimingSummary {
        count: s.count,
        mean_ms: s.mean_ms,
        p50_ms: s.p50_ms,
        p95_ms: s.p95_ms,
        max_ms: s.max_ms,
    }
}

/// Fallback surface when the addon wasn't built with GPU preview support
/// (non-Windows): the methods still exist so JS callers get a clean rejection
/// instead of a missing-method TypeError.
#[cfg(not(windows))]
#[napi]
impl NativeDecode {
    #[napi]
    pub fn preview_gpu_open(
        &self,
        _stream_id: String,
        _path: String,
        _pool_size: u32,
    ) -> napi::Result<PreviewGpuOpenInfo> {
        Err(napi::Error::from_reason("preview-gpu not built"))
    }

    #[napi]
    pub fn preview_gpu_request_frame_at(
        &self,
        _stream_id: String,
        _target_us: f64,
    ) -> napi::Result<()> {
        Err(napi::Error::from_reason("preview-gpu not built"))
    }

    #[napi]
    pub fn preview_gpu_consume_ack(&self, _stream_id: String, _slot: u32) -> napi::Result<()> {
        Err(napi::Error::from_reason("preview-gpu not built"))
    }

    #[napi]
    pub fn preview_gpu_close(&self, _stream_id: String) -> napi::Result<()> {
        Err(napi::Error::from_reason("preview-gpu not built"))
    }

    #[napi]
    pub fn preview_gpu_take_timings(
        &self,
        _stream_id: String,
    ) -> napi::Result<PreviewGpuTimingReport> {
        Err(napi::Error::from_reason("preview-gpu not built"))
    }

    /// Non-Windows: the HW lane doesn't exist. Unlike the other GPU stubs
    /// above, this returns a verdict (`Ok`) rather than an `Err` — the caller
    /// (`decodeCap:probeHw`) treats capability probes as verdicts, never
    /// errors, so main can cache/branch on `ok` uniformly across platforms.
    #[napi]
    pub fn preview_gpu_probe(
        &self,
        _path: String,
        _timeout_ms: u32,
    ) -> napi::Result<PreviewGpuProbeResult> {
        Ok(PreviewGpuProbeResult {
            ok: false,
            reason: Some("preview-gpu not built".into()),
        })
    }
}

// ── SW methods (all platforms) ───────────────────────────────────────────────

/// Native software-decode preview command surface (cross-platform). Backed by
/// `NativeDecode::preview_sw`; decoded NV12 frames reach JS through the
/// per-stream `ThreadsafeFunction` registered in `preview_sw_open` and routed
/// by the single sink installed in the constructor.
#[napi]
impl NativeDecode {
    /// Open `path` for preview: register the per-stream frame callback, then spawn
    /// the session's decode thread and return the frame dimensions. The callback is
    /// registered BEFORE opening so no early poke is dropped. `lane`/`device` select
    /// the decode acceleration (issue #5 Block C); either way the session yields the
    /// SAME CPU NV12 frame transport:
    /// - `lane` `None`/`Some("software")` → the pure-software lane (default).
    /// - `Some("nvdec")` → NVDEC copy-back (default GPU handle; `device` ignored).
    /// - `Some("vaapi")` → VAAPI copy-back pinned to the `device` DRM render node
    ///   (empty when absent, letting libva default-select).
    /// - any other `lane` → treated as software (safe fallback; the caller should
    ///   only ever open an already-probed lane).
    #[napi]
    pub fn preview_sw_open(
        &self,
        stream_id: String,
        path: String,
        on_frame: ThreadsafeFunction<PreviewSwFrame>,
        lane: Option<String>,
        device: Option<String>,
    ) -> napi::Result<PreviewSwOpenInfoJs> {
        use crate::preview_sw::decoder::DecodeAccel;
        let accel = match lane.as_deref() {
            None | Some("software") => DecodeAccel::Software,
            Some("nvdec") => DecodeAccel::Nvdec,
            Some("vaapi") => DecodeAccel::Vaapi {
                device: device.unwrap_or_default(),
            },
            // Unknown lane: fall back to software rather than error — the resolver
            // only opens lanes it has already probed, so this is defensive.
            Some(_) => DecodeAccel::Software,
        };
        self.preview_sw_sinks
            .lock_recover()
            .insert(stream_id.clone(), on_frame);
        let info = self
            .preview_sw
            .open_with_accel(&stream_id, &path, accel)
            .map_err(napi::Error::from_reason)?;
        Ok(PreviewSwOpenInfoJs {
            width: info.width,
            height: info.height,
        })
    }

    /// Move the session's decode anchor. `target_us` is an `f64` (napi has no
    /// ergonomic `i64` param binding) carrying source microseconds; cast down to
    /// the `i64` the registry expects. Fire-and-forget: frames arrive via the
    /// registered callback.
    #[napi]
    pub fn preview_sw_request_frame_at(
        &self,
        stream_id: String,
        target_us: f64,
    ) -> napi::Result<()> {
        self.preview_sw
            .request_frame_at(&stream_id, target_us as i64)
            .map_err(napi::Error::from_reason)
    }

    /// Tear down a session: close the decode thread FIRST, THEN drop the
    /// per-stream `ThreadsafeFunction`. `close` returns promptly (bounded grace,
    /// then detach — never an unbounded join on this napi thread); the contract
    /// is that no poke is DELIVERED after the sink entry is removed, NOT that
    /// the thread has exited: a detached straggler's late pokes hit the
    /// constructor's router and drop silently once the entry is gone (a panic
    /// on a detached thread is unobservable). Returns the close result either
    /// way.
    #[napi]
    pub fn preview_sw_close(&self, stream_id: String) -> napi::Result<()> {
        let r = self
            .preview_sw
            .close(&stream_id)
            .map_err(napi::Error::from_reason);
        self.preview_sw_sinks.lock_recover().remove(&stream_id);
        r
    }

    /// One-frame decode probe for the SW lane (P1: probes over lists). Opens a
    /// THROWAWAY stream (never registered in the session registry), decodes one
    /// frame, closes. Failure is a verdict, not an error — Err only for panics
    /// worth surfacing.
    #[napi]
    pub fn preview_sw_probe(&self, path: String) -> napi::Result<PreviewSwProbeResult> {
        match crate::preview_sw::decoder::SwVideoStream::open(&path) {
            Ok(mut stream) => {
                let (codec, pix_fmt, width, height) = stream.probe_identity();
                match stream.next_frame() {
                    Ok(Some(_frame)) => Ok(PreviewSwProbeResult {
                        ok: true,
                        codec: Some(codec),
                        pix_fmt: Some(pix_fmt),
                        width,
                        height,
                        reason: None,
                    }),
                    Ok(None) => Ok(PreviewSwProbeResult {
                        ok: false,
                        codec: Some(codec),
                        pix_fmt: Some(pix_fmt),
                        width,
                        height,
                        reason: Some("no decodable frame".into()),
                    }),
                    Err(e) => Ok(PreviewSwProbeResult {
                        ok: false,
                        codec: Some(codec),
                        pix_fmt: Some(pix_fmt),
                        width,
                        height,
                        reason: Some(e.to_string()),
                    }),
                }
            }
            Err(e) => Ok(PreviewSwProbeResult {
                ok: false,
                codec: None,
                pix_fmt: None,
                width: 0,
                height: 0,
                reason: Some(e.to_string()),
            }),
        }
    }

    /// One-frame HARDWARE decode probe (issue #5 Block C). `lane` is `"nvdec"` or
    /// `"vaapi"`; for `vaapi`, `device` is the DRM render node this probe targets
    /// (main enumerates the nodes and probes each). Opens a throwaway stream on
    /// that hardware lane, decodes one frame, and confirms the surface came back
    /// HARDWARE-decoded — a silent software fallback counts as `ok:false`, so the
    /// resolver's per-machine cache records the negative and the Standard engine
    /// stays on its software lane. Failure is a verdict, not an error (matches the
    /// SW and d3d11va probes): callers branch on `ok`, never catch. Reuses
    /// `PreviewGpuProbeResult` — main-supplied classKey, no codec/dims echo.
    /// `_timeout_ms` is advisory (kept for API symmetry with the other probes) —
    /// this synchronous one-frame decode has no deadline machinery to wire it to.
    #[napi]
    pub fn preview_hw_probe(
        &self,
        path: String,
        lane: String,
        device: Option<String>,
        _timeout_ms: u32,
    ) -> napi::Result<PreviewGpuProbeResult> {
        use crate::preview_sw::decoder::DecodeAccel;
        let accel = match lane.as_str() {
            "nvdec" => DecodeAccel::Nvdec,
            "vaapi" => DecodeAccel::Vaapi {
                device: device.unwrap_or_default(),
            },
            other => {
                return Ok(PreviewGpuProbeResult {
                    ok: false,
                    reason: Some(format!("unknown hw lane '{other}'")),
                })
            }
        };
        match crate::preview_sw::decoder::probe_hw_first_frame(&path, accel) {
            Ok(()) => Ok(PreviewGpuProbeResult {
                ok: true,
                reason: None,
            }),
            Err(e) => Ok(PreviewGpuProbeResult {
                ok: false,
                reason: Some(e),
            }),
        }
    }
}

// ── export-decode methods (all platforms) ────────────────────────────────────

/// Native export software-decode command surface (cross-platform, ADR 0030
/// export-decode overlay). Backed by `NativeDecode::export_sw`; everything —
/// decoded frames and the control signals — reaches JS in-band as
/// [`ExportSwMsg`] on the per-session `ThreadsafeFunction` registered in
/// `export_sw_open`. The driving contract (open → decodeRange → returnCredit →
/// close) is what the export Worker's `ExportDecodeSession` handle sits behind.
#[napi]
impl NativeDecode {
    /// Open `path` for export decode into `out_format` (`"NV12"` or
    /// `"I420P10"`), throttled through a `credit_window`-frame flow-control
    /// window. Registers the
    /// per-session message callback BEFORE opening so no early message is
    /// dropped; fails loudly (removing the callback) if the format can't be
    /// emitted or the decoder can't open. Returns dimensions, source color tags,
    /// and start PTS.
    #[napi]
    pub fn export_sw_open(
        &self,
        session_id: String,
        path: String,
        out_format: String,
        credit_window: u32,
        on_msg: ThreadsafeFunction<ExportSwMsg>,
    ) -> napi::Result<ExportSwOpenInfoJs> {
        self.export_sw_sinks
            .lock_recover()
            .insert(session_id.clone(), on_msg);
        match self
            .export_sw
            .open(&session_id, &path, &out_format, credit_window)
        {
            Ok(info) => Ok(ExportSwOpenInfoJs {
                width: info.width,
                height: info.height,
                color_matrix: info.color.matrix,
                color_range: info.color.range,
                color_primaries: info.color.primaries,
                color_transfer: info.color.transfer,
                start_pts_us: info.start_pts_us as f64,
            }),
            Err(e) => {
                // Open failed — drop the callback we optimistically registered so
                // a failed session never leaves a dangling sink entry.
                self.export_sw_sinks.lock_recover().remove(&session_id);
                Err(napi::Error::from_reason(e))
            }
        }
    }

    /// Decode the presentation range `[a_us, b_us]` (source-normalized µs, b
    /// inclusive). Fire-and-forget: frame messages arrive on the registered
    /// callback, followed in-band by a `rangeEnd` (or `ended` then `rangeEnd` at
    /// stream end) once the range is satisfied. `a_us`/`b_us` cross as `f64` (no
    /// ergonomic napi `i64`).
    #[napi]
    pub fn export_sw_decode_range(
        &self,
        session_id: String,
        a_us: f64,
        b_us: f64,
    ) -> napi::Result<()> {
        self.export_sw
            .decode_range(&session_id, a_us as i64, b_us as i64)
            .map_err(napi::Error::from_reason)
    }

    /// Return `credits` consumed frames to the session, resuming a producer parked
    /// on an exhausted credit window. Safe to call while a range is in flight.
    #[napi]
    pub fn export_sw_return_credit(&self, session_id: String, credits: u32) -> napi::Result<()> {
        self.export_sw
            .return_credit(&session_id, credits)
            .map_err(napi::Error::from_reason)
    }

    /// Tear down a session: close+join the decode thread FIRST (unblocking any
    /// producer parked on the credit window), THEN drop the per-session callback,
    /// so no frame can arrive after its callback is removed.
    #[napi]
    pub fn export_sw_close(&self, session_id: String) -> napi::Result<()> {
        let r = self
            .export_sw
            .close(&session_id)
            .map_err(napi::Error::from_reason);
        self.export_sw_sinks.lock_recover().remove(&session_id);
        r
    }
}
