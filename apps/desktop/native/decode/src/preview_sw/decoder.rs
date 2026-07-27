//! Pure-software streaming decode → tightly-packed CPU frame bytes (8-bit NV12,
//! or u16LE I420P10 for the export 10-bit lane). A strict simplification of
//! `preview_gpu/decoder.rs`'s `VideoStream`: same open/pump/seek shape, but with
//! the entire D3D11VA hardware path deleted (no `av_hwdevice_ctx_create`, no
//! `get_format` override, no COM-pointer plumbing). libavcodec decodes to a CPU
//! frame in its native pixel format (e.g. ProRes' `yuv422p10le`) and swscale
//! packs it to the stream's target format in one pass.
//!
//! The `session` module consumes `seek`, the color tags, and the per-frame
//! timestamps; they are defined here so the streaming surface is complete in
//! one place.
#![allow(dead_code)]

use ffmpeg_next::ffi as ffs;
use ffmpeg_next::format::{input, Pixel};
use ffmpeg_next::media::Type;
use ffmpeg_next::software::scaling::{context::Context as SwsContext, flag::Flags};
use ffmpeg_next::util::frame::video::Video as VideoFrame;
use std::ffi::CString;
use std::ptr;

use crate::media_time::{source_us_to_ticks_floor, ticks_to_source_us, ticks_to_us};

// FF_THREAD_FRAME (1) / FF_THREAD_SLICE (2) from libavcodec/avcodec.h. Literals,
// not ffs:: symbols: ffmpeg-sys-next does not re-export these #define flags
// uniformly across versions, and the values are ABI-stable across ffmpeg majors.
const FF_THREAD_FRAME: i32 = 1;
const FF_THREAD_SLICE: i32 = 2;

/// Threads to request for software decode: one per logical core, clamped to
/// [1, 16]. Parallel decode is the biggest lever for 4K SW throughput; libavcodec
/// sees diminishing returns past ~16 threads and each costs frame-buffer memory.
fn decode_thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .clamp(1, 16) as i32
}

/// Threading mode per codec family. Frame-threading (FF_THREAD_FRAME) parallelises
/// across frames but adds a multi-frame output delay that re-primes after every
/// seek's avcodec_flush_buffers — measured ~600ms backward-far scrub on 4K ProRes
/// for no throughput gain on intra codecs (decode-bench). So intra
/// families (ProRes/DNxHD) use slice-threading only (parallel WITHIN a frame, no
/// output delay = snappy scrub); long-GOP families (MPEG-2/VC-1/WMV3), whose many
/// inter-frames frame-threading can actually parallelise, keep FRAME|SLICE.
fn thread_type_for(id: ffmpeg_next::codec::Id) -> i32 {
    use ffmpeg_next::codec::Id;
    match id {
        Id::PRORES | Id::DNXHD => FF_THREAD_SLICE,
        _ => FF_THREAD_FRAME | FF_THREAD_SLICE,
    }
}

/// Which decode acceleration a stream opens with (issue #5 Block C). Software is
/// the universal lane; the hardware lanes decode on the GPU and copy the surface
/// back to a CPU frame (`av_hwframe_transfer_data`) so the packed bytes feed the
/// SAME NV12 transport as software (ADR 0029 ship-bytes) — hardware-vs-software
/// stays private to the Standard engine, one transport, no new IPC. Mirrors the
/// Windows `preview_gpu` hwaccel setup but yields CPU bytes instead of a shared
/// D3D11 texture (copy-back, not zero-copy — the deferred zero-copy path awaits
/// decode-bench numbers).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecodeAccel {
    /// libavcodec decodes to a CPU frame (every platform).
    Software,
    /// NVDEC via the CUDA hwcontext; decodes on the default NVIDIA GPU handle
    /// (no device string — one NVDEC decoder per machine in v1).
    Nvdec,
    /// VAAPI pinned to a specific DRM render node (e.g. `/dev/dri/renderD128`):
    /// libva's default device selection picks the wrong GPU on a multi-GPU
    /// machine, so the node is always explicit.
    ///
    /// libva REQUIREMENT (validated on real hardware, issue #5 Block C): the BtbN
    /// LGPL build lazily `dlopen`s `libva.so.2` via implib-gen, and the copy-back
    /// (`av_hwframe_transfer_data` mapping the surface to CPU) calls `vaMapBuffer2`
    /// — a libva 2.21 (2024-03) symbol the current stable distros' 2.20 lack (e.g.
    /// Ubuntu 24.04). Against a libva without it the implib trampoline aborts the
    /// process UNCATCHABLY on the first mapped frame (decode + the one-frame probe
    /// succeed — they never map). We fix this by BUNDLING a >= 2.21 libva beside
    /// the addon and pinning it so the implib resolves it (see
    /// [`vaapi_copyback_supported`]); its `vaMapBuffer2` gracefully dispatches to
    /// the system driver's `vaMapBuffer`. When the bundled libva can't load (glibc
    /// too old), that guard declines VAAPI → software fallback, never a crash.
    /// (NVDEC is unaffected: its implib'd `libcuda` comes from the current NVIDIA
    /// driver, which carries every symbol it needs.)
    Vaapi { device: String },
}

impl DecodeAccel {
    /// The libavutil hw device type, or `None` for software.
    fn hw_device_type(&self) -> Option<ffs::AVHWDeviceType> {
        match self {
            DecodeAccel::Software => None,
            DecodeAccel::Nvdec => Some(ffs::AVHWDeviceType::AV_HWDEVICE_TYPE_CUDA),
            DecodeAccel::Vaapi { .. } => Some(ffs::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI),
        }
    }

    /// The hardware surface format the decoder yields for this lane — what
    /// `get_format` must select to keep frames on the GPU, and what the probe
    /// checks to prove hardware decode actually engaged. `None` for software.
    fn hw_pix_fmt(&self) -> Option<Pixel> {
        match self {
            DecodeAccel::Software => None,
            DecodeAccel::Nvdec => Some(Pixel::CUDA),
            DecodeAccel::Vaapi { .. } => Some(Pixel::VAAPI),
        }
    }

    /// The device string passed to `av_hwdevice_ctx_create` (VAAPI: the DRM node;
    /// NVDEC/software: none = default).
    fn device_cstr(&self) -> Option<CString> {
        match self {
            DecodeAccel::Vaapi { device } => CString::new(device.as_str()).ok(),
            _ => None,
        }
    }
}

/// True for the GPU-surface pixel formats a hardware lane decodes to — the frame
/// must be transferred to system memory before it can be packed. (D3D11 is
/// included for symmetry with the Windows path, though this module's hw lanes are
/// CUDA/VAAPI.)
fn is_hw_pix_format(fmt: Pixel) -> bool {
    matches!(fmt, Pixel::CUDA | Pixel::VAAPI | Pixel::D3D11)
}

/// Walk libavcodec's offered `pix_fmts` (NONE-terminated) and return `want` if
/// present, so hardware frames stay on the GPU; otherwise the first offered
/// (software) format — the same fall-through the Windows `get_format_d3d11` uses,
/// which is what makes a failed hw negotiation surface as a software-format frame
/// the probe can detect.
fn pick_hw_pix_format(
    pix_fmts: *const ffs::AVPixelFormat,
    want: ffs::AVPixelFormat,
) -> ffs::AVPixelFormat {
    let mut p = pix_fmts;
    while unsafe { *p } != ffs::AVPixelFormat::AV_PIX_FMT_NONE {
        if unsafe { *p } == want {
            return want;
        }
        p = unsafe { p.add(1) };
    }
    unsafe { *pix_fmts }
}

unsafe extern "C" fn get_format_cuda(
    _ctx: *mut ffs::AVCodecContext,
    pix_fmts: *const ffs::AVPixelFormat,
) -> ffs::AVPixelFormat {
    pick_hw_pix_format(pix_fmts, ffs::AVPixelFormat::AV_PIX_FMT_CUDA)
}

