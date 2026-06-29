//! One-shot video decode → tightly-packed NV12 bytes, adapted from the
//! `frame-uri-demo` reference. Tries D3D11VA hardware decode (falling back to
//! software), then `av_hwframe_transfer_data`'s the GPU frame to system memory
//! as NV12. Step 1b-i uploads the result into a shared NV12 texture; step 1b-ii
//! will instead copy the GPU texture directly and skip this transfer.

use ffmpeg_next::ffi as ffs;
use ffmpeg_next::format::{input, Pixel};
use ffmpeg_next::media::Type;
use ffmpeg_next::software::scaling::{context::Context as SwsContext, flag::Flags};
use ffmpeg_next::util::frame::video::Video as VideoFrame;
use std::ptr;

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

/// Decode the first video frame of `path` and return `(width, height, nv12)`,
/// where `nv12` is the tightly-packed Y plane (`w*h`) followed by interleaved UV
/// (`w*h/2`).
pub fn decode_first_frame_nv12(path: &str) -> Result<(u32, u32, Vec<u8>), ffmpeg_next::Error> {
    ffmpeg_next::init().ok();

    let mut ictx = input(&path)?;
    let stream = ictx
        .streams()
        .best(Type::Video)
        .ok_or(ffmpeg_next::Error::StreamNotFound)?;
    let stream_index = stream.index();

    let mut codec_ctx = ffmpeg_next::codec::context::Context::from_parameters(stream.parameters())?;

    // Attach a D3D11VA device; on any failure, fall through to software decode.
    let mut hw_ctx: *mut ffs::AVBufferRef = ptr::null_mut();
    unsafe {
        let ret = ffs::av_hwdevice_ctx_create(
            &mut hw_ctx,
            ffs::AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA,
            ptr::null(),
            ptr::null_mut(),
            0,
        );
        if ret >= 0 && !hw_ctx.is_null() {
            let raw = codec_ctx.as_mut_ptr();
            (*raw).hw_device_ctx = ffs::av_buffer_ref(hw_ctx);
            (*raw).get_format = Some(get_format_d3d11);
            eprintln!("[poc-native] d3d11va hwaccel enabled");
        } else {
            eprintln!("[poc-native] d3d11va init failed (ret={ret}); software decode");
        }
    }

    let mut decoder = codec_ctx.decoder().video()?;
    let width = decoder.width();
    let height = decoder.height();

    // Pump packets until the first frame pops out.
    let mut decoded = VideoFrame::empty();
    let nv12 = loop {
        if decoder.receive_frame(&mut decoded).is_ok() {
            break frame_to_nv12(&decoded, width, height)?;
        }
        match ictx.packets().next() {
            Some((stream, packet)) => {
                if stream.index() == stream_index {
                    decoder.send_packet(&packet)?;
                }
            }
            None => {
                decoder.send_eof()?;
                if decoder.receive_frame(&mut decoded).is_ok() {
                    break frame_to_nv12(&decoded, width, height)?;
                }
                unsafe {
                    if !hw_ctx.is_null() {
                        ffs::av_buffer_unref(&mut hw_ctx);
                    }
                }
                return Err(ffmpeg_next::Error::Eof);
            }
        }
    };

    unsafe {
        if !hw_ctx.is_null() {
            ffs::av_buffer_unref(&mut hw_ctx);
        }
    }
    Ok((width, height, nv12))
}

fn frame_to_nv12(
    frame: &VideoFrame,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, ffmpeg_next::Error> {
    // GPU frame → system memory (av_hwframe_transfer_data yields NV12 for D3D11VA).
    let mut sw_scratch = VideoFrame::empty();
    let sw: &VideoFrame = if frame.format() == Pixel::D3D11 {
        unsafe {
            let ret = ffs::av_hwframe_transfer_data(sw_scratch.as_mut_ptr(), frame.as_ptr(), 0);
            if ret < 0 {
                return Err(ffmpeg_next::Error::from(ret));
            }
        }
        &sw_scratch
    } else {
        frame
    };

    eprintln!("[poc-native] decoded frame format={:?} -> nv12", sw.format());

    if sw.format() == Pixel::NV12 {
        Ok(extract_nv12_planes(sw))
    } else {
        let mut sws = SwsContext::get(
            sw.format(),
            width,
            height,
            Pixel::NV12,
            width,
            height,
            Flags::BILINEAR,
        )?;
        let mut nv = VideoFrame::empty();
        sws.run(sw, &mut nv)?;
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
