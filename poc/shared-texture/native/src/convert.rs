//! Result 6 — native NV12→BGRA color convert (on ffmpeg's D3D11 device).
//!
//! Result 5 found that feeding a raw NV12 `VideoFrame` (BT.601-tagged) into a
//! WebGPU texture via `copyExternalImageToTexture` / `importExternalTexture`
//! mis-colors the frame ([58,217,38] instead of the [20,220,40] that 2D
//! `drawImage` produces), because Chromium's WebGPU YUV→RGB ingestion does not
//! render the 601 colorimetry the way `drawImage` does. The fix: do the YUV→RGB
//! ourselves, in native, on ffmpeg's D3D11 device where the decoded NV12 surface
//! lives, and hand Chromium an already-BGRA texture (matrix:'rgb', range:'full')
//! so the WebGPU path has no YUV→RGB to mishandle.
//!
//! The conversion itself is [`convert_nv12_to_bgra_shader`], a custom HLSL pixel
//! shader. Do NOT swap in `VideoProcessorBlt`: it may apply a 601→display
//! primaries remap and reintroduce the mis-color.

use windows::core::{Interface, PCSTR, PCWSTR};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::{
    D3D11_SRV_DIMENSION_TEXTURE2D, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST, D3D_SHADER_MACRO,
};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader, ID3D11RenderTargetView,
    ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11VertexShader,
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_COMPARISON_NEVER,
    D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_FLOAT32_MAX, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX,
    D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_SAMPLER_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC,
    D3D11_SHADER_RESOURCE_VIEW_DESC_0, D3D11_TEX2D_SRV, D3D11_TEXTURE2D_DESC,
    D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_USAGE_DEFAULT, D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8_UNORM, DXGI_FORMAT_R8_UNORM, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};

use windows::Win32::Graphics::Direct3D::ID3DBlob;

const INFINITE: u32 = 0xFFFF_FFFF;
const DXGI_SHARED_RESOURCE_RW: u32 = 0x8000_0001;

/// Which limited-range YUV→RGB matrix the convert shader applies. The matrix
/// MUST match the source's color tag — applying 601 to 709-encoded bytes (or
/// vice-versa) produces a wrong-but-self-consistent result (proven in Result 6).
/// A real integration reads this from the decoded stream's colorimetry; the POC
/// drives it via `POC_BGRA_MATRIX`.
#[derive(Clone, Copy)]
pub enum YuvMatrix {
    /// BT.601 (smpte170m) — SD / much legacy content.
    Bt601,
    /// BT.709 — HD content.
    Bt709,
}

/// HLSL for the matrix-only NV12→BGRA convert. The vertex shader emits a
/// full-screen triangle and passes through clip-space UVs. The pixel shader
/// samples the Y plane (R8) and UV plane (R8G8), then applies a **limited-range**
/// YUV→RGB matrix selected by the `MATRIX709` compile define — the EXACT
/// matrix-only arithmetic a naive `drawImage` does (no primaries/gamut remap),
/// so the BGRA output matches `drawImage`'s color for the corresponding tag. The
/// render target is BGRA, so we write float RGBA and D3D swizzles to BGRA on
/// store.
const HLSL: &str = r#"
Texture2D<float>  texY  : register(t0);
Texture2D<float2> texUV : register(t1);
SamplerState      samp  : register(s0);

struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

VSOut vs_main(uint vid : SV_VertexID) {
    // Full-screen triangle (no vertex buffer).
    float2 clip[3] = { float2(-1.0, -3.0), float2(-1.0, 1.0), float2(3.0, 1.0) };
    float2 uvs[3]  = { float2(0.0, 2.0),  float2(0.0, 0.0),  float2(2.0, 0.0)  };
    VSOut o;
    o.pos = float4(clip[vid], 0.0, 1.0);
    o.uv  = uvs[vid];
    return o;
}

float4 ps_main(VSOut i) : SV_TARGET {
    float Y  = texY.Sample(samp, i.uv).r;
    float2 C = texUV.Sample(samp, i.uv).rg;
    // Limited-range: Y in [16,235], C in [16,240] over 8-bit (0..1 here).
    float Yl = (Y  * 255.0 - 16.0)  / 219.0;
    float Cb = (C.x * 255.0 - 128.0) / 224.0;
    float Cr = (C.y * 255.0 - 128.0) / 224.0;
#if MATRIX709
    // BT.709.
    float r = Yl + 1.5748   * Cr;
    float g = Yl - 0.187324 * Cb - 0.468124 * Cr;
    float b = Yl + 1.8556   * Cb;
#else
    // BT.601 (smpte170m).
    float r = Yl + 1.402    * Cr;
    float g = Yl - 0.344136 * Cb - 0.714136 * Cr;
    float b = Yl + 1.772    * Cb;
#endif
    return float4(saturate(float3(r, g, b)), 1.0);
}
"#;