unsafe extern "C" fn get_format_vaapi(
    _ctx: *mut ffs::AVCodecContext,
    pix_fmts: *const ffs::AVPixelFormat,
) -> ffs::AVPixelFormat {
    pick_hw_pix_format(pix_fmts, ffs::AVPixelFormat::AV_PIX_FMT_VAAPI)
}

/// Pin the BUNDLED libva (>= 2.21) and report whether it can copy back (issue #5
/// Block C). The BtbN LGPL ffmpeg calls `vaMapBuffer2` (a libva 2.21 symbol)
/// unconditionally during `av_hwframe_transfer_data`; against a libva without it
/// the implib-gen trampoline aborts the process UNCATCHABLY on the first mapped
/// frame. We ship a >= 2.21 `libva.so.2` beside the addon and MUST make the BtbN
/// implib resolve it instead of a stale system libva.
///
/// The mechanism is "same soname wins": `dlopen("libva.so.2")` from THIS addon
/// resolves the bundled copy via the .node's RUNPATH (`$ORIGIN`), and we keep it
/// resident (`RTLD_GLOBAL | RTLD_NODELETE`, never `dlclose`d). The implib lives
/// in `libavutil.so`, which carries no rpath of its own — RUNPATH does NOT climb
/// the loader chain, so ITS later lazy `dlopen("libva.so.2")` would otherwise hit
/// the system libva via `ld.so.cache`. Because we pinned ours first, that dlopen
/// returns the already-loaded bundled object, so `vaMapBuffer2` is present and
/// dispatches to the system driver's `vaMapBuffer` (libva falls back for drivers
/// that predate the symbol). Verified on real hardware (Intel iHD, system libva
/// 2.20): a real NV12 copy-back frame, no abort.
///
/// Returns false — declining VAAPI so the caller falls back to software, no crash
/// — when the bundled `.so` can't load (glibc older than its 2.38 floor) or when
/// a system libva was already resident and lacks `vaMapBuffer2`. Off Linux: false
/// (VAAPI is a Linux lane). Idempotent: repeated calls just re-`dlopen` the
/// already-resident handle.
#[cfg(target_os = "linux")]
pub fn vaapi_copyback_supported() -> bool {
    use std::ffi::CString;
    unsafe {
        let name = CString::new("libva.so.2").unwrap();
        // RTLD_NODELETE + no dlclose: pin bundled libva for the process lifetime
        // so the implib's dlopen finds it. RTLD_GLOBAL so the implib's symbol
        // resolution sees it uniformly.
        let handle = libc::dlopen(
            name.as_ptr(),
            libc::RTLD_LAZY | libc::RTLD_GLOBAL | libc::RTLD_NODELETE,
        );
        if handle.is_null() {
            return false;
        }
        let sym = CString::new("vaMapBuffer2").unwrap();
        !libc::dlsym(handle, sym.as_ptr()).is_null()
    }
}
#[cfg(not(target_os = "linux"))]
pub fn vaapi_copyback_supported() -> bool {
    false
}

/// Attach `accel`'s hw device context + `get_format` override to `codec_ctx`
/// (called BEFORE `avcodec_open2`). Returns the created `AVBufferRef` — the
/// caller owns it and must `av_buffer_unref` it (SwVideoStream does so on drop).
/// Errors if the device can't be created (GPU/driver absent → the resolver's
/// silent software fallback). Must not be called for `Software`. For VAAPI it
/// also errors BEFORE creating the device when the bundled libva can't copy back
/// (see [`vaapi_copyback_supported`], which also pins the bundled libva so the
/// implib resolves it) — turning the would-be uncatchable abort on the first
/// mapped frame into a graceful `Err` + software fallback.
unsafe fn attach_hw_device(
    codec_ctx: &mut ffmpeg_next::codec::context::Context,
    accel: &DecodeAccel,
) -> Result<*mut ffs::AVBufferRef, String> {
    let hw_type = accel
        .hw_device_type()
        .ok_or_else(|| "attach_hw_device called for software".to_string())?;
    // VAAPI copy-back (`av_hwframe_transfer_data`) calls `vaMapBuffer2` through the
    // implib'd libva; against a libva without it the process aborts UNCATCHABLY on
    // the first mapped frame. This call also pins the bundled >= 2.21 libva so the
    // implib resolves it; if it can't (glibc too old), decline the lane up front —
    // BEFORE creating the device — so the caller falls back to software instead.
    if matches!(accel, DecodeAccel::Vaapi { .. }) && !vaapi_copyback_supported() {
        return Err(
            "bundled libva unavailable (no vaMapBuffer2); vaapi copy-back would abort".to_string(),
        );
    }
    // Keep the CString alive across the create call (dev_ptr borrows it).
    let device = accel.device_cstr();
    let dev_ptr = device.as_ref().map(|c| c.as_ptr()).unwrap_or(ptr::null());

    let mut hw_ctx: *mut ffs::AVBufferRef = ptr::null_mut();
    let ret =
        unsafe { ffs::av_hwdevice_ctx_create(&mut hw_ctx, hw_type, dev_ptr, ptr::null_mut(), 0) };
    if ret < 0 || hw_ctx.is_null() {
        return Err(format!(
            "av_hwdevice_ctx_create({accel:?}) failed (ret={ret})"
        ));
    }
    unsafe {
        let raw = codec_ctx.as_mut_ptr();
        (*raw).hw_device_ctx = ffs::av_buffer_ref(hw_ctx);
        (*raw).get_format = Some(match accel {
            DecodeAccel::Nvdec => get_format_cuda,
            DecodeAccel::Vaapi { .. } => get_format_vaapi,
            DecodeAccel::Software => unreachable!("guarded above"),
        });
    }
    Ok(hw_ctx)
}

/// FFmpeg color metadata carried alongside each decoded frame, as canonical
/// FFmpeg string names (`bt709`, `bt470bg`, `smpte170m`, `tv`/`pc`, …) so they
/// match the ffprobe-sourced tags the rest of the app uses (single color model,
/// ADR 0021). `None` where the stream leaves the value unspecified.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SwColorTags {
    pub matrix: Option<String>,
    pub range: Option<String>,
    pub primaries: Option<String>,
    pub transfer: Option<String>,
}

/// Target pixel format a stream packs decoded frames into. The preview lane is
/// NV12-only ([`SwVideoStream::open`]); the export lane picks per session
/// (`export_sw::ExportOutFormat`). `wire_name` is the tag JS sees on the frame
/// wire structs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwOutFormat {
    /// 8-bit: `Y` plane `w*h` bytes, then interleaved `UV` `w*h/2` bytes.
    Nv12,
    /// 10-bit (yuv420p10le semantics, samples 0–1023): tightly-packed u16LE
    /// planes `Y` (`w*h` samples, stride `w*2` bytes) then `U` then `V` at
    /// `(w>>1) × (h>>1)`. Byte-matches the renderer's `copyToTenBit` layout
    /// (`render/decoder/tenBitFrame.ts`) including its floor chroma rounding.
    I420p10,
}

impl SwOutFormat {
    pub fn wire_name(self) -> &'static str {
        match self {
            SwOutFormat::Nv12 => "NV12",
            SwOutFormat::I420p10 => "I420P10",
        }
    }
}

/// Smallest long edge (px) a downscaled frame may ship at. Without it, ¼ of an
/// already-small source is a thumbnail the Compositor then blows back up over
/// the whole canvas.
const MIN_SCALED_LONG_EDGE: u32 = 320;

/// Largest divisor honored. The wire carries 1 | 2 | 4 (Premiere's Full/½/¼);
/// anything wilder is clamped rather than trusted.
const MAX_OUT_DIVISOR: u32 = 4;

