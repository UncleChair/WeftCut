//! D3D11VA decode primitives: a one-shot HW-decode probe
//! ([`decode_first_d3d11_frame`]) and the streaming [`VideoStream`] session
//! that yields successive GPU surfaces for the zero-copy preview lane.

use ffmpeg_next::ffi as ffs;
use ffmpeg_next::format::{input, Pixel};
use ffmpeg_next::media::Type;
use ffmpeg_next::util::frame::video::Video as VideoFrame;
use std::os::raw::c_void;
use std::ptr;

use crate::media_time::{source_us_to_ticks_floor, ticks_to_source_us, ticks_to_us};

/// Mirror of `libavutil/hwcontext_d3d11va.h`'s `AVD3D11VADeviceContext` (stable
/// public ABI). Only the leading device/device_context + lock fields are read;
/// COM pointers are kept as `*mut c_void`.
#[repr(C)]
struct AVD3D11VADeviceContextLayout {
    device: *mut c_void,
    device_context: *mut c_void,
    video_device: *mut c_void,
    video_context: *mut c_void,
    lock: Option<unsafe extern "C" fn(*mut c_void)>,
    unlock: Option<unsafe extern "C" fn(*mut c_void)>,
    lock_ctx: *mut c_void,
}

/// Prefer `AV_PIX_FMT_D3D11` if the decoder offers it, so H.264 frames stay on
/// the GPU; otherwise take the first (software) format.
unsafe extern "C" fn get_format_d3d11(
    _ctx: *mut ffs::AVCodecContext,
    pix_fmts: *const ffs::AVPixelFormat,
) -> ffs::AVPixelFormat {
    let mut p = pix_fmts;
    while unsafe { *p } != ffs::AVPixelFormat::AV_PIX_FMT_NONE {
        if unsafe { *p } == ffs::AVPixelFormat::AV_PIX_FMT_D3D11 {
            return ffs::AVPixelFormat::AV_PIX_FMT_D3D11;
        }
        p = unsafe { p.add(1) };
    }
    unsafe { *pix_fmts }
}

/// Success token of the one-frame HW probe: a decoded D3D11 surface kept alive
/// together with the ffmpeg objects that own its GPU texture. The probe
/// (`Backend::preview_gpu_probe`) drops it immediately — only construction
/// matters; `Drop` releases the hw device context and with it the texture pool.
pub struct D3d11Frame {
    _ictx: ffmpeg_next::format::context::Input,
    _decoder: ffmpeg_next::decoder::Video,
    _frame: VideoFrame,
    hw_ctx: *mut ffs::AVBufferRef,
}

impl Drop for D3d11Frame {
    fn drop(&mut self) {
        unsafe {
            if !self.hw_ctx.is_null() {
                ffs::av_buffer_unref(&mut self.hw_ctx);
            }
        }
    }
}

