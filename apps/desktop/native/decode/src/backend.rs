use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use crate::events::{EventSink, TsfnEventSink};

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

/// Move a decoded `SwFrame` into its napi wire form. `Buffer::from(f.nv12)` takes
/// the `Vec` by value (zero-copy Rust-side); the single budgeted copy happens
/// when napi marshals the `Buffer` across the JS boundary.
fn sw_frame_to_napi(stream_id: &str, f: crate::preview_sw::decoder::SwFrame) -> PreviewSwFrame {
    PreviewSwFrame {
        stream_id: stream_id.to_string(),
        pts_us: f.pts_us as f64,
        dur_us: f.dur_us as f64,
        width: f.width,
        height: f.height,
        format: "NV12".into(),
        color_matrix: f.color.matrix,
        color_range: f.color.range,
        color_primaries: f.color.primaries,
        color_transfer: f.color.transfer,
        data: Buffer::from(f.nv12),
    }
}

/// The component's ffmpeg linkage identity — the SW capability-cache envKey
/// (D3). Changes when the bundled/loaded avcodec changes.
#[napi]
pub fn version_info() -> String {
    format!(
        "avcodec={} avutil={}",
        ffmpeg_next::codec::version(),
        ffmpeg_next::util::version()
    )
}

#[napi]
pub struct NativeDecode {
    #[cfg(windows)]
    preview_gpu: crate::preview_gpu::PreviewGpuRegistry,
    preview_sw: crate::preview_sw::PreviewSwRegistry,
    preview_sw_sinks: Arc<Mutex<HashMap<String, ThreadsafeFunction<PreviewSwFrame>>>>,
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
                    PreviewGpuPoke::FrameReady { stream_id, slot, pts_us, dur_us } => {
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
                        sink_events.emit("previewGpu:eof", serde_json::json!({ "streamId": stream_id }));
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
        #[cfg(not(windows))]
        let _ = &events; // events only feed GPU pokes today; SW frames bypass them

        // Software preview: the registry has a SINGLE global frame sink, so install
        // ONE routing closure here (NOT per-open, which would clobber earlier streams)
        // that dispatches each `Frame` poke to the matching stream's per-stream
        // `ThreadsafeFunction` in `preview_sw_sinks`. `Eof`/`Error` pokes have no JS
        // callback shape (the delivery contract is frame bytes only) — log them.
        let (preview_sw, preview_sw_sinks) = {
            let registry = crate::preview_sw::PreviewSwRegistry::new();
            let sinks: Arc<Mutex<HashMap<String, ThreadsafeFunction<PreviewSwFrame>>>> =
                Default::default();
            let sinks_for_cb = sinks.clone();
            registry.set_frame_sink(Box::new(move |poke| {
                use crate::preview_sw::SwFramePoke;
                match poke {
                    SwFramePoke::Frame { stream_id, frame } => {
                        if let Some(tsfn) = sinks_for_cb.lock().unwrap().get(&stream_id) {
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

        NativeDecode {
            #[cfg(windows)]
            preview_gpu,
            preview_sw,
            preview_sw_sinks,
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
                .map(|h| PreviewGpuSlot { handle: Buffer::from(h.to_le_bytes().to_vec()) })
                .collect(),
        })
    }

    /// Move the session's decode anchor. `target_us` is an `f64` (napi has no
    /// ergonomic `i64` param binding) carrying source microseconds; cast down
    /// to the `i64` the registry expects.
    #[napi]
    pub fn preview_gpu_request_frame_at(&self, stream_id: String, target_us: f64) -> napi::Result<()> {
        self.preview_gpu
            .request_frame_at(&stream_id, target_us as i64)
            .map_err(napi::Error::from_reason)
    }

    /// Release a slot back to the pool after the renderer drops its last
    /// cross-process reference to the shared texture.
    #[napi]
    pub fn preview_gpu_consume_ack(&self, stream_id: String, slot: u32) -> napi::Result<()> {
        self.preview_gpu.consume_ack(&stream_id, slot).map_err(napi::Error::from_reason)
    }

    /// Tear down a session: signals its decode thread to close and joins it.
    #[napi]
    pub fn preview_gpu_close(&self, stream_id: String) -> napi::Result<()> {
        self.preview_gpu.close(&stream_id).map_err(napi::Error::from_reason)
    }

    /// Drain + return this session's Stage-3 timing samples (coord-RTT + decode/copy).
    #[napi]
    pub fn preview_gpu_take_timings(&self, stream_id: String) -> napi::Result<PreviewGpuTimingReport> {
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
    pub fn preview_gpu_request_frame_at(&self, _stream_id: String, _target_us: f64) -> napi::Result<()> {
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
    pub fn preview_gpu_take_timings(&self, _stream_id: String) -> napi::Result<PreviewGpuTimingReport> {
        Err(napi::Error::from_reason("preview-gpu not built"))
    }
}

// ── SW methods (all platforms) ───────────────────────────────────────────────

/// Native software-decode preview command surface (cross-platform). Backed by
/// `NativeDecode::preview_sw`; decoded NV12 frames reach JS through the
/// per-stream `ThreadsafeFunction` registered in `preview_sw_open` and routed
/// by the single sink installed in the constructor.
#[napi]
impl NativeDecode {
    /// Open `path` for software preview: register the per-stream frame callback,
    /// then spawn the session's decode thread and return the frame dimensions.
    /// The callback is registered BEFORE `open` so no early poke is dropped.
    #[napi]
    pub fn preview_sw_open(
        &self,
        stream_id: String,
        path: String,
        on_frame: ThreadsafeFunction<PreviewSwFrame>,
    ) -> napi::Result<PreviewSwOpenInfoJs> {
        self.preview_sw_sinks
            .lock()
            .unwrap()
            .insert(stream_id.clone(), on_frame);
        let info = self
            .preview_sw
            .open(&stream_id, &path)
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
    pub fn preview_sw_request_frame_at(&self, stream_id: String, target_us: f64) -> napi::Result<()> {
        self.preview_sw
            .request_frame_at(&stream_id, target_us as i64)
            .map_err(napi::Error::from_reason)
    }

    /// Tear down a session: close+join the decode thread FIRST (the FIFO command
    /// channel guarantees no poke is in flight once `close` returns), THEN drop
    /// the per-stream `ThreadsafeFunction` — so no `Frame` poke can arrive after
    /// its callback is removed. Returns the close result either way.
    #[napi]
    pub fn preview_sw_close(&self, stream_id: String) -> napi::Result<()> {
        let r = self.preview_sw.close(&stream_id).map_err(napi::Error::from_reason);
        self.preview_sw_sinks.lock().unwrap().remove(&stream_id);
        r
    }
}