/// The ship-stage output-size policy: an integer divisor applied to the source
/// dimensions before a frame is packed, so a 4K preview frame crosses IPC at ¼
/// or 1/16 of 12.44 MB (playback resolution). swscale converts and scales in one
/// traversal, so a smaller destination makes the existing pass CHEAPER on every
/// non-NV12 source — the downscale is negative cost before a single saved IPC
/// byte.
///
/// [`FULL`](Self::FULL) is the `Default` and the identity: the export lane never
/// sets a divisor, and MUST keep decoding at source resolution — an export
/// silently rendered at half res is data loss.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutScale(u32);

impl Default for OutScale {
    fn default() -> Self {
        OutScale::FULL
    }
}

impl OutScale {
    /// No downscale: frames ship at source resolution, through the exact
    /// pre-scaling code path.
    pub const FULL: OutScale = OutScale(1);

    /// Clamped to `[1, MAX_OUT_DIVISOR]`, so a bogus wire value can neither
    /// divide by zero nor ask for a thumbnail.
    pub fn from_divisor(div: u32) -> Self {
        OutScale(div.clamp(1, MAX_OUT_DIVISOR))
    }

    pub fn divisor(self) -> u32 {
        self.0
    }

    /// The dimensions a `(src_w, src_h)` frame actually ships at. One place owns
    /// this math; everything downstream reports what it returns.
    ///
    /// Divisor 1 returns the source dims VERBATIM — no even-rounding, no
    /// swscale — because full resolution must stay byte-identical to the
    /// pre-scaling behavior, odd source dims included. A divisor that would push
    /// the long edge below [`MIN_SCALED_LONG_EDGE`] steps down to the largest one
    /// that clears it (and 1 always clears it).
    ///
    /// LANDMINE: both axes round DOWN to even. NV12 chroma is subsampled and
    /// [`extract_nv12_planes`] walks `h / 2` rows, so an odd dimension silently
    /// drops a row. Per-axis rounding can drift the aspect by <1%; harmless,
    /// because the Compositor derives scaleX/scaleY independently from
    /// `media.width / textureW`.
    pub fn dims_for(self, src_w: u32, src_h: u32) -> (u32, u32) {
        let mut div = self.0;
        while div > 1 {
            let (w, h) = ((src_w / div) & !1, (src_h / div) & !1);
            if w.max(h) >= MIN_SCALED_LONG_EDGE {
                return (w, h);
            }
            div -= 1;
        }
        (src_w, src_h)
    }
}

/// Preview-only producer cadence: decode every source frame (references stay
/// intact), but only pack and ship one out of every `divisor` frames. The phase
/// advances immediately after `receive_frame`, before hardware copy-back,
/// swscale, output packing, and IPC allocation. Export never sets this policy
/// and therefore retains the identity cadence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutputCadence {
    divisor: u32,
    phase: u32,
}

impl Default for OutputCadence {
    fn default() -> Self {
        Self::FULL
    }
}

impl OutputCadence {
    pub const FULL: OutputCadence = OutputCadence {
        divisor: 1,
        phase: 0,
    };

    /// The budget-spill policy currently requests 2 (~15fps from a 30fps
    /// source). Clamp the wire to the same defensive range as output scale.
    pub fn from_divisor(divisor: u32) -> Self {
        Self {
            divisor: divisor.clamp(1, MAX_OUT_DIVISOR),
            phase: 0,
        }
    }

    pub fn divisor(self) -> u32 {
        self.divisor
    }

    fn should_ship(&mut self) -> bool {
        let ship = self.phase == 0;
        self.phase = (self.phase + 1) % self.divisor;
        ship
    }

    fn reset(&mut self) {
        self.phase = 0;
    }
}

/// One software-decoded frame, tightly packed per `format` (layouts on
/// [`SwOutFormat`]) plus its source-normalized timing and color tags. Fully
/// owned (unlike the GPU path's borrowed texture handle), so it can outlive
/// the stream and cross threads freely.
#[derive(Debug)]
pub struct SwFrame {
    pub data: Vec<u8>,
    pub format: SwOutFormat,
    /// The SHIPPED dimensions (the stream's [`OutScale`] already applied), which
    /// `data`'s length always matches — never the source's when they differ.
    pub width: u32,
    pub height: u32,
    /// Presentation time, source-normalized microseconds (`ticks_to_source_us`).
    pub pts_us: i64,
    /// Frame duration in microseconds (a delta, not a timestamp).
    pub dur_us: i64,
    pub color: SwColorTags,
}

/// An open software decode session that yields successive CPU frames. Mirrors
/// `preview_gpu`'s `VideoStream` packet-pump contract: each
/// `self.ictx.packets().next()` reads the *next* packet because the read
/// position lives inside the `AVFormatContext`, so a fresh iterator per call
/// resumes where the previous one left off.
pub struct SwVideoStream {
    ictx: ffmpeg_next::format::context::Input,
    decoder: ffmpeg_next::decoder::Video,
    stream_index: usize,
    /// Reused frame buffer; `receive_frame` overwrites it each call.
    frame: VideoFrame,
    /// Reused swscale destination, reallocated only when the required
    /// `(format, width, height)` changes — see [`ensure_scratch`]. Stays untouched
    /// on the already-correct-format fast paths, which skip swscale entirely.
    out_scratch: VideoFrame,
    /// Set once `send_eof` has been issued, so we only drain afterwards.
    eof_sent: bool,
    /// Source frame dimensions as libavcodec reports them — the swscale SOURCE,
    /// not necessarily what ships (see `out_width`/`out_height`).
    pub width: u32,
    pub height: u32,
    /// Dimensions every packed frame actually carries: the stream's [`OutScale`]
    /// applied to `(width, height)`, fixed at open. Equal to the source dims at
    /// `OutScale::FULL` — which is always the case on the export lane.
    pub out_width: u32,
    pub out_height: u32,
    /// Video stream's `(numerator, denominator)`, captured at `open`. Needed by
    /// `ticks_to_source_us` and by `seek`'s target-us -> stream-timestamp math.
    pub time_base: (i32, i32),
    /// Container's first-packet PTS (source-normalized microseconds), so
    /// `ticks_to_source_us` reports source t=0 at the visible start rather than at
    /// the container's internal PTS origin.
    pub start_pts_us: i64,
    /// Stream color metadata, read once at `open` (stable for the whole stream).
    pub color: SwColorTags,
    /// Threads libavcodec settled on after open (1 if the codec can't thread).
    pub thread_count: i32,
    /// Target format every decoded frame is packed into, fixed at open.
    out_format: SwOutFormat,
    /// Producer-side preview cadence. Identity by default; when reduced, the
    /// skipped decoded frames never reach copy-back/swscale/packing.
    output_cadence: OutputCadence,
    /// The hw device context when this stream decodes on a hardware lane
    /// (`DecodeAccel::Nvdec`/`Vaapi`), else null. Owned here; unref'd on drop.
    /// Must outlive the decoder (which holds a ref via `hw_device_ctx`).
    hw_ctx: *mut ffs::AVBufferRef,
}

// The ffmpeg-next `Input`/`Video` wrappers hold raw pointers and are `!Send`.
// Mirror `preview_gpu::VideoStream`: the stream is only ever driven from a single
// owner (its session thread) and its pointers never cross threads, so it is
// sound to mark `Send`.
unsafe impl Send for SwVideoStream {}

impl Drop for SwVideoStream {
    fn drop(&mut self) {
        // Release our owning ref to the hw device context (the decoder's own ref
        // dropped when `decoder` did). Null on the software lane — no-op.
        unsafe {
            if !self.hw_ctx.is_null() {
                ffs::av_buffer_unref(&mut self.hw_ctx);
            }
        }
    }
}

impl SwVideoStream {
    /// Open `path` for pure-software decode into NV12 at full resolution (probes
    /// and tests; the preview session passes its own [`OutScale`]).
    pub fn open(path: &str) -> Result<SwVideoStream, String> {
        Self::open_with_accel(
            path,
            SwOutFormat::Nv12,
            DecodeAccel::Software,
            OutScale::FULL,
        )
    }

