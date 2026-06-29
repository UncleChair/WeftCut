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
use std::os::raw::c_void;
use std::ptr;

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

/// A decoded D3D11 frame kept alive together with the ffmpeg objects that own its
/// GPU texture, plus the raw pointers needed to copy it (step 1b-ii). The frame's
/// texture belongs to the decoder's hw-frames pool, so the decoder and the hw
/// device context must outlive any use of `src_texture()`.
pub struct D3d11Frame {
    _ictx: ffmpeg_next::format::context::Input,
    _decoder: ffmpeg_next::decoder::Video,
    frame: VideoFrame,
    hw_ctx: *mut ffs::AVBufferRef,
    pub width: u32,
    pub height: u32,
    /// `ID3D11Device*` owned by ffmpeg's hw device context.
    pub device: *mut std::os::raw::c_void,
    /// `ID3D11DeviceContext*` owned by ffmpeg.
    pub device_context: *mut std::os::raw::c_void,
    /// ffmpeg's lock/unlock around device-context use (multithread safety).
    pub lock: Option<unsafe extern "C" fn(*mut std::os::raw::c_void)>,
    pub unlock: Option<unsafe extern "C" fn(*mut std::os::raw::c_void)>,
    pub lock_ctx: *mut std::os::raw::c_void,
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

impl D3d11Frame {
    /// `ID3D11Texture2D*` for the decoded surface (an entry in the decoder's
    /// texture array).
    pub fn src_texture(&self) -> *mut std::os::raw::c_void {
        unsafe { (*self.frame.as_ptr()).data[0] as *mut std::os::raw::c_void }
    }
    /// Subresource index of this frame within the texture array.
    pub fn src_index(&self) -> u32 {
        unsafe { (*self.frame.as_ptr()).data[1] as usize as u32 }
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
            return Err(format!("av_hwdevice_ctx_create(d3d11va) failed (ret={ret})"));
        }
        let raw = codec_ctx.as_mut_ptr();
        (*raw).hw_device_ctx = ffs::av_buffer_ref(hw_ctx);
        (*raw).get_format = Some(get_format_d3d11);
    }

    let mut decoder = codec_ctx.decoder().video().map_err(map)?;
    let width = decoder.width();
    let height = decoder.height();

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

    // Pull the D3D11 device + context out of ffmpeg's hw device context.
    // ffmpeg-sys-next doesn't bind AVD3D11VADeviceContext (its wrapper omits the
    // D3D11 hw-context header), so mirror its stable public layout. Pointers are
    // kept as void* — we only need device/device_context, not the COM types.
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

    Ok(D3d11Frame {
        _ictx: ictx,
        _decoder: decoder,
        frame,
        hw_ctx,
        width,
        height,
        device,
        device_context,
        lock,
        unlock,
        lock_ctx,
    })
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