/// Decode the first frame as a D3D11 GPU surface (no CPU transfer). Errors if
/// hardware decode is unavailable, since zero-copy requires the GPU texture.
pub fn decode_first_d3d11_frame(path: &str) -> Result<D3d11Frame, String> {
    ffmpeg_next::init().ok();
    let map = |e: ffmpeg_next::Error| e.to_string();

    let mut ictx = input(&path).map_err(map)?;
    let stream = ictx
        .streams()
        .best(Type::Video)
        .ok_or_else(|| "no video stream".to_string())?;
    let stream_index = stream.index();
    let mut codec_ctx =
        ffmpeg_next::codec::context::Context::from_parameters(stream.parameters()).map_err(map)?;

    let mut hw_ctx: *mut ffs::AVBufferRef = ptr::null_mut();
    unsafe {
        let ret = ffs::av_hwdevice_ctx_create(
            &mut hw_ctx,
            ffs::AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA,
            ptr::null(),
            ptr::null_mut(),
            0,
        );
        if ret < 0 || hw_ctx.is_null() {
            return Err(format!(
                "av_hwdevice_ctx_create(d3d11va) failed (ret={ret})"
            ));
        }
        let raw = codec_ctx.as_mut_ptr();
        (*raw).hw_device_ctx = ffs::av_buffer_ref(hw_ctx);
        (*raw).get_format = Some(get_format_d3d11);
    }

    let mut decoder = codec_ctx.decoder().video().map_err(map)?;

    let mut frame = VideoFrame::empty();
    let got = loop {
        if decoder.receive_frame(&mut frame).is_ok() {
            break true;
        }
        match ictx.packets().next() {
            Some((s, p)) => {
                if s.index() == stream_index {
                    decoder.send_packet(&p).map_err(map)?;
                }
            }
            None => {
                decoder.send_eof().map_err(map)?;
                break decoder.receive_frame(&mut frame).is_ok();
            }
        }
    };
    if !got {
        unsafe {
            ffs::av_buffer_unref(&mut hw_ctx);
        }
        return Err("no frame decoded".to_string());
    }
    if frame.format() != Pixel::D3D11 {
        unsafe {
            ffs::av_buffer_unref(&mut hw_ctx);
        }
        return Err(format!(
            "decoder produced {:?}, not D3D11 (hardware decode unavailable)",
            frame.format()
        ));
    }

    Ok(D3d11Frame {
        _ictx: ictx,
        _decoder: decoder,
        _frame: frame,
        hw_ctx,
    })
}

/// An open d3d11va decode session that yields successive GPU frames, for the
/// streaming POC (Result 3). Owns the same ffmpeg objects as `D3d11Frame` but
/// keeps them alive across many `next_frame()` calls instead of one shot.
///
/// Packet pumping relies on ffmpeg-next's `PacketIter` holding no cursor of its
/// own: each `self.ictx.packets().next()` reads the *next* packet because the
/// read position lives inside the `AVFormatContext`. So a fresh iterator per
/// call resumes where the previous one left off.
pub struct VideoStream {
    ictx: ffmpeg_next::format::context::Input,
    decoder: ffmpeg_next::decoder::Video,
    hw_ctx: *mut ffs::AVBufferRef,
    stream_index: usize,
    /// Reused frame buffer; `receive_frame` overwrites it each call.
    frame: VideoFrame,
    /// Set once `send_eof` has been issued, so we only drain afterwards.
    eof_sent: bool,
    pub width: u32,
    pub height: u32,
    pub device: *mut c_void,
    pub device_context: *mut c_void,
    pub lock: Option<unsafe extern "C" fn(*mut c_void)>,
    pub unlock: Option<unsafe extern "C" fn(*mut c_void)>,
    pub lock_ctx: *mut c_void,
    /// Video stream's `(numerator, denominator)`, captured at `open`. Needed by
    /// `ticks_to_source_us` and by `seek`'s target-us -> stream-timestamp math.
    pub time_base: (i32, i32),
    /// Container's first-packet PTS (source-normalized microseconds), so
    /// `ticks_to_source_us` can report source t=0 at the visible start rather
    /// than at the container's internal PTS origin.
    pub start_pts_us: i64,
}

// The COM pointers + ffmpeg objects are `!Send`, but every call runs on the Node
// main thread and the pointers never cross threads (same contract as `Holder`).
unsafe impl Send for VideoStream {}

impl Drop for VideoStream {
    fn drop(&mut self) {
        unsafe {
            if !self.hw_ctx.is_null() {
                ffs::av_buffer_unref(&mut self.hw_ctx);
            }
        }
    }
}

/// A decoded GPU surface borrowed from a live `VideoStream`. Holds the raw source
/// texture + slice index for `CopySubresourceRegion`; valid only until the next
/// `next_frame()` overwrites the stream's frame buffer.
pub struct StreamFrame {
    pub src_texture: *mut c_void,
    pub src_index: u32,
    /// Presentation time, source-normalized microseconds (`ticks_to_source_us`).
    pub pts_us: i64,
    /// Frame duration in microseconds (a delta, not a timestamp — no start
    /// subtraction).
    pub dur_us: i64,
    /// Whether this is a keyframe. The session's pump tracks the interval between
    /// consecutive keyframes to price a resync seek (a seek must re-decode from
    /// the key packet at/before its target, so the keyframe interval IS the seek's
    /// worst-case cost) — see `SessionState::resync_threshold_us`.
    pub key: bool,
}