/// A shared BGRA texture produced by the convert, plus its NT handle, ready to be
/// registered + handed to JS. The caller owns the texture/device lifetime.
pub struct BgraResult {
    pub texture: ID3D11Texture2D,
    pub handle: HANDLE,
    pub width: u32,
    pub height: u32,
}

fn compile(entry: &str, target: &str, matrix: YuvMatrix) -> Result<ID3DBlob, String> {
    unsafe {
        let mut blob: Option<ID3DBlob> = None;
        let mut errs: Option<ID3DBlob> = None;
        let src = HLSL.as_bytes();
        // Null-terminated copies held in locals so the pointers stay valid for
        // the whole D3DCompile call (a `format!(...).as_ptr()` temporary would
        // dangle).
        let entry_z = format!("{entry}\0");
        let target_z = format!("{target}\0");
        // Drive the matrix branch via a #define, terminated by an all-null macro.
        let m709 = match matrix {
            YuvMatrix::Bt709 => "1\0",
            YuvMatrix::Bt601 => "0\0",
        };
        let defines = [
            D3D_SHADER_MACRO {
                Name: PCSTR(b"MATRIX709\0".as_ptr()),
                Definition: PCSTR(m709.as_ptr()),
            },
            D3D_SHADER_MACRO { Name: PCSTR::null(), Definition: PCSTR::null() },
        ];
        let hr = D3DCompile(
            src.as_ptr() as *const _,
            src.len(),
            None,
            Some(defines.as_ptr()),
            None,
            PCSTR(entry_z.as_ptr()),
            PCSTR(target_z.as_ptr()),
            D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &mut blob,
            Some(&mut errs),
        );
        if hr.is_err() {
            let msg = errs
                .as_ref()
                .map(|e| {
                    let p = e.GetBufferPointer() as *const u8;
                    let n = e.GetBufferSize();
                    String::from_utf8_lossy(std::slice::from_raw_parts(p, n)).into_owned()
                })
                .unwrap_or_else(|| format!("{hr:?}"));
            return Err(format!("D3DCompile({entry}) failed: {msg}"));
        }
        blob.ok_or_else(|| format!("D3DCompile({entry}): null blob"))
    }
}

/// Create a shared BGRA destination texture on `device`
/// (`SHADER_RESOURCE|RENDER_TARGET|SHARED_NTHANDLE|SHARED_KEYEDMUTEX`).
fn make_shared_bgra(
    device: &ID3D11Device,
    width: u32,
    height: u32,
) -> Result<(ID3D11Texture2D, HANDLE), String> {
    unsafe {
        let nt_km =
            (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: nt_km,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut tex))
            .map_err(|e| format!("CreateTexture2D(bgra dst {width}x{height}) failed: {e}"))?;
        let tex = tex.ok_or_else(|| "CreateTexture2D(bgra): null".to_string())?;

        let resource: IDXGIResource1 = tex
            .cast()
            .map_err(|e| format!("cast IDXGIResource1 failed: {e}"))?;
        let handle = resource
            .CreateSharedHandle(None, DXGI_SHARED_RESOURCE_RW, PCWSTR::null())
            .map_err(|e| format!("CreateSharedHandle failed: {e}"))?;
        Ok((tex, handle))
    }
}

