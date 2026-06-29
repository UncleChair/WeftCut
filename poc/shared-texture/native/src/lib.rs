//! Minimal POC native side.
//!
//! Creates a 256x256 synthetic shared D3D11 texture — `bgra` (checkerboard) or
//! `nv12` (Y bright-top/dark-bottom, neutral chroma) — and returns its
//! process-local NT HANDLE to JS so the main process can
//! `sharedTexture.importSharedTexture()` it and display it in the renderer.
//!
//! Step 1a of the ffmpeg path: prove an NV12 (YUV) shared texture round-trips,
//! before wiring real ffmpeg d3d11va decode (which produces NV12).
//!
//! Raw `ID3D11Device::CreateTexture2D` only accepts a shareable NT-handle texture
//! when created with `SHARED_NTHANDLE | SHARED_KEYEDMUTEX` together (proven by the
//! earlier flag-combo probe), so every texture here carries a keyed mutex and the
//! upload is bracketed in `AcquireSync(0)`/`ReleaseSync(0)`. The texture is written
//! once and never mutated, so no further sync is needed for this probe.
//!
//! Windows-only by design.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0,
    D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_12_0, D3D_FEATURE_LEVEL_12_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, IDXGIKeyedMutex, IDXGIResource1,
};

mod decoder;

const SIZE: u32 = 256;
const CELL: u32 = 32;
const INFINITE: u32 = 0xFFFF_FFFF;
/// `DXGI_SHARED_RESOURCE_READ (0x80000000) | DXGI_SHARED_RESOURCE_WRITE (0x1)`.
/// Passed as a raw u32 because the windows-crate newtype OR doesn't coerce to the
/// method's `u32` parameter.
const DXGI_SHARED_RESOURCE_RW: u32 = 0x8000_0001;

/// Keeps the D3D11 device + texture + handle alive until JS says every cross-process
/// reference has been released (Electron's `allReferencesReleased` callback). The COM
/// objects are `!Send`; every napi call here runs on the Node main thread and the
/// objects never cross threads, so the manual `Send` impl is sound.
struct Holder {
    _device: ID3D11Device,
    _texture: ID3D11Texture2D,
    handle: HANDLE,
}
unsafe impl Send for Holder {}

static REGISTRY: Mutex<Option<HashMap<u32, Holder>>> = Mutex::new(None);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[napi(object)]
pub struct PocSharedTexture {
    pub id: u32,
    /// Little-endian bytes of the process-local NT HANDLE. Feed this into
    /// `textureInfo.handle.ntHandle`.
    pub handle: Buffer,
    pub width: u32,
    pub height: u32,
    /// The GPU adapter the texture lives on. If this is not the adapter Chromium's
    /// GPU process uses, the cross-process handle open will fail (POC risk R2).
    pub adapter: String,
    /// Raw handle value, decimal — for logging/diagnostics only.
    pub handle_value: String,
    /// The shared texture's pixel format ("bgra" | "nv12") — JS passes this
    /// straight into `textureInfo.pixelFormat`.
    pub pixel_format: String,
}

fn win_err(ctx: &str, e: windows::core::Error) -> napi::Error {
    napi::Error::from_reason(format!("{ctx} failed: {e}"))
}

fn checkerboard() -> Vec<u8> {
    // BGRA, two obviously-different colors so a correct frame is unmistakable.
    let orange = [0x33u8, 0x66, 0xff, 0xff]; // B,G,R,A -> renders as R=255,G=102,B=51
    let dark = [0x22u8, 0x22, 0x22, 0xff];
    let mut px = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let i = ((y * SIZE + x) * 4) as usize;
            let c = if ((x / CELL) + (y / CELL)) % 2 == 0 { &orange } else { &dark };
            px[i..i + 4].copy_from_slice(c);
        }
    }
    px
}

