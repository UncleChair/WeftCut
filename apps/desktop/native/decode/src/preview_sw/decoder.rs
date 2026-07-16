//! Pure-software streaming decode → tightly-packed CPU frame bytes (8-bit NV12,
//! or u16LE I420P10 for the export 10-bit lane). A strict simplification of
//! `preview_gpu/decoder.rs`'s `VideoStream`: same open/pump/seek shape, but with
//! the entire D3D11VA hardware path deleted (no `av_hwdevice_ctx_create`, no
//! `get_format` override, no COM-pointer plumbing). libavcodec decodes to a CPU
//! frame in its native pixel format (e.g. ProRes' `yuv422p10le`) and swscale
//! packs it to the stream's target format in one pass.
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

/// Threading mode per codec family. Frame-threading (FF_THREAD_FRAME) parallelises
/// across frames but adds a multi-frame output delay that re-primes after every
/// seek's avcodec_flush_buffers — measured ~600ms backward-far scrub on 4K ProRes
/// for no throughput gain on intra codecs (decode-bench, Plan A Task 5). So intra
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

/// One software-decoded frame, tightly packed per `format` (layouts on
/// [`SwOutFormat`]) plus its source-normalized timing and color tags. Fully
/// owned (unlike the GPU path's borrowed texture handle), so it can outlive
/// the stream and cross threads freely.
#[derive(Debug)]
pub struct SwFrame {
    pub data: Vec<u8>,
    pub format: SwOutFormat,
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
    /// Target format every decoded frame is packed into, fixed at open.
    out_format: SwOutFormat,
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
    /// Open `path` for pure-software decode into NV12 (all preview callers).
    pub fn open(path: &str) -> Result<SwVideoStream, String> {
        Self::open_with_format(path, SwOutFormat::Nv12)
    }

    /// Open `path` for pure-software decode and prepare for streaming, packing
    /// every decoded frame into `out_format`. No hardware device is attached —
    /// libavcodec always decodes to CPU frames.
    pub fn open_with_format(path: &str, out_format: SwOutFormat) -> Result<SwVideoStream, String> {
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
        // thread_type is per-codec-family (see `thread_type_for`): slice-only for
        // intra ProRes/DNxHD (no output-latency, keeps scrub snappy), FRAME|SLICE
        // for long-GOP MPEG-2/VC-1/WMV3 throughput. Threaded decode is byte-identical
        // to single-thread; only speed changes.
        let requested_threads = decode_thread_count();
        let thread_type = thread_type_for(stream.parameters().id());
        unsafe {
            let raw = codec_ctx.as_mut_ptr();
            (*raw).thread_count = requested_threads;
            (*raw).thread_type = thread_type;
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
            out_format,
        })
    }

    /// Read codec/pix_fmt identity off the already-open decoder context, without
    /// touching the packet/frame pump. `codec` is libavcodec's canonical short
    /// name (`AVCodec.name` via `self.decoder.codec()`, e.g. `"prores"`);
    /// `pix_fmt` is libavutil's canonical descriptor name (`av_pix_fmt_desc_get`
    /// via `Pixel::descriptor()`, e.g. `"yuv422p10le"`) — both match the strings
    /// ffprobe reports, so a probe-informed class key (Task 13) needs no
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
                    let (num, den) = (self.time_base.0 as i128, self.time_base.1 as i128);
                    let dur_us = (dur as i128 * num * 1_000_000 / den) as i64;
                    (
                        pts_to_source_us(pts, self.time_base, self.start_pts_us),
                        dur_us,
                    )
                };
                let data = match self.out_format {
                    SwOutFormat::Nv12 => frame_to_nv12(&self.frame, self.width, self.height),
                    SwOutFormat::I420p10 => {
                        frame_to_i420p10(&self.frame, self.width, self.height)
                    }
                }
                .map_err(map)?;
                return Ok(Some(SwFrame {
                    data,
                    format: self.out_format,
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

/// Convert a decoded `VideoFrame` to tightly-packed I420P10 (u16LE yuv420p10le)
/// bytes. One swscale pass straight from the decoder's native pix_fmt — NEVER
/// through an 8-bit intermediate, which would quantize the samples this lane
/// exists to preserve. 4:2:2 sources lose half their chroma rows to 4:2:0 here
/// by design — a documented v2 limitation (export-decode engine spec,
/// decision 4).
fn frame_to_i420p10(
    frame: &VideoFrame,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, ffmpeg_next::Error> {
    if frame.format() == Pixel::YUV420P10LE {
        Ok(extract_i420p10_planes(frame))
    } else {
        let mut sws = SwsContext::get(
            frame.format(),
            width,
            height,
            Pixel::YUV420P10LE,
            width,
            height,
            Flags::BILINEAR,
        )?;
        let mut out = VideoFrame::empty();
        sws.run(frame, &mut out)?;
        Ok(extract_i420p10_planes(&out))
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

#[cfg(test)]
mod tests {
    use super::{SwOutFormat, SwVideoStream};

    #[test]
    fn decodes_first_prores_frame_to_i420p10() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_prores.mov");
        let mut s = SwVideoStream::open_with_format(p, SwOutFormat::I420p10).expect("open");
        let f = s.next_frame().expect("decode").expect("some frame");
        assert_eq!(f.format, SwOutFormat::I420p10);
        // I420P10: u16LE Y (w*h) + U + V at (w/2)*(h/2) → 3 bytes/px, even dims.
        assert_eq!(f.data.len(), 320 * 240 * 3);
    }

    #[test]
    fn decodes_first_prores_frame_to_nv12() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_prores.mov");
        let mut s = SwVideoStream::open(p).expect("open");
        let f = s.next_frame().expect("decode").expect("some frame");
        assert_eq!(f.width, 320);
        assert_eq!(f.height, 240);
        // NV12: Y (w*h) + interleaved UV (w*h/2)
        assert_eq!(f.data.len(), (320 * 240) + (320 * 240 / 2));
    }

    #[test]
    fn probe_identity_reports_prores_codec_and_pix_fmt_then_decodes() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/tiny_prores.mov");
        let mut s = SwVideoStream::open(p).expect("open");
        let (codec, pix_fmt, width, height) = s.probe_identity();
        assert!(!codec.is_empty() && codec != "unknown", "codec name missing: {codec}");
        assert!(!pix_fmt.is_empty() && pix_fmt != "unknown", "pix_fmt name missing: {pix_fmt}");
        assert_eq!(width, 320);
        assert_eq!(height, 240);
        // The probe reads identity without disturbing the packet pump: a
        // subsequent next_frame() still decodes normally.
        let f = s.next_frame().expect("decode").expect("some frame");
        assert_eq!(f.width, 320);
        assert_eq!(f.height, 240);
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
        assert_eq!(f.data.len(), (320 * 240) + (320 * 240 / 2));
    }

    #[test]
    fn thread_type_is_slice_for_intra_frame_slice_for_long_gop() {
        use ffmpeg_next::codec::Id;
        assert_eq!(super::thread_type_for(Id::PRORES), super::FF_THREAD_SLICE);
        assert_eq!(super::thread_type_for(Id::DNXHD), super::FF_THREAD_SLICE);
        for id in [Id::MPEG2VIDEO, Id::VC1, Id::WMV3] {
            assert_eq!(super::thread_type_for(id), super::FF_THREAD_FRAME | super::FF_THREAD_SLICE);
        }
    }
}