    /// Open `path` for pure-software decode, packing every decoded frame into
    /// `out_format` (the export lane's 10-bit selector). Software only, and
    /// always at FULL resolution — export must never inherit a preview
    /// downscale.
    pub fn open_with_format(path: &str, out_format: SwOutFormat) -> Result<SwVideoStream, String> {
        Self::open_with_accel(path, out_format, DecodeAccel::Software, OutScale::FULL)
    }

    /// Open `path` on `accel` and prepare for streaming, packing every decoded
    /// frame into `out_format` at `out_scale`'s output size. On a hardware lane a
    /// hw device context is attached (`get_format` keeps frames on the GPU) and
    /// each `next_frame` transfers the surface back to system memory before
    /// packing — the packed bytes are identical to the software lane's, so the
    /// same transport carries both (and the copy-back lanes get the downscale for
    /// free: the transfer lands a full-size CPU frame either way). On the software
    /// lane libavcodec decodes to CPU frames with parallel threads. A hw device
    /// that can't be created (GPU/driver absent) surfaces as an `Err` so the
    /// caller falls back to software.
    pub fn open_with_accel(
        path: &str,
        out_format: SwOutFormat,
        accel: DecodeAccel,
        out_scale: OutScale,
    ) -> Result<SwVideoStream, String> {
        ffmpeg_next::init().ok();
        let map = |e: ffmpeg_next::Error| e.to_string();

        let ictx = input(&path).map_err(map)?;
        let stream = ictx
            .streams()
            .best(Type::Video)
            .ok_or_else(|| "no video stream".to_string())?;
        let stream_index = stream.index();
        let time_base = (
            stream.time_base().numerator(),
            stream.time_base().denominator(),
        );
        // `start_time()` is the container's first-packet PTS in stream time_base
        // units (AV_NOPTS_VALUE if unknown); convert to source-normalized us so
        // `ticks_to_source_us` reports t=0 at the visible start. Fall back to 0.
        let start_time_raw = stream.start_time();
        let start_pts_us = if start_time_raw != ffs::AV_NOPTS_VALUE {
            ticks_to_us(start_time_raw, time_base)
        } else {
            0
        };

        let mut codec_ctx =
            ffmpeg_next::codec::context::Context::from_parameters(stream.parameters())
                .map_err(map)?;
        // hw lane: attach the device + get_format BEFORE avcodec_open2. sw lane:
        // request parallel decode threads instead (per-codec-family thread_type —
        // slice-only for intra ProRes/DNxHD to keep scrub snappy, FRAME|SLICE for
        // long-GOP throughput; threaded decode is byte-identical, only faster). A
        // hardware decoder runs on the GPU, so CPU thread tuning does not apply.
        let mut hw_ctx: *mut ffs::AVBufferRef = ptr::null_mut();
        if accel.hw_device_type().is_some() {
            hw_ctx = unsafe { attach_hw_device(&mut codec_ctx, &accel)? };
        } else {
            let requested_threads = decode_thread_count();
            let thread_type = thread_type_for(stream.parameters().id());
            unsafe {
                let raw = codec_ctx.as_mut_ptr();
                (*raw).thread_count = requested_threads;
                (*raw).thread_type = thread_type;
            }
        }
        // If the decoder open fails after we created a hw context, release it so a
        // failed hw open never leaks the device.
        let mut decoder = match codec_ctx.decoder().video() {
            Ok(d) => d,
            Err(e) => {
                unsafe {
                    if !hw_ctx.is_null() {
                        ffs::av_buffer_unref(&mut hw_ctx);
                    }
                }
                return Err(map(e));
            }
        };
        // Count libavcodec actually settled on (clamped to 1 for a codec without
        // threading support). Read via the raw context (as_mut_ptr is already used
        // by `seek`).
        let thread_count = unsafe { (*decoder.as_mut_ptr()).thread_count };
        let width = decoder.width();
        let height = decoder.height();
        let (out_width, out_height) = out_scale.dims_for(width, height);

        // Reuse ffmpeg-next's canonical AVCOL->string mapping (`av_color_*_name`,
        // the same functions ffprobe uses), so these strings match the import
        // probe's `color_matrix/color_range/...`. `.name()` returns `None` for
        // unspecified values.
        let color = SwColorTags {
            matrix: decoder.color_space().name().map(|s| s.to_string()),
            range: decoder.color_range().name().map(|s| s.to_string()),
            primaries: decoder.color_primaries().name().map(|s| s.to_string()),
            transfer: decoder
                .color_transfer_characteristic()
                .name()
                .map(|s| s.to_string()),
        };

        Ok(SwVideoStream {
            ictx,
            decoder,
            stream_index,
            frame: VideoFrame::empty(),
            out_scratch: VideoFrame::empty(),
            eof_sent: false,
            width,
            height,
            out_width,
            out_height,
            time_base,
            start_pts_us,
            color,
            thread_count,
            out_format,
            output_cadence: OutputCadence::FULL,
            hw_ctx,
        })
    }

    /// Preview sessions may reduce producer cadence after open. Every other
    /// caller keeps [`OutputCadence::FULL`], including export and probes.
    pub fn set_output_cadence(&mut self, output_cadence: OutputCadence) {
        self.output_cadence = output_cadence;
    }

