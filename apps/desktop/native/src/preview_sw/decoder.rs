//! Pure-software streaming decode → tightly-packed 8-bit NV12 bytes. A strict
//! simplification of `preview_gpu/decoder.rs`'s `VideoStream`: same open/pump/
//! seek shape, but with the entire D3D11VA hardware path deleted (no
//! `av_hwdevice_ctx_create`, no `get_format` override, no COM-pointer plumbing).
//! libavcodec decodes to a CPU frame in its native pixel format (e.g. ProRes'
//! `yuv422p10le`) and swscale packs it to NV12 for the shared renderer path.
//!
//! Task 3's `session` consumes `seek`, the color tags, and the per-frame
//! timestamps; they are defined here (ahead of that consumer) so the streaming
//! surface is complete in one place.
#![allow(dead_code)]

use ffmpeg_next::ffi as ffs;
use ffmpeg_next::format::{input, Pixel};
use ffmpeg_next::media::Type;
use ffmpeg_next::software::scaling::{context::Context as SwsContext, flag::Flags};
use ffmpeg_next::util::frame::video::Video as VideoFrame;

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

/// One software-decoded frame, packed as tightly-packed NV12 (`Y` plane `w*h`
/// followed by interleaved `UV` `w*h/2`) plus its source-normalized timing and
/// color tags. Fully owned (unlike the GPU path's borrowed texture handle), so
/// it can outlive the stream and cross threads freely.
#[derive(Debug)]
pub struct SwFrame {
    pub nv12: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Presentation time, source-normalized microseconds (`pts_to_source_us`).
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
    /// Set once `send_eof` has been issued, so we only drain afterwards.
    eof_sent: bool,
    pub width: u32,
    pub height: u32,
    /// Video stream's `(numerator, denominator)`, captured at `open`. Needed by
    /// `pts_to_source_us` and by `seek`'s target-us -> stream-timestamp math.
    pub time_base: (i32, i32),
    /// Container's first-packet PTS (source-normalized microseconds), so
    /// `pts_to_source_us` reports source t=0 at the visible start rather than at
    /// the container's internal PTS origin.
    pub start_pts_us: i64,
    /// Stream color metadata, read once at `open` (stable for the whole stream).
    pub color: SwColorTags,
    /// Threads libavcodec settled on after open (1 if the codec can't thread).
    pub thread_count: i32,
}

// The ffmpeg-next `Input`/`Video` wrappers hold raw pointers and are `!Send`.
// Mirror `preview_gpu::VideoStream`: the stream is only ever driven from a single
// owner (the Node main thread now, a session thread in Task 3) and its pointers
// never cross threads, so it is sound to mark `Send`.
unsafe impl Send for SwVideoStream {}

/// PTS (in stream time_base units) -> source-normalized microseconds. Mirrors
/// the renderer's `frameToSourceUs`: convert to us via time_base, then subtract
/// the container's first-packet PTS so source t=0 is the visible start.
pub fn pts_to_source_us(pts: i64, time_base: (i32, i32), start_pts_us: i64) -> i64 {
    let (num, den) = (time_base.0 as i128, time_base.1 as i128);
    let us = (pts as i128 * num * 1_000_000 / den) as i64;
    us - start_pts_us
}