/// NV12 plane buffer: Y plane (top half bright, bottom half dark) followed by a
/// neutral chroma plane, so a correct frame shows two clearly different gray
/// bands regardless of the exact YUV->RGB matrix.
fn nv12_pattern() -> Vec<u8> {
    let (w, h) = (SIZE as usize, SIZE as usize);
    let mut buf = vec![0u8; w * h + w * h / 2];
    for y in 0..h {
        let luma = if y < h / 2 { 210u8 } else { 60u8 };
        for x in 0..w {
            buf[y * w + x] = luma;
        }
    }
    // Interleaved UV at neutral 128 == no color tint.
    for b in buf.iter_mut().skip(w * h) {
        *b = 128;
    }
    buf
}

/// Pick the highest-VRAM adapter — on a laptop with iGPU + dGPU that is the
/// discrete GPU, which is what Chromium prefers for GPU compositing/WebGPU. Logs
/// every adapter so a mismatch (risk R2) is diagnosable.
fn pick_adapter() -> windows::core::Result<(Option<IDXGIAdapter>, String)> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
        let mut best: Option<(IDXGIAdapter, u64, String)> = None;
        let mut i = 0u32;
        while let Ok(ad1) = factory.EnumAdapters1(i) {
            let desc = ad1.GetDesc1()?;
            let end = desc
                .Description
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(desc.Description.len());
            let name = String::from_utf16_lossy(&desc.Description[..end]);
            let vram = desc.DedicatedVideoMemory as u64;
            eprintln!("[poc-native] adapter[{i}] = {name} ({} MB VRAM)", vram / (1024 * 1024));
            let better = best.as_ref().map(|(_, v, _)| vram > *v).unwrap_or(true);
            if better {
                best = Some((ad1.cast()?, vram, name));
            }
            i += 1;
        }
        Ok(match best {
            Some((a, _, n)) => (Some(a), n),
            None => (None, "default".to_string()),
        })
    }
}

/// Create a shareable D3D11 texture, upload `pixels` (bracketed by the mandatory
/// keyed mutex), open an NT handle, register it for later release, and return the
/// JS-facing descriptor. Shared by the synthetic and video paths.
fn make_shared_texture(
    width: u32,
    height: u32,
    dxgi_format: DXGI_FORMAT,
    bind: u32,
    row_pitch: u32,
    pixels: &[u8],
    pixel_format: &str,
) -> Result<PocSharedTexture> {
    unsafe {
        let (adapter, adapter_name) = pick_adapter().map_err(|e| win_err("pick_adapter", e))?;
        // DRIVER_TYPE_UNKNOWN when an explicit adapter is given, HARDWARE when not.
        let driver_type = if adapter.is_some() {
            D3D_DRIVER_TYPE_UNKNOWN
        } else {
            D3D_DRIVER_TYPE_HARDWARE
        };

        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let mut feature_level = D3D_FEATURE_LEVEL::default();
        D3D11CreateDevice(
            adapter.as_ref(),
            driver_type,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&[
                D3D_FEATURE_LEVEL_12_1,
                D3D_FEATURE_LEVEL_12_0,
                D3D_FEATURE_LEVEL_11_1,
                D3D_FEATURE_LEVEL_11_0,
            ]),
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut feature_level),
            Some(&mut context),
        )
        .map_err(|e| win_err("D3D11CreateDevice", e))?;
        let device = device.ok_or_else(|| napi::Error::from_reason("D3D11CreateDevice: null device"))?;
        let context = context.ok_or_else(|| napi::Error::from_reason("D3D11CreateDevice: null context"))?;

        // NTHANDLE|KEYEDMUTEX always — raw D3D11 requires the pair for a shareable
        // NT-handle texture (proven by the earlier flag-combo probe). windows 0.58:
        // struct flag fields are plain u32, constants are newtypes -> `.0`.
        let nt_km =
            (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32;
        // Shared textures reject initial data (E_INVALIDARG); upload after create.
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: dxgi_format,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: bind,
            CPUAccessFlags: 0,
            MiscFlags: nt_km,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut tex))
            .map_err(|e| win_err(&format!("CreateTexture2D({pixel_format} {width}x{height})"), e))?;
        let texture = tex.ok_or_else(|| napi::Error::from_reason("CreateTexture2D: null texture"))?;

        // Upload bracketed by the keyed mutex, then Flush before sharing.
        let keyed_mutex: IDXGIKeyedMutex =
            texture.cast().map_err(|e| win_err("cast IDXGIKeyedMutex", e))?;
        keyed_mutex.AcquireSync(0, INFINITE).map_err(|e| win_err("AcquireSync", e))?;
        context.UpdateSubresource(&texture, 0, None, pixels.as_ptr() as *const _, row_pitch, 0);
        context.Flush();
        keyed_mutex.ReleaseSync(0).map_err(|e| win_err("ReleaseSync", e))?;

        let resource: IDXGIResource1 = texture.cast().map_err(|e| win_err("cast IDXGIResource1", e))?;
        let handle = resource
            .CreateSharedHandle(None, DXGI_SHARED_RESOURCE_RW, PCWSTR::null())
            .map_err(|e| win_err("CreateSharedHandle", e))?;

        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let handle_value = handle.0 as isize as i64;
        eprintln!(
            "[poc-native] shared {pixel_format} texture id={id} {width}x{height} on '{adapter_name}', NT handle={handle_value}"
        );

        REGISTRY
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(id, Holder { _device: device, _texture: texture, handle });

        Ok(PocSharedTexture {
            id,
            handle: Buffer::from(handle_value.to_le_bytes().to_vec()),
            width,
            height,
            adapter: adapter_name,
            handle_value: handle_value.to_string(),
            pixel_format: pixel_format.to_string(),
        })
    }
}