    /// Read codec/pix_fmt identity off the already-open decoder context, without
    /// touching the packet/frame pump. `codec` is libavcodec's canonical short
    /// name (`AVCodec.name` via `self.decoder.codec()`, e.g. `"prores"`);
    /// `pix_fmt` is libavutil's canonical descriptor name (`av_pix_fmt_desc_get`
    /// via `Pixel::descriptor()`, e.g. `"yuv422p10le"`) — both match the strings
    /// ffprobe reports, so a probe-informed class key needs no
    /// caller-side guessing. Falls back to `"unknown"` in the (should-not-happen
    /// post-open) case either lookup comes back empty.
    pub fn probe_identity(&self) -> (String, String, u32, u32) {
        let codec = self
            .decoder
            .codec()
            .map(|c| c.name().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let pix_fmt = self
            .decoder
            .format()
            .descriptor()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        (codec, pix_fmt, self.width, self.height)
    }

    /// Decode the next frame, packed as owned bytes in the stream's target
    /// format. Returns `Ok(None)` at end of stream.
    pub fn next_frame(&mut self) -> Result<Option<SwFrame>, String> {
        let map = |e: ffmpeg_next::Error| e.to_string();
        loop {
            // Drain any already-decoded frame first.
            if self.decoder.receive_frame(&mut self.frame).is_ok() {
                let (pts_us, dur_us) = unsafe {
                    let p = self.frame.as_ptr();
                    let pts = if (*p).pts != ffs::AV_NOPTS_VALUE {
                        (*p).pts
                    } else {
                        (*p).best_effort_timestamp
                    };
                    let dur = (*p).duration;
                    let dur_us = ticks_to_us(dur, self.time_base);
                    (
                        ticks_to_source_us(pts, self.time_base, self.start_pts_us),
                        dur_us,
                    )
                };
                // Decode is never skipped — long-GOP reference state remains
                // correct — but an unselected frame stops HERE, before hardware
                // copy-back, swscale, output packing, and the IPC byte buffer.
                if !self.output_cadence.should_ship() {
                    continue;
                }
                // A hardware lane decodes to a GPU surface; copy it back to system
                // memory before packing so the bytes feed the same transport as
                // software. The software lane's frame is already in system memory
                // (`is_hw_pix_format` false) — no transfer, byte-identical output.
                let mut hw_scratch = VideoFrame::empty();
                let src: &VideoFrame = if is_hw_pix_format(self.frame.format()) {
                    unsafe {
                        let ret = ffs::av_hwframe_transfer_data(
                            hw_scratch.as_mut_ptr(),
                            self.frame.as_ptr(),
                            0,
                        );
                        if ret < 0 {
                            return Err(format!("av_hwframe_transfer_data failed (ret={ret})"));
                        }
                    }
                    &hw_scratch
                } else {
                    &self.frame
                };
                // Source dims in, SHIPPED dims out: at `OutScale::FULL` these are
                // the same pair and the pack takes the pre-scaling path.
                let (sw, sh) = (self.width, self.height);
                let (dw, dh) = (self.out_width, self.out_height);
                let data = match self.out_format {
                    SwOutFormat::Nv12 => frame_to_nv12(src, sw, sh, dw, dh, &mut self.out_scratch),
                    SwOutFormat::I420p10 => {
                        frame_to_i420p10(src, sw, sh, dw, dh, &mut self.out_scratch)
                    }
                }
                .map_err(map)?;
                return Ok(Some(SwFrame {
                    data,
                    format: self.out_format,
                    width: self.out_width,
                    height: self.out_height,
                    pts_us,
                    dur_us,
                    color: self.color.clone(),
                }));
            }

            if self.eof_sent {
                // Already flushing and the decoder gave nothing -> end of stream.
                return Ok(None);
            }

            // Feed one more video packet (a fresh PacketIter resumes the read
            // position, which lives in the AVFormatContext).
            match self.ictx.packets().next() {
                Some((s, p)) => {
                    if s.index() == self.stream_index {
                        self.decoder.send_packet(&p).map_err(map)?;
                    }
                    // Non-video packet: loop and try receive/next again.
                }
                None => {
                    self.decoder.send_eof().map_err(map)?;
                    self.eof_sent = true;
                    // Loop: drain the flushed frames.
                }
            }
        }
    }

    /// Seek to the keyframe at or before target_us, flush the decoder, and arm
    /// forward decode. AVSEEK_FLAG_BACKWARD lands on a key packet <= target.
    /// ProRes is intra-frame, so a single decode after seek yields the target.
    pub fn seek(&mut self, target_us: i64) -> Result<(), String> {
        let ts = source_us_to_ticks_floor(target_us, self.time_base, self.start_pts_us);
        unsafe {
            let ret = ffs::av_seek_frame(
                self.ictx.as_mut_ptr(),
                self.stream_index as i32,
                ts,
                ffs::AVSEEK_FLAG_BACKWARD,
            );
            if ret < 0 {
                return Err(format!("av_seek_frame failed (ret={ret})"));
            }
            // Flush decoder buffers so post-seek receive_frame doesn't return
            // pre-seek frames (avcodec_flush_buffers on the raw context).
            ffs::avcodec_flush_buffers(self.decoder.as_mut_ptr());
        }
        self.eof_sent = false;
        // A new seek anchor must always yield its first decoded candidate.
        // Besides deterministic scrub, robust_seek_and_probe depends on seeing
        // that candidate to detect an approximate-seek overshoot.
        self.output_cadence.reset();
        Ok(())
    }

    /// Decode one frame and return its RAW pixel format — the hardware surface
    /// format (`Pixel::CUDA`/`Pixel::VAAPI`) when a hw lane actually engaged, or
    /// the CPU format when the decoder fell back to software. No transfer, no
    /// packing. `Ok(None)` at immediate end of stream. Backs the hw probe.
    fn decode_one_raw_format(&mut self) -> Result<Option<Pixel>, String> {
        let map = |e: ffmpeg_next::Error| e.to_string();
        loop {
            if self.decoder.receive_frame(&mut self.frame).is_ok() {
                return Ok(Some(self.frame.format()));
            }
            match self.ictx.packets().next() {
                Some((s, p)) => {
                    if s.index() == self.stream_index {
                        self.decoder.send_packet(&p).map_err(map)?;
                    }
                }
                None => {
                    self.decoder.send_eof().map_err(map)?;
                    if self.decoder.receive_frame(&mut self.frame).is_ok() {
                        return Ok(Some(self.frame.format()));
                    }
                    return Ok(None);
                }
            }
        }
    }
}

/// One-frame hardware-decode probe (issue #5 Block C). Opens `path` on `accel`,
/// decodes a single frame, and confirms the decoder produced a HARDWARE surface
/// rather than silently falling back to software (`get_format` returns the SW
/// format when the GPU can't handle the codec/profile on this machine). A
/// throwaway stream — opened, decoded to the first frame, dropped. `Ok(())` means
/// the lane decodes this class here; `Err(reason)` means unavailable, and the
/// resolver caches the negative and falls back to the software lane. Never call
/// with `DecodeAccel::Software`.
pub fn probe_hw_first_frame(path: &str, accel: DecodeAccel) -> Result<(), String> {
    let want = accel
        .hw_pix_fmt()
        .ok_or_else(|| "software is not a hardware lane".to_string())?;
    let mut stream =
        SwVideoStream::open_with_accel(path, SwOutFormat::Nv12, accel, OutScale::FULL)?;
    match stream.decode_one_raw_format()? {
        Some(fmt) if fmt == want => Ok(()),
        Some(fmt) => Err(format!(
            "decoder produced {fmt:?}, not the hw surface (hardware decode unavailable)"
        )),
        None => Err("no frame decoded".to_string()),
    }
}

/// Point `scratch` at a buffer matching `(fmt, w, h)`, reallocating only when it
/// does not already — the swscale destination is otherwise reused frame after
/// frame. `sws.run` allocates any empty destination handed to it, so a fresh
/// output per frame costs a 12.44 MB allocation plus first-touch page faults at
/// 4K on EVERY decoded frame (measured −1.5 ms/frame for 8-bit `yuv420p`,
/// −3.6 ms for `yuv422p10le`).
///
/// LANDMINE: `sws.run` rejects the destination with `Error::OutputChanged` unless
/// it matches the context's output triple exactly, so this must be called with
/// the same `(fmt, w, h)` the context was built for.
fn ensure_scratch(scratch: &mut VideoFrame, fmt: Pixel, w: u32, h: u32) {
    if scratch.format() != fmt || scratch.width() != w || scratch.height() != h {
        *scratch = VideoFrame::new(fmt, w, h);
    }
}

/// Convert a decoded `VideoFrame` of `(src_w, src_h)` to tightly-packed NV12
/// bytes at `(dst_w, dst_h)`. If it is already NV12 AND no resize is asked for
/// (e.g. a codec that decodes to NV12 directly, at full playback resolution) pack
/// it as-is; otherwise swscale it through the caller's reused `scratch` frame
/// first. Mirrors `preview_gpu::frame_to_nv12` minus the D3D11 hw-transfer branch
/// (a SW frame is already in system memory).
///
/// The returned `Vec` is a fresh per-frame allocation by design — it is handed to
/// JS and outlives the stream, so only the swscale destination is pooled.
fn frame_to_nv12(
    frame: &VideoFrame,
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    scratch: &mut VideoFrame,
) -> Result<Vec<u8>, ffmpeg_next::Error> {
    let resize = (dst_w, dst_h) != (src_w, src_h);
    if frame.format() == Pixel::NV12 && !resize {
        Ok(extract_nv12_planes(frame))
    } else {
        // AREA is both the faster and the quality-correct kernel for reduction
        // (measured at 4K yuv420p: ½ 2.66 vs 2.98 ms, ¼ 1.41 vs 2.40 ms against
        // BILINEAR); same-size conversion keeps BILINEAR, which is what full
        // resolution has always used.
        let flags = if resize { Flags::AREA } else { Flags::BILINEAR };
        let mut sws = SwsContext::get(
            frame.format(),
            src_w,
            src_h,
            Pixel::NV12,
            dst_w,
            dst_h,
            flags,
        )?;
        ensure_scratch(scratch, Pixel::NV12, dst_w, dst_h);
        sws.run(frame, scratch)?;
        Ok(extract_nv12_planes(scratch))
    }
}

/// Pack an NV12 `VideoFrame` into a contiguous `Y then UV` buffer, dropping any
/// row padding (stride > width).
fn extract_nv12_planes(frame: &VideoFrame) -> Vec<u8> {
    let w = frame.width() as usize;
    let h = frame.height() as usize;
    let mut data = Vec::with_capacity(w * h + w * h / 2);

    let y = frame.data(0);
    let y_stride = frame.stride(0);
    for row in 0..h {
        let start = row * y_stride;
        data.extend_from_slice(&y[start..start + w]);
    }

    let uv = frame.data(1);
    let uv_stride = frame.stride(1);
    for row in 0..h / 2 {
        let start = row * uv_stride;
        data.extend_from_slice(&uv[start..start + w]);
    }

    data
}

/// Convert a decoded `VideoFrame` to tightly-packed I420P10 (u16LE yuv420p10le)
/// bytes. One swscale pass straight from the decoder's native pix_fmt — NEVER
/// through an 8-bit intermediate, which would quantize the samples this lane
/// exists to preserve. 4:2:2 sources lose half their chroma rows to 4:2:0 here
/// by design — a documented v2 limitation (export-decode engine spec,
/// decision 4).
fn frame_to_i420p10(
    frame: &VideoFrame,
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
    scratch: &mut VideoFrame,
) -> Result<Vec<u8>, ffmpeg_next::Error> {
    let resize = (dst_w, dst_h) != (src_w, src_h);
    if frame.format() == Pixel::YUV420P10LE && !resize {
        Ok(extract_i420p10_planes(frame))
    } else {
        let flags = if resize { Flags::AREA } else { Flags::BILINEAR };
        let mut sws = SwsContext::get(
            frame.format(),
            src_w,
            src_h,
            Pixel::YUV420P10LE,
            dst_w,
            dst_h,
            flags,
        )?;
        ensure_scratch(scratch, Pixel::YUV420P10LE, dst_w, dst_h);
        sws.run(frame, scratch)?;
        Ok(extract_i420p10_planes(scratch))
    }
}

/// Pack a yuv420p10le `VideoFrame` into a contiguous `Y then U then V` u16LE
/// buffer, dropping any row padding (linesize > packed stride). Chroma dims
/// round down (`>> 1`), matching the renderer's `copyToTenBit`.
fn extract_i420p10_planes(frame: &VideoFrame) -> Vec<u8> {
    let w = frame.width() as usize;
    let h = frame.height() as usize;
    let (cw, ch) = (w >> 1, h >> 1);
    let mut data = Vec::with_capacity((w * h + 2 * cw * ch) * 2);

    let y = frame.data(0);
    let y_stride = frame.stride(0);
    for row in 0..h {
        let start = row * y_stride;
        data.extend_from_slice(&y[start..start + w * 2]);
    }

    for plane in 1..=2usize {
        let p = frame.data(plane);
        let stride = frame.stride(plane);
        for row in 0..ch {
            let start = row * stride;
            data.extend_from_slice(&p[start..start + cw * 2]);
        }
    }

    data
}

/// Perf bench for the ship-stage pack/scale cost — NOT a correctness gate, so
/// every fn here is `#[ignore]`d and runs only on demand:
///
/// ```text
/// cargo test --manifest-path native/decode/Cargo.toml --features test-noop \
///   scale_bench -- --ignored --nocapture
/// ```
///
/// It answers the question the playback-resolution ticket gates on: what does it
/// cost to swscale a 4K frame DOWN on the decode thread, versus shipping it full
/// size over IPC (~12.44 MB, ~12 ms at the measured ~1 GB/s ceiling)?
///
/// Synthetic frames, deliberately: swscale's cost is per-pixel and
/// content-independent, so a real decode would only add noise and a fixture
/// dependency. What matters is (src pix_fmt × src size × dst size × flags).
#[cfg(test)]
mod scale_bench {
    use super::{extract_nv12_planes, Flags, OutScale, Pixel, SwsContext, VideoFrame};
    use std::hint::black_box;
    use std::time::{Duration, Instant};