/// Convert the decoded NV12 surface `src_nv12` to BGRA on `device`/`context`
/// using the limited-range matrix selected by `matrix`, into a fresh shared BGRA
/// texture. The destination write is bracketed by the destination's keyed mutex
/// (our render vs. Chromium's later read).
///
/// IMPORTANT: SRVs over an NV12 texture require the texture to carry
/// `D3D11_BIND_SHADER_RESOURCE`. ffmpeg's decoder textures are `BIND_DECODER`
/// only and array-typed, so we cannot SRV them directly — the caller must first
/// `CopySubresourceRegion` the decoded slice into a non-array NV12 texture that
/// has `BIND_SHADER_RESOURCE`. `src_nv12` is that copy.
#[allow(clippy::too_many_arguments)]
pub fn convert_nv12_to_bgra_shader(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    src_nv12: &ID3D11Texture2D,
    width: u32,
    height: u32,
    matrix: YuvMatrix,
) -> Result<BgraResult, String> {
    unsafe {
        // Two SRVs over the one NV12 texture: Y plane as R8, UV plane as R8G8 —
        // D3D11 exposes each NV12 plane as its own typed view.
        let mut srv_y: Option<ID3D11ShaderResourceView> = None;
        let mut srv_uv: Option<ID3D11ShaderResourceView> = None;
        let y_desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
            Format: DXGI_FORMAT_R8_UNORM,
            ViewDimension: D3D11_SRV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_SRV { MostDetailedMip: 0, MipLevels: 1 },
            },
        };
        device
            .CreateShaderResourceView(src_nv12, Some(&y_desc), Some(&mut srv_y))
            .map_err(|e| format!("CreateShaderResourceView(Y R8) failed: {e}"))?;
        let uv_desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
            Format: DXGI_FORMAT_R8G8_UNORM,
            ViewDimension: D3D11_SRV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_SRV { MostDetailedMip: 0, MipLevels: 1 },
            },
        };
        device
            .CreateShaderResourceView(src_nv12, Some(&uv_desc), Some(&mut srv_uv))
            .map_err(|e| format!("CreateShaderResourceView(UV R8G8) failed: {e}"))?;
        let srv_y = srv_y.unwrap();
        let srv_uv = srv_uv.unwrap();

        // Compile + create the shaders (matrix selected by compile define).
        let vs_blob = compile("vs_main", "vs_5_0", matrix)?;
        let ps_blob = compile("ps_main", "ps_5_0", matrix)?;
        let vs_bytes = std::slice::from_raw_parts(
            vs_blob.GetBufferPointer() as *const u8,
            vs_blob.GetBufferSize(),
        );
        let ps_bytes = std::slice::from_raw_parts(
            ps_blob.GetBufferPointer() as *const u8,
            ps_blob.GetBufferSize(),
        );
        let mut vs: Option<ID3D11VertexShader> = None;
        let mut ps: Option<ID3D11PixelShader> = None;
        device
            .CreateVertexShader(vs_bytes, None, Some(&mut vs))
            .map_err(|e| format!("CreateVertexShader failed: {e}"))?;
        device
            .CreatePixelShader(ps_bytes, None, Some(&mut ps))
            .map_err(|e| format!("CreatePixelShader failed: {e}"))?;
        let vs = vs.unwrap();
        let ps = ps.unwrap();

        // Linear-clamp sampler (chroma is half-res; clamp avoids edge wrap).
        let samp_desc = D3D11_SAMPLER_DESC {
            Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
            AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
            MipLODBias: 0.0,
            MaxAnisotropy: 1,
            ComparisonFunc: D3D11_COMPARISON_NEVER,
            BorderColor: [0.0; 4],
            MinLOD: 0.0,
            MaxLOD: D3D11_FLOAT32_MAX,
        };
        let mut sampler: Option<ID3D11SamplerState> = None;
        device
            .CreateSamplerState(&samp_desc, Some(&mut sampler))
            .map_err(|e| format!("CreateSamplerState failed: {e}"))?;
        let sampler = sampler.unwrap();

        // Shared BGRA destination + its render-target view + keyed mutex.
        let (dst, handle) = make_shared_bgra(device, width, height)?;
        let mut rtv: Option<ID3D11RenderTargetView> = None;
        device
            .CreateRenderTargetView(&dst, None, Some(&mut rtv))
            .map_err(|e| format!("CreateRenderTargetView failed: {e}"))?;
        let rtv = rtv.unwrap();
        let dst_km: IDXGIKeyedMutex = dst
            .cast()
            .map_err(|e| format!("cast IDXGIKeyedMutex(dst) failed: {e}"))?;

        // Render the full-screen triangle: NV12 SRVs → BGRA RTV.
        dst_km
            .AcquireSync(0, INFINITE)
            .map_err(|e| format!("AcquireSync(bgra dst) failed: {e}"))?;

        context.VSSetShader(&vs, None);
        context.PSSetShader(&ps, None);
        context.PSSetShaderResources(0, Some(&[Some(srv_y.clone()), Some(srv_uv.clone())]));
        context.PSSetSamplers(0, Some(&[Some(sampler.clone())]));
        context.OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);
        let viewport = D3D11_VIEWPORT {
            TopLeftX: 0.0,
            TopLeftY: 0.0,
            Width: width as f32,
            Height: height as f32,
            MinDepth: 0.0,
            MaxDepth: 1.0,
        };
        context.RSSetViewports(Some(&[viewport]));
        context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context.Draw(3, 0);
        // Unbind the RTV before flush so D3D doesn't hold it (defensive; the
        // texture is about to be shared cross-process).
        context.OMSetRenderTargets(Some(&[None]), None);
        context.Flush();

        dst_km
            .ReleaseSync(0)
            .map_err(|e| format!("ReleaseSync(bgra dst) failed: {e}"))?;

        Ok(BgraResult { texture: dst, handle, width, height })
    }
}
