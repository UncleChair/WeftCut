//! Minimal POC native side.
//!
//! Creates a 256x256 BGRA D3D11 texture, fills it with a checkerboard, marks it
//! `D3D11_RESOURCE_MISC_SHARED_NTHANDLE` (NO keyed mutex — Electron's
//! `SharedTextureHandle` docs say rgba/bgra/rgbaf16 handles have no keyed mutex,
//! only nv12 does), and returns its process-local NT HANDLE to JS.
//!
//! The whole experiment hinges on one question: will Electron's
//! `sharedTexture.importSharedTexture()` accept a handle for a texture that
//! Chromium did NOT create? If yes, the renderer can display it as a VideoFrame.
//!
//! The texture is written once and never touched again, so there is no
//! producer/consumer race and we need no synchronization for this probe.
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
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1, IDXGIKeyedMutex, IDXGIResource1,
};

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

#[napi]
pub fn poc_create_synthetic_texture() -> Result<PocSharedTexture> {
    unsafe {
        let (adapter, adapter_name) = pick_adapter().map_err(|e| win_err("pick_adapter", e))?;
        // D3D11CreateDevice requires DRIVER_TYPE_UNKNOWN when an explicit adapter is
        // given, HARDWARE when it isn't.
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
            HMODULE::default(), // no software rasterizer
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

        // Shared textures reject initial data (E_INVALIDARG); we upload after
        // creation. windows 0.58: these struct flag fields are plain u32, the
        // constants are newtypes -> `.0`.
        let bind_sr = D3D11_BIND_SHADER_RESOURCE.0 as u32;
        let bind_sr_rt = (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32;
        let nt = D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 as u32;
        let km = D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0 as u32;

        // Probe combos in order, preferring NO keyed mutex (Chromium's bgra
        // convention). (label, bindFlags, hasKeyedMutex)
        let combos: [(&str, u32, bool); 4] = [
            ("SHADER_RESOURCE | NTHANDLE", bind_sr, false),
            ("SHADER_RESOURCE|RENDER_TARGET | NTHANDLE", bind_sr_rt, false),
            ("SHADER_RESOURCE|RENDER_TARGET | NTHANDLE|KEYEDMUTEX", bind_sr_rt, true),
            ("SHADER_RESOURCE | NTHANDLE|KEYEDMUTEX", bind_sr, true),
        ];
        let mut chosen: Option<(ID3D11Texture2D, bool, &str)> = None;
        for (label, bind, keyed) in combos {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: SIZE,
                Height: SIZE,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: bind,
                CPUAccessFlags: 0,
                MiscFlags: if keyed { nt | km } else { nt },
            };
            let mut tex: Option<ID3D11Texture2D> = None;
            match device.CreateTexture2D(&desc, None, Some(&mut tex)) {
                Ok(()) => {
                    eprintln!("[poc-native] CreateTexture2D OK: {label}");
                    chosen = Some((tex.unwrap(), keyed, label));
                    break;
                }
                Err(e) => eprintln!("[poc-native] CreateTexture2D FAIL [{label}]: {e}"),
            }
        }
        let (texture, has_keyed_mutex, combo_label) = chosen
            .ok_or_else(|| napi::Error::from_reason("no shared-texture flag combo was accepted"))?;
        eprintln!("[poc-native] using combo: {combo_label} (keyed_mutex={has_keyed_mutex})");

        // Upload the checkerboard, then Flush so the GPU completes the write
        // before the texture is shared. If the combo carries a keyed mutex,
        // bracket the write in Acquire/Release(0).
        let pixels = checkerboard();
        let keyed_mutex: Option<IDXGIKeyedMutex> = if has_keyed_mutex {
            Some(texture.cast().map_err(|e| win_err("cast IDXGIKeyedMutex", e))?)
        } else {
            None
        };
        if let Some(km) = &keyed_mutex {
            km.AcquireSync(0, INFINITE).map_err(|e| win_err("AcquireSync", e))?;
        }
        context.UpdateSubresource(&texture, 0, None, pixels.as_ptr() as *const _, SIZE * 4, 0);
        context.Flush();
        if let Some(km) = &keyed_mutex {
            km.ReleaseSync(0).map_err(|e| win_err("ReleaseSync", e))?;
        }

        // CreateSharedHandle requires SHARED_NTHANDLE; produces an NT HANDLE that
        // Electron duplicates into its own process on import.
        let resource: IDXGIResource1 = texture.cast().map_err(|e| win_err("cast IDXGIResource1", e))?;
        let handle = resource
            .CreateSharedHandle(None, DXGI_SHARED_RESOURCE_RW, PCWSTR::null())
            .map_err(|e| win_err("CreateSharedHandle", e))?;

        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let handle_value = handle.0 as isize as i64;
        eprintln!(
            "[poc-native] created texture id={id} on '{adapter_name}', NT handle={handle_value} (0x{:x})",
            handle_value
        );

        REGISTRY
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(id, Holder { _device: device, _texture: texture, handle });

        Ok(PocSharedTexture {
            id,
            handle: Buffer::from(handle_value.to_le_bytes().to_vec()),
            width: SIZE,
            height: SIZE,
            adapter: adapter_name,
            handle_value: handle_value.to_string(),
        })
    }
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