    const W: u32 = 3840;
    const H: u32 = 2160;
    const WARMUP: usize = 3;
    const ITERS: usize = 20;

    /// A frame of `fmt` at WxH filled with a deterministic ramp (a constant fill
    /// would let a memory subsystem cheat; the ramp keeps every byte distinct).
    fn synth(fmt: Pixel, w: u32, h: u32) -> VideoFrame {
        let mut f = VideoFrame::new(fmt, w, h);
        for p in 0..f.planes() {
            let plane = f.data_mut(p);
            for (i, b) in plane.iter_mut().enumerate() {
                *b = (i % 251) as u8;
            }
        }
        f
    }

    /// Median of `ITERS` timed runs after `WARMUP` untimed ones. Median, not mean:
    /// one OS scheduling hiccup should not move the number we make a decision on.
    fn median_ms(mut run: impl FnMut()) -> f64 {
        for _ in 0..WARMUP {
            run();
        }
        let mut samples: Vec<Duration> = Vec::with_capacity(ITERS);
        for _ in 0..ITERS {
            let t = Instant::now();
            run();
            samples.push(t.elapsed());
        }
        samples.sort();
        samples[ITERS / 2].as_secs_f64() * 1000.0
    }

    /// The production output-size policy, so the bench measures the dims the
    /// ship stage actually produces.
    fn scaled_dims(w: u32, h: u32, div: u32) -> (u32, u32) {
        OutScale::from_divisor(div).dims_for(w, h)
    }

    #[test]
    #[ignore]
    fn bench_pack_and_scale_cost() {
        println!(
            "\n=== ship-stage pack/scale bench — {W}x{H}, {} logical cores, median of {ITERS} ===",
            std::thread::available_parallelism().map_or(0, |n| n.get())
        );

        // Yardstick: one full-size NV12 memcpy on this machine. The IPC crossing
        // costs at least this much, and measured ~1 GB/s says it costs far more.
        let bytes = (W * H + W * H / 2) as usize;
        let src_buf = vec![7u8; bytes];
        let memcpy_ms = median_ms(|| {
            black_box(src_buf.clone());
        });
        println!(
            "\n  yardstick: {:.2} MB memcpy            {memcpy_ms:>7.2} ms   (IPC ships this, then Nv12Ingest uploads it again)",
            bytes as f64 / 1e6
        );

        for (label, fmt) in [
            ("yuv420p     (H.264/MPEG-2/VC-1/DNxHD)", Pixel::YUV420P),
            ("yuv422p10le (ProRes 422)             ", Pixel::YUV422P10LE),
            ("nv12        (Linux NVDEC/VAAPI copy-back)", Pixel::NV12),
        ] {
            println!("\n  src {label}");
            let src = synth(fmt, W, H);

            // The NV12 fast path today's code takes when the decoder already
            // emits NV12 (`frame_to_nv12`'s early return) — no swscale at all.
            if fmt == Pixel::NV12 {
                let ms = median_ms(|| {
                    black_box(extract_nv12_planes(&src));
                });
                println!("    div 1  pack only, no sws (TODAY)      {ms:>7.2} ms");
            }

            for div in [1u32, 2, 4] {
                let (dw, dh) = scaled_dims(W, H, div);
                let out_mb = (dw * dh + dw * dh / 2) as f64 / 1e6;

                // TODAY'S SHAPE: a fresh sws context per frame (`Context::get` is
                // `sws_getContext`, not the cached variant) + scale + pack.
                let ms_fresh = median_ms(|| {
                    let mut sws =
                        SwsContext::get(fmt, W, H, Pixel::NV12, dw, dh, Flags::BILINEAR).unwrap();
                    let mut out = VideoFrame::empty();
                    sws.run(&src, &mut out).unwrap();
                    black_box(extract_nv12_planes(&out));
                });

                // Attribution: cached context but a FRESH output frame, so the
                // fresh-vs-cached delta can be split between `sws_getContext`
                // and the per-frame output allocation.
                let mut sws_o =
                    SwsContext::get(fmt, W, H, Pixel::NV12, dw, dh, Flags::BILINEAR).unwrap();
                let ms_ctxonly = median_ms(|| {
                    let mut out = VideoFrame::empty();
                    sws_o.run(&src, &mut out).unwrap();
                    black_box(extract_nv12_planes(&out));
                });

                // SHIPPABLE SHAPE: context built once, output frame reused.
                let mut sws_c =
                    SwsContext::get(fmt, W, H, Pixel::NV12, dw, dh, Flags::BILINEAR).unwrap();
                let mut out_c = VideoFrame::new(Pixel::NV12, dw, dh);
                let ms_cached = median_ms(|| {
                    sws_c.run(&src, &mut out_c).unwrap();
                    black_box(extract_nv12_planes(&out_c));
                });

                println!(
                    "    div {div}  -> {dw}x{dh} ({out_mb:.2} MB)   fresh-ctx {ms_fresh:>7.2} ms   +cached-ctx {ms_ctxonly:>7.2} ms   +reused-out {ms_cached:>7.2} ms"
                );

                // AREA is the quality-correct downscale kernel; is it affordable?
                if div > 1 {
                    let mut sws_a =
                        SwsContext::get(fmt, W, H, Pixel::NV12, dw, dh, Flags::AREA).unwrap();
                    let mut out_a = VideoFrame::new(Pixel::NV12, dw, dh);
                    let ms_area = median_ms(|| {
                        sws_a.run(&src, &mut out_a).unwrap();
                        black_box(extract_nv12_planes(&out_a));
                    });
                    println!("           (AREA kernel instead of BILINEAR)  cached-ctx {ms_area:>7.2} ms");
                }
            }
        }
        println!();
    }
}

#[cfg(test)]
mod tests {
    use super::{OutScale, OutputCadence, SwOutFormat, SwVideoStream};