#[napi]
pub fn poc_create_synthetic_texture(format: String) -> Result<PocSharedTexture> {
    let want = format.to_lowercase();
    // (dxgi_format, bindFlags, Y/row pitch, plane buffer). NV12 can't be a render
    // target; BGRA needs RENDER_TARGET to be shareable.
    let (dxgi_format, bind, row_pitch, pixels): (DXGI_FORMAT, u32, u32, Vec<u8>) =
        match want.as_str() {
            "bgra" => (
                DXGI_FORMAT_B8G8R8A8_UNORM,
                (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
                SIZE * 4,
                checkerboard(),
            ),
            "nv12" => (
                DXGI_FORMAT_NV12,
                D3D11_BIND_SHADER_RESOURCE.0 as u32,
                SIZE,
                nv12_pattern(),
            ),
            other => {
                return Err(napi::Error::from_reason(format!(
                    "unsupported format '{other}' (use bgra|nv12)"
                )))
            }
        };
    make_shared_texture(SIZE, SIZE, dxgi_format, bind, row_pitch, &pixels, &want)
}

/// Step 1b-i: ffmpeg-decode the first frame of `path` to NV12 (hardware decode
/// when available, then GPU→CPU transfer), then upload it into a shared NV12
/// texture. Proves the ffmpeg→shared-texture→renderer pipeline; 1b-ii will
/// replace the CPU bounce with a GPU `CopySubresourceRegion`.
#[napi]
pub fn poc_create_texture_from_video(path: String) -> Result<PocSharedTexture> {
    let (w, h, nv12) = decoder::decode_first_frame_nv12(&path)
        .map_err(|e| napi::Error::from_reason(format!("decode '{path}' failed: {e}")))?;
    eprintln!("[poc-native] decoded {w}x{h}, {} NV12 bytes", nv12.len());
    make_shared_texture(
        w,
        h,
        DXGI_FORMAT_NV12,
        D3D11_BIND_SHADER_RESOURCE.0 as u32,
        w,
        &nv12,
        "nv12",
    )
}

#[napi]
pub fn poc_release_texture(id: u32) {
    let holder = REGISTRY.lock().unwrap().as_mut().and_then(|m| m.remove(&id));
    if let Some(h) = holder {
        unsafe {
            let _ = CloseHandle(h.handle);
        }
        eprintln!("[poc-native] released texture id={id}");
        // device + texture drop here, releasing their COM references.
    }
}