impl SwVideoStream {
    /// Open `path` for pure-software decode and prepare for streaming. No
    /// hardware device is attached — libavcodec always decodes to CPU frames.
    pub fn open(path: &str) -> Result<SwVideoStream, String> {
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
        // `pts_to_source_us` reports t=0 at the visible start. Fall back to 0.
        let start_time_raw = stream.start_time();
        let start_pts_us = if start_time_raw != ffs::AV_NOPTS_VALUE {
            let (num, den) = (time_base.0 as i128, time_base.1 as i128);
            (start_time_raw as i128 * num * 1_000_000 / den) as i64
        } else {
            0
        };

        let mut codec_ctx =
            ffmpeg_next::codec::context::Context::from_parameters(stream.parameters())
                .map_err(map)?;
        // Parallel decode: set on the raw context BEFORE avcodec_open2 reads it.
        // FRAME|SLICE lets libavcodec pick whichever the codec supports — slice
        // for intra ProRes/DNxHD (no output-latency, keeps scrub snappy), frame
        // for long-GOP MPEG-2/VC-1 throughput. Threaded decode is byte-identical
        // to single-thread; only speed changes. (Threading strategy: FRAME|SLICE
        // + a decode-bench seek-latency guard — Plan A design.)
        let requested_threads = decode_thread_count();
        unsafe {
            let raw = codec_ctx.as_mut_ptr();
            (*raw).thread_count = requested_threads;
            (*raw).thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
        }
        let mut decoder = codec_ctx.decoder().video().map_err(map)?;
        // Count libavcodec actually settled on (clamped to 1 for a codec without
        // threading support). Read via the raw context (as_mut_ptr is already used
        // by `seek`).
        let thread_count = unsafe { (*decoder.as_mut_ptr()).thread_count };
        let width = decoder.width();
        let height = decoder.height();

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
            eof_sent: false,
            width,
            height,
            time_base,
            start_pts_us,
            color,
            thread_count,
        })
    }

    /// Decode the next frame, packed as owned NV12 bytes. Returns `Ok(None)` at
    /// end of stream.
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
                    let (num, den) = (self.time_base.0 as i128, self.time_base.1 as i128);
                    let dur_us = (dur as i128 * num * 1_000_000 / den) as i64;
                    (
                        pts_to_source_us(pts, self.time_base, self.start_pts_us),
                        dur_us,
                    )
                };
                let nv12 = frame_to_nv12(&self.frame, self.width, self.height).map_err(map)?;
                return Ok(Some(SwFrame {
                    nv12,
                    width: self.width,
                    height: self.height,
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
        let (num, den) = (self.time_base.0 as i128, self.time_base.1 as i128);
        let ts = ((target_us as i128 + self.start_pts_us as i128) * den / (num * 1_000_000)) as i64;
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

/// Convert a decoded `VideoFrame` to tightly-packed NV12 bytes. If it is already
/// NV12 (e.g. from a codec that decodes to it directly) pack it as-is; otherwise
/// swscale it to NV12 first. Mirrors `preview_gpu::frame_to_nv12` minus the
/// D3D11 hw-transfer branch (a SW frame is already in system memory).
fn frame_to_nv12(
    frame: &VideoFrame,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, ffmpeg_next::Error> {
    if frame.format() == Pixel::NV12 {
        Ok(extract_nv12_planes(frame))
    } else {
        let mut sws = SwsContext::get(
            frame.format(),
            width,
            height,
            Pixel::NV12,
            width,
            height,
            Flags::BILINEAR,
        )?;
        let mut nv = VideoFrame::empty();
        sws.run(frame, &mut nv)?;
        Ok(extract_nv12_planes(&nv))
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

#[cfg(test)]
mod tests {
    use super::SwVideoStream;
    #[test]
    fn decodes_first_prores_frame_to_nv12() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_prores.mov");
        let mut s = SwVideoStream::open(p).expect("open");
        let f = s.next_frame().expect("decode").expect("some frame");
        assert_eq!(f.width, 320);
        assert_eq!(f.height, 240);
        // NV12: Y (w*h) + interleaved UV (w*h/2)
        assert_eq!(f.nv12.len(), (320 * 240) + (320 * 240 / 2));
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
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_prores.mov");
        let mut s = SwVideoStream::open(p).expect("open");
        assert!(s.thread_count >= 1, "thread_count not set (got {})", s.thread_count);
        let f = s.next_frame().expect("decode").expect("some frame");
        assert_eq!(f.width, 320);
        assert_eq!(f.height, 240);
        assert_eq!(f.nv12.len(), (320 * 240) + (320 * 240 / 2));
    }
}