    #[test]
    fn output_cadence_clamps_ships_first_and_every_other_frame_then_resets() {
        assert_eq!(OutputCadence::from_divisor(0), OutputCadence::FULL);
        assert_eq!(
            OutputCadence::from_divisor(99).divisor(),
            4,
            "wire values above the supported bound must clamp"
        );

        let mut cadence = OutputCadence::from_divisor(2);
        assert_eq!(
            [
                cadence.should_ship(),
                cadence.should_ship(),
                cadence.should_ship(),
                cadence.should_ship(),
                cadence.should_ship(),
            ],
            [true, false, true, false, true]
        );
        cadence.reset();
        assert!(
            cadence.should_ship(),
            "the first decoded frame after seek must ship"
        );
        assert!(!cadence.should_ship());
    }

    #[test]
    fn out_scale_divisor_one_is_the_identity() {
        assert_eq!(OutScale::default(), OutScale::FULL);
        assert_eq!(OutScale::FULL.divisor(), 1);
        assert_eq!(OutScale::FULL.dims_for(3840, 2160), (3840, 2160));
        // An ODD source ships odd at full res: even-rounding here would change
        // the bytes full resolution has always produced.
        assert_eq!(OutScale::FULL.dims_for(1921, 1081), (1921, 1081));
        // A garbage divisor clamps into range rather than dividing by zero.
        assert_eq!(OutScale::from_divisor(0), OutScale::FULL);
        assert_eq!(OutScale::from_divisor(99).divisor(), 4);
    }

    #[test]
    fn out_scale_rounds_down_to_even_on_both_axes() {
        assert_eq!(OutScale::from_divisor(2).dims_for(3840, 2160), (1920, 1080));
        assert_eq!(OutScale::from_divisor(4).dims_for(3840, 2160), (960, 540));
        // 1922/2 = 961 and 1082/2 = 541 — both odd, both must round DOWN, or the
        // NV12 packer's `h / 2` chroma walk silently drops a row.
        assert_eq!(OutScale::from_divisor(2).dims_for(1922, 1082), (960, 540));
        for (w, h) in [
            OutScale::from_divisor(2).dims_for(1922, 1082),
            OutScale::from_divisor(4).dims_for(3841, 2161),
            OutScale::from_divisor(2).dims_for(1279, 719),
        ] {
            assert_eq!((w % 2, h % 2), (0, 0), "{w}x{h} is not even on both axes");
        }
    }

    #[test]
    fn out_scale_floors_the_long_edge_by_stepping_the_divisor_down() {
        // 720p at ¼ lands exactly ON the floor — allowed.
        assert_eq!(OutScale::from_divisor(4).dims_for(1280, 720), (320, 180));
        // 640x360 at ¼ would be 160x90; step down to the largest divisor whose
        // long edge still clears 320 (here ½).
        assert_eq!(OutScale::from_divisor(4).dims_for(640, 360), (320, 180));
        // 960x540 at ¼ is 240x134 (short); /3 gives 320x180, which clears.
        assert_eq!(OutScale::from_divisor(4).dims_for(960, 540), (320, 180));
        // A source at/under the floor can only ever ship full size.
        assert_eq!(OutScale::from_divisor(4).dims_for(320, 240), (320, 240));
        assert_eq!(OutScale::from_divisor(2).dims_for(320, 240), (320, 240));
    }

    #[test]
    fn out_scale_handles_non_16_9_sources() {
        // Vertical phone video: the floor reads the LONG edge, so ¼ is fine even
        // though the short edge lands well below it.
        assert_eq!(OutScale::from_divisor(4).dims_for(1080, 1920), (270, 480));
        // 4:3 SD at ½ — 486/2 = 243 rounds down to 242.
        assert_eq!(OutScale::from_divisor(2).dims_for(720, 486), (360, 242));
        // Ultra-wide 2.39:1 at ¼.
        assert_eq!(OutScale::from_divisor(4).dims_for(4096, 1716), (1024, 428));
    }

    #[test]
    fn full_resolution_nv12_keeps_the_no_swscale_fast_path() {
        // The safety property the whole knob rests on: at divisor 1 an
        // already-NV12 frame is packed as-is, swscale never runs, and the reused
        // scratch is never even allocated.
        use ffmpeg_next::format::Pixel;
        use ffmpeg_next::util::frame::video::Video as VideoFrame;
        const W: u32 = 64;
        const H: u32 = 48;
        let mut src = VideoFrame::new(Pixel::NV12, W, H);
        for p in 0..src.planes() {
            for (i, b) in src.data_mut(p).iter_mut().enumerate() {
                *b = (i % 251) as u8;
            }
        }
        let mut scratch = VideoFrame::empty();
        let packed = super::frame_to_nv12(&src, W, H, W, H, &mut scratch).unwrap();
        assert_eq!(packed, super::extract_nv12_planes(&src));
        assert_eq!(
            scratch.width(),
            0,
            "the swscale destination was allocated — the fast path did not fire"
        );
    }

    #[test]
    fn scaled_pack_ships_the_target_dims_worth_of_bytes() {
        // A downscale must be honest end-to-end: the packed length follows the
        // TARGET dims, not the source's (a mismatch is what `nv12FrameFromBytes`
        // rejects in the renderer).
        use ffmpeg_next::format::Pixel;
        use ffmpeg_next::util::frame::video::Video as VideoFrame;
        const W: u32 = 1280;
        const H: u32 = 720;
        let mut src = VideoFrame::new(Pixel::YUV420P, W, H);
        for p in 0..src.planes() {
            for (i, b) in src.data_mut(p).iter_mut().enumerate() {
                *b = (i % 251) as u8;
            }
        }
        let (dw, dh) = OutScale::from_divisor(2).dims_for(W, H);
        assert_eq!((dw, dh), (640, 360));
        let mut scratch = VideoFrame::empty();
        let scaled = super::frame_to_nv12(&src, W, H, dw, dh, &mut scratch).unwrap();
        assert_eq!(scaled.len(), (dw * dh + dw * dh / 2) as usize);
        // …and a quarter of the full-size pack's bytes, which is the whole point.
        let full = super::frame_to_nv12(&src, W, H, W, H, &mut VideoFrame::empty()).unwrap();
        assert_eq!(full.len(), scaled.len() * 4);
    }