impl VideoStream {
    /// Open `path` with d3d11va hardware decode and prepare for streaming. Errors
    /// if hardware decode is unavailable (zero-copy needs the GPU texture).
    pub fn open(path: &str) -> Result<VideoStream, String> {
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

        let mut hw_ctx: *mut ffs::AVBufferRef = ptr::null_mut();
        unsafe {
            let ret = ffs::av_hwdevice_ctx_create(
                &mut hw_ctx,
                ffs::AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA,
                ptr::null(),
                ptr::null_mut(),
                0,
            );
            if ret < 0 || hw_ctx.is_null() {
                return Err(format!(
                    "av_hwdevice_ctx_create(d3d11va) failed (ret={ret})"
                ));
            }
            let raw = codec_ctx.as_mut_ptr();
            (*raw).hw_device_ctx = ffs::av_buffer_ref(hw_ctx);
            (*raw).get_format = Some(get_format_d3d11);
        }

        let decoder = codec_ctx.decoder().video().map_err(map)?;
        let width = decoder.width();
        let height = decoder.height();

        // Pull the D3D11 device + context out of ffmpeg's hw device context.
        // ffmpeg-sys-next doesn't bind AVD3D11VADeviceContext (its wrapper omits
        // the D3D11 hw-context header), so mirror its stable public layout.
        let (device, device_context, lock, unlock, lock_ctx) = unsafe {
            let hwdev = (*hw_ctx).data as *mut ffs::AVHWDeviceContext;
            let d = (*hwdev).hwctx as *mut AVD3D11VADeviceContextLayout;
            (
                (*d).device,
                (*d).device_context,
                (*d).lock,
                (*d).unlock,
                (*d).lock_ctx,
            )
        };

        Ok(VideoStream {
            ictx,
            decoder,
            hw_ctx,
            stream_index,
            frame: VideoFrame::empty(),
            eof_sent: false,
            width,
            height,
            device,
            device_context,
            lock,
            unlock,
            lock_ctx,
            time_base,
            start_pts_us,
        })
    }

    /// Decode the next GPU frame. Returns `Ok(None)` at end of stream. The
    /// returned `StreamFrame` borrows the stream's internal frame buffer, so it
    /// must be consumed (copied out) before the next `next_frame()` call.
    pub fn next_frame(&mut self) -> Result<Option<StreamFrame>, String> {
        let map = |e: ffmpeg_next::Error| e.to_string();
        loop {
            // Drain any already-decoded frame first.
            if self.decoder.receive_frame(&mut self.frame).is_ok() {
                if self.frame.format() != Pixel::D3D11 {
                    return Err(format!(
                        "decoder produced {:?}, not D3D11 (hardware decode unavailable)",
                        self.frame.format()
                    ));
                }
                let (src_texture, src_index, pts_us, dur_us) = unsafe {
                    let p = self.frame.as_ptr();
                    let pts = if (*p).pts != ffs::AV_NOPTS_VALUE {
                        (*p).pts
                    } else {
                        (*p).best_effort_timestamp
                    };
                    let dur = (*p).duration;
                    let dur_us = ticks_to_us(dur, self.time_base);
                    (
                        (*p).data[0] as *mut c_void,
                        (*p).data[1] as usize as u32,
                        ticks_to_source_us(pts, self.time_base, self.start_pts_us),
                        dur_us,
                    )
                };
                return Ok(Some(StreamFrame {
                    src_texture,
                    src_index,
                    pts_us,
                    dur_us,
                    key: self.frame.is_key(),
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

    /// Seek to the keyframe at or before target_us, flush the decoder, and
    /// arm forward decode. AVSEEK_FLAG_BACKWARD lands on a key packet <= target.
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
        Ok(())
    }
}