    #[test]
    fn open_defaults_to_full_output_size() {
        // Every non-preview caller (`open`, `open_with_format`, the hw probe)
        // takes this default; export depends on it.
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        let s = SwVideoStream::open(p).expect("open");
        assert_eq!((s.out_width, s.out_height), (s.width, s.height));
        assert_eq!((s.out_width, s.out_height), (320, 240));
    }

    #[test]
    fn decodes_first_prores_frame_to_i420p10() {
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        let mut s = SwVideoStream::open_with_format(p, SwOutFormat::I420p10).expect("open");
        let f = s.next_frame().expect("decode").expect("some frame");
        assert_eq!(f.format, SwOutFormat::I420p10);
        // I420P10: u16LE Y (w*h) + U + V at (w/2)*(h/2) → 3 bytes/px, even dims.
        assert_eq!(f.data.len(), 320 * 240 * 3);
    }

    #[test]
    fn decodes_first_prores_frame_to_nv12() {
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        let mut s = SwVideoStream::open(p).expect("open");
        let f = s.next_frame().expect("decode").expect("some frame");
        assert_eq!(f.width, 320);
        assert_eq!(f.height, 240);
        // NV12: Y (w*h) + interleaved UV (w*h/2)
        assert_eq!(f.data.len(), (320 * 240) + (320 * 240 / 2));
    }

    #[test]
    fn probe_identity_reports_prores_codec_and_pix_fmt_then_decodes() {
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        let mut s = SwVideoStream::open(p).expect("open");
        let (codec, pix_fmt, width, height) = s.probe_identity();
        assert!(
            !codec.is_empty() && codec != "unknown",
            "codec name missing: {codec}"
        );
        assert!(
            !pix_fmt.is_empty() && pix_fmt != "unknown",
            "pix_fmt name missing: {pix_fmt}"
        );
        assert_eq!(width, 320);
        assert_eq!(height, 240);
        // The probe reads identity without disturbing the packet pump: a
        // subsequent next_frame() still decodes normally.
        let f = s.next_frame().expect("decode").expect("some frame");
        assert_eq!(f.width, 320);
        assert_eq!(f.height, 240);
    }

    #[test]
    fn reused_scratch_packs_the_same_bytes_as_a_fresh_output_frame() {
        // The hazard of pooling the swscale destination is a previous frame's
        // content bleeding into the next one's packed bytes. Convert two
        // deliberately different sources through ONE scratch and compare against
        // the pre-pooling shape (a fresh `VideoFrame::empty()` per call).
        use ffmpeg_next::format::Pixel;
        use ffmpeg_next::util::frame::video::Video as VideoFrame;
        const W: u32 = 64;
        const H: u32 = 48;
        let synth = |seed: u8| {
            let mut f = VideoFrame::new(Pixel::YUV420P, W, H);
            for p in 0..f.planes() {
                for (i, b) in f.data_mut(p).iter_mut().enumerate() {
                    *b = (i as u8).wrapping_mul(3).wrapping_add(seed);
                }
            }
            f
        };
        let (a, b) = (synth(0), synth(199));

        let mut scratch = VideoFrame::empty();
        let reused_a = super::frame_to_nv12(&a, W, H, W, H, &mut scratch).unwrap();
        let reused_b = super::frame_to_nv12(&b, W, H, W, H, &mut scratch).unwrap();
        let fresh_a = super::frame_to_nv12(&a, W, H, W, H, &mut VideoFrame::empty()).unwrap();
        let fresh_b = super::frame_to_nv12(&b, W, H, W, H, &mut VideoFrame::empty()).unwrap();

        assert_ne!(fresh_a, fresh_b, "sources must differ for this to prove anything");
        assert_eq!(reused_a, fresh_a);
        assert_eq!(reused_b, fresh_b, "second frame through a reused scratch drifted");

        // Same for the 10-bit lane, and through the SAME scratch the 8-bit lane
        // just used — the format change must force a reallocation.
        let ten_a = super::frame_to_i420p10(&a, W, H, W, H, &mut scratch).unwrap();
        let ten_b = super::frame_to_i420p10(&b, W, H, W, H, &mut scratch).unwrap();
        assert_eq!(
            ten_a,
            super::frame_to_i420p10(&a, W, H, W, H, &mut VideoFrame::empty()).unwrap()
        );
        assert_eq!(
            ten_b,
            super::frame_to_i420p10(&b, W, H, W, H, &mut VideoFrame::empty()).unwrap()
        );
    }

    #[test]
    fn decode_thread_count_is_positive_and_capped() {
        let n = super::decode_thread_count();
        assert!((1..=16).contains(&n), "thread count {n} out of [1,16]");
    }

    #[test]
    fn threaded_decode_still_yields_correct_first_frame() {
        // Threading must not change decode output: identical assertions to the
        // single-threaded decode test, plus the effective thread_count is set.
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        let mut s = SwVideoStream::open(p).expect("open");
        assert!(
            s.thread_count >= 1,
            "thread_count not set (got {})",
            s.thread_count
        );
        let f = s.next_frame().expect("decode").expect("some frame");
        assert_eq!(f.width, 320);
        assert_eq!(f.height, 240);
        assert_eq!(f.data.len(), (320 * 240) + (320 * 240 / 2));
    }

    #[test]
    fn thread_type_is_slice_for_intra_frame_slice_for_long_gop() {
        use ffmpeg_next::codec::Id;
        assert_eq!(super::thread_type_for(Id::PRORES), super::FF_THREAD_SLICE);
        assert_eq!(super::thread_type_for(Id::DNXHD), super::FF_THREAD_SLICE);
        for id in [Id::MPEG2VIDEO, Id::VC1, Id::WMV3] {
            assert_eq!(
                super::thread_type_for(id),
                super::FF_THREAD_FRAME | super::FF_THREAD_SLICE
            );
        }
    }

    #[test]
    fn is_hw_pix_format_flags_gpu_surfaces_only() {
        use super::is_hw_pix_format;
        use ffmpeg_next::format::Pixel;
        assert!(is_hw_pix_format(Pixel::CUDA));
        assert!(is_hw_pix_format(Pixel::VAAPI));
        assert!(is_hw_pix_format(Pixel::D3D11));
        // CPU formats must NOT be treated as hw surfaces (they skip the transfer).
        for f in [
            Pixel::NV12,
            Pixel::YUV420P,
            Pixel::YUV422P10LE,
            Pixel::YUV420P10LE,
        ] {
            assert!(!is_hw_pix_format(f), "{f:?} wrongly flagged hw");
        }
    }

    #[test]
    fn probe_rejects_software_accel() {
        // The hw probe is meaningless for the software lane — it must error
        // rather than "succeed" (there is no hw surface to confirm).
        use super::{probe_hw_first_frame, DecodeAccel};
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        assert!(probe_hw_first_frame(p, DecodeAccel::Software).is_err());
    }

    #[test]
    fn probe_rejects_absent_vaapi_device() {
        // A non-existent DRM render node must surface as a graceful Err (device
        // create fails), never a panic/abort — this is the resolver's silent
        // software-fallback path. (Real-hardware NVDEC/VAAPI correctness is
        // verified at the conformance seam, not here — crate tests stay
        // hardware-independent.)
        use super::{probe_hw_first_frame, DecodeAccel};
        let p = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tiny_prores.mov"
        );
        let r = probe_hw_first_frame(
            p,
            DecodeAccel::Vaapi {
                device: "/dev/dri/renderD999".into(),
            },
        );
        assert!(r.is_err(), "absent vaapi node should Err, got {r:?}");
    }
}
