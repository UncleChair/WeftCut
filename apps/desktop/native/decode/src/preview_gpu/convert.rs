//! NV12→RGBA conversion pass on ffmpeg's D3D11 device — the color-sovereign
//! HW lane's own YUV→RGB math (ADR 0032 generalized: color math AND tag
//! authority never delegate to the browser).
//!
//! Every pool slot is an RGBA8 texture; each delivered frame renders the
//! decoded NV12 surface through a session-owned pixel shader into the slot,
//! and the browser-side `createImageBitmap` of the imported `rgba` frame is a
//! pure byte copy (proven byte-exact by the A′ ticket-01 probe). Explicitly
//! NOT `ID3D11VideoContext::VideoProcessorBlt`: its conversion math is
//! driver-defined, which can neither be pinned to the conformance goldens nor
//! reproduced cross-machine.
//!
//! The coefficient math is the Rust twin of the renderer's
//! `render/tenbit/yuv10.ts` (`coefForMatrix` + `inverseCoef`) and the
//! normalization matches `Nv12Ingest`'s shader: y=(Y·255−yOff)/yScale,
//! c=(C·255−128)/cScale with (16,219,224) limited / (0,255,255) full. Both
//! planes are POINT-sampled (nearest chroma upsample), matching Nv12Ingest's
//! `scaleMode: "nearest"` plane sources so the two lanes agree byte-for-byte
//! on the conformance fixtures. Constants are baked into the shader as
//! `#define`s at session open (color tags are per-stream constants), so the
//! per-frame cost is one staging copy + one full-screen triangle, no constant
//! buffer updates.

use windows::core::{Interface, HRESULT, PCSTR};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::{
    ID3DBlob, D3D11_SRV_DIMENSION_TEXTURE2D, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST,
};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader, ID3D11Query,
    ID3D11RenderTargetView, ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D,
    ID3D11VertexShader, D3D11_ASYNC_GETDATA_DONOTFLUSH, D3D11_BIND_SHADER_RESOURCE,
    D3D11_BOX, D3D11_COMPARISON_NEVER, D3D11_FILTER_MIN_MAG_MIP_POINT, D3D11_FLOAT32_MAX,
    D3D11_QUERY_DATA_TIMESTAMP_DISJOINT, D3D11_QUERY_DESC, D3D11_QUERY_TIMESTAMP,
    D3D11_QUERY_TIMESTAMP_DISJOINT, D3D11_SAMPLER_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC,
    D3D11_SHADER_RESOURCE_VIEW_DESC_0, D3D11_TEX2D_SRV, D3D11_TEXTURE2D_DESC,
    D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_USAGE_DEFAULT, D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_NV12, DXGI_FORMAT_R8G8_UNORM, DXGI_FORMAT_R8_UNORM, DXGI_SAMPLE_DESC,
};

/// Kr/Kb of a YCbCr matrix (Kg = 1 − Kr − Kb). Twin of `yuv10.ts`'s `YuvCoef`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct YuvCoef {
    pub kr: f64,
    pub kb: f64,
}
pub const BT709: YuvCoef = YuvCoef { kr: 0.2126, kb: 0.0722 };
pub const BT601: YuvCoef = YuvCoef { kr: 0.299, kb: 0.114 };

/// Matrix tag → coefficients. MUST stay the same selection rule as the
/// renderer's `coefForMatrix` (yuv10.ts): smpte170m and bt470bg are both
/// BT.601; everything else — including untagged — is BT.709, the app's
/// working-space default. The tag string is the same one the renderer derives
/// (`deriveColorSpace`) and previously handed to `importSharedTexture`.
pub fn coef_for_matrix(matrix: &str) -> YuvCoef {
    if matrix == "smpte170m" || matrix == "bt470bg" {
        BT601
    } else {
        BT709
    }
}

/// Derived shader coefficients `[crR, cbG, crG, cbB]` for YUV→RGB. Twin of
/// `yuv10.ts`'s `inverseCoef` — same formulas, so both lanes' shaders agree
/// to float precision.
pub fn inverse_coef(c: YuvCoef) -> [f64; 4] {
    let kg = 1.0 - c.kr - c.kb;
    let cr_r = 2.0 * (1.0 - c.kr);
    let cb_b = 2.0 * (1.0 - c.kb);
    [cr_r, (c.kb * cb_b) / kg, (c.kr * cr_r) / kg, cb_b]
}

/// 8-bit normalization constants `(y_off, y_scale, c_scale)` — the same
/// limited/full split `Nv12Ingest` applies (`uYOff`/`uScale`).
pub fn norm_consts(full_range: bool) -> (f64, f64, f64) {
    if full_range {
        (0.0, 255.0, 255.0)
    } else {
        (16.0, 219.0, 224.0)
    }
}

/// The conversion shader. The vertex stage emits one full-screen triangle from
/// `SV_VertexID` (no vertex buffer); the pixel stage point-samples the Y (R8)
/// and interleaved CbCr (R8G8) planes and applies the matrix baked in via the
/// `#define`s below. RG order in the UV plane is U then V, so `.x` is Cb and
/// `.y` is Cr — same as Nv12Ingest's `texture(uUV).rg`.
const HLSL: &str = r#"
Texture2D<float>  texY  : register(t0);
Texture2D<float2> texUV : register(t1);
SamplerState      samp  : register(s0);

struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

VSOut vs_main(uint vid : SV_VertexID) {
    float2 clip[3] = { float2(-1.0, -3.0), float2(-1.0, 1.0), float2(3.0, 1.0) };
    float2 uvs[3]  = { float2(0.0, 2.0),  float2(0.0, 0.0),  float2(2.0, 0.0)  };
    VSOut o;
    o.pos = float4(clip[vid], 0.0, 1.0);
    o.uv  = uvs[vid];
    return o;
}

float4 ps_main(VSOut i) : SV_TARGET {
    float y = (texY.Sample(samp, i.uv).r * 255.0 - YOFF) / YSCALE;
    float2 c = (texUV.Sample(samp, i.uv).rg * 255.0 - 128.0) / CSCALE;
    float3 rgb = float3(
        y + CRR * c.y,
        y - CRG * c.y - CBG * c.x,
        y + CBB * c.x);
    return float4(saturate(rgb), 1.0);
}
"#;

/// `S_FALSE` as `ID3D11DeviceContext::GetData` returns it for a
/// still-in-flight query. Its sign bit is 0, so windows-rs's safe wrapper
/// collapses it to `Ok(())` — indistinguishable from data-ready. Same pitfall
/// (and same vtable-call workaround) as `AcquireSync`'s `WAIT_TIMEOUT` in
/// session.rs.
const S_FALSE: i32 = 1;

fn compile(entry: &str, target: &str, defines: &str) -> Result<ID3DBlob, String> {
    unsafe {
        let mut blob: Option<ID3DBlob> = None;
        let mut errs: Option<ID3DBlob> = None;
        // Prepend the baked constants to the source rather than building a
        // D3D_SHADER_MACRO table: one allocation, no pointer-lifetime footguns.
        let src = format!("{defines}\n{HLSL}");
        let src_bytes = src.as_bytes();
        let entry_z = format!("{entry}\0");
        let target_z = format!("{target}\0");
        let hr = D3DCompile(
            src_bytes.as_ptr() as *const _,
            src_bytes.len(),
            None,
            None,
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

/// Session-owned conversion state: created once at open on ffmpeg's device,
/// reused for every frame. Lives (and dies) on the session thread with the
/// rest of the `!Send` COM objects.
pub struct ConvertPass {
    /// NV12 staging with `BIND_SHADER_RESOURCE`: the decoder's surfaces are
    /// `BIND_DECODER`-only array slices, which can't carry SRVs, so each frame
    /// is first copied here (subresource 0) and the SRVs below stay valid for
    /// the whole session.
    staging: ID3D11Texture2D,
    srv_y: ID3D11ShaderResourceView,
    srv_uv: ID3D11ShaderResourceView,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    /// One RTV per pool slot, index-aligned with the session's `pool`.
    rtvs: Vec<ID3D11RenderTargetView>,
    width: u32,
    height: u32,
    /// GPU-cost probe: one timestamp-disjoint bracket in flight at a time.
    /// Polled non-blocking at the next convert; a not-ready result just skips
    /// issuing a new bracket (the sample stream is a subsample, never a stall).
    q_disjoint: ID3D11Query,
    q_begin: ID3D11Query,
    q_end: ID3D11Query,
    query_in_flight: bool,
}

impl ConvertPass {
    /// Build the pass on `device` for a `width`×`height` stream whose color
    /// tags are `matrix` (renderer-derived tag string) + `full_range`. `slots`
    /// are the session's RGBA8 pool textures (RTVs are created here so the
    /// per-frame path never allocates).
    pub fn new(
        device: &ID3D11Device,
        width: u32,
        height: u32,
        matrix: &str,
        full_range: bool,
        slots: &[ID3D11Texture2D],
    ) -> Result<Self, String> {
        let [cr_r, cb_g, cr_g, cb_b] = inverse_coef(coef_for_matrix(matrix));
        let (y_off, y_scale, c_scale) = norm_consts(full_range);
        // f64 → HLSL float literals. 10 significant decimals is beyond f32's
        // round-trip precision, so the baked constant IS the f32 nearest to
        // the f64 the TS twin computes.
        let defines = format!(
            "#define CRR {cr_r:.10}\n#define CBG {cb_g:.10}\n#define CRG {cr_g:.10}\n\
             #define CBB {cb_b:.10}\n#define YOFF {y_off:.1}\n#define YSCALE {y_scale:.1}\n\
             #define CSCALE {c_scale:.1}"
        );

        unsafe {
            let staging_desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut staging: Option<ID3D11Texture2D> = None;
            device
                .CreateTexture2D(&staging_desc, None, Some(&mut staging))
                .map_err(|e| format!("CreateTexture2D(convert staging) failed: {e}"))?;
            let staging = staging.ok_or_else(|| "CreateTexture2D(staging): null".to_string())?;

            // Per-plane typed views over the one NV12 staging texture.
            let tex2d = D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
                Texture2D: D3D11_TEX2D_SRV { MostDetailedMip: 0, MipLevels: 1 },
            };
            let y_desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
                Format: DXGI_FORMAT_R8_UNORM,
                ViewDimension: D3D11_SRV_DIMENSION_TEXTURE2D,
                Anonymous: tex2d,
            };
            let mut srv_y: Option<ID3D11ShaderResourceView> = None;
            device
                .CreateShaderResourceView(&staging, Some(&y_desc), Some(&mut srv_y))
                .map_err(|e| format!("CreateShaderResourceView(Y R8) failed: {e}"))?;
            let uv_desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
                Format: DXGI_FORMAT_R8G8_UNORM,
                ViewDimension: D3D11_SRV_DIMENSION_TEXTURE2D,
                Anonymous: tex2d,
            };
            let mut srv_uv: Option<ID3D11ShaderResourceView> = None;
            device
                .CreateShaderResourceView(&staging, Some(&uv_desc), Some(&mut srv_uv))
                .map_err(|e| format!("CreateShaderResourceView(UV R8G8) failed: {e}"))?;

            let vs_blob = compile("vs_main", "vs_5_0", &defines)?;
            let ps_blob = compile("ps_main", "ps_5_0", &defines)?;
            let vs_bytes = std::slice::from_raw_parts(
                vs_blob.GetBufferPointer() as *const u8,
                vs_blob.GetBufferSize(),
            );
            let ps_bytes = std::slice::from_raw_parts(
                ps_blob.GetBufferPointer() as *const u8,
                ps_blob.GetBufferSize(),
            );
            let mut vs: Option<ID3D11VertexShader> = None;
            device
                .CreateVertexShader(vs_bytes, None, Some(&mut vs))
                .map_err(|e| format!("CreateVertexShader failed: {e}"))?;
            let mut ps: Option<ID3D11PixelShader> = None;
            device
                .CreatePixelShader(ps_bytes, None, Some(&mut ps))
                .map_err(|e| format!("CreatePixelShader failed: {e}"))?;

            // POINT/CLAMP: nearest chroma upsample (Nv12Ingest parity) and
            // exact Y fetches at pixel centers.
            let samp_desc = D3D11_SAMPLER_DESC {
                Filter: D3D11_FILTER_MIN_MAG_MIP_POINT,
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

            let mut rtvs = Vec::with_capacity(slots.len());
            for (i, slot) in slots.iter().enumerate() {
                let mut rtv: Option<ID3D11RenderTargetView> = None;
                device
                    .CreateRenderTargetView(slot, None, Some(&mut rtv))
                    .map_err(|e| format!("CreateRenderTargetView(slot {i}) failed: {e}"))?;
                rtvs.push(rtv.ok_or_else(|| format!("CreateRenderTargetView(slot {i}): null"))?);
            }

            let make_query = |q: D3D11_QUERY_DESC| -> Result<ID3D11Query, String> {
                let mut out: Option<ID3D11Query> = None;
                device
                    .CreateQuery(&q, Some(&mut out))
                    .map_err(|e| format!("CreateQuery failed: {e}"))?;
                out.ok_or_else(|| "CreateQuery: null".to_string())
            };
            let q_disjoint = make_query(D3D11_QUERY_DESC {
                Query: D3D11_QUERY_TIMESTAMP_DISJOINT,
                MiscFlags: 0,
            })?;
            let q_begin = make_query(D3D11_QUERY_DESC {
                Query: D3D11_QUERY_TIMESTAMP,
                MiscFlags: 0,
            })?;
            let q_end = make_query(D3D11_QUERY_DESC {
                Query: D3D11_QUERY_TIMESTAMP,
                MiscFlags: 0,
            })?;

            Ok(Self {
                staging,
                srv_y: srv_y.unwrap(),
                srv_uv: srv_uv.unwrap(),
                vs: vs.unwrap(),
                ps: ps.unwrap(),
                sampler: sampler.unwrap(),
                rtvs,
                width,
                height,
                q_disjoint,
                q_begin,
                q_end,
                query_in_flight: false,
            })
        }
    }

    /// Raw-HRESULT `GetData` (see `S_FALSE`): `Ok(true)` = data ready and
    /// copied, `Ok(false)` = still in flight, `Err` = real failure.
    ///
    /// # Safety
    /// `data`/`size` must describe valid writable storage for `query`'s type.
    unsafe fn get_data_raw(
        context: &ID3D11DeviceContext,
        query: &ID3D11Query,
        data: *mut core::ffi::c_void,
        size: u32,
    ) -> Result<bool, String> {
        let hr: HRESULT = (Interface::vtable(context).GetData)(
            Interface::as_raw(context),
            Interface::as_raw(query),
            data,
            size,
            D3D11_ASYNC_GETDATA_DONOTFLUSH.0 as u32,
        );
        if hr.0 == S_FALSE {
            return Ok(false);
        }
        hr.ok().map_err(|e| format!("GetData(query) failed: {e}"))?;
        Ok(true)
    }

    /// Non-blocking poll of the previous frame's GPU-time bracket. Returns the
    /// measured nanoseconds when it resolved this call, `None` otherwise
    /// (nothing in flight / still in flight / disjoint interval discarded).
    ///
    /// # Safety
    /// Caller must hold ffmpeg's device-context lock (all context use on this
    /// thread does).
    pub unsafe fn poll_gpu_time(&mut self, context: &ID3D11DeviceContext) -> Option<u64> {
        if !self.query_in_flight {
            return None;
        }
        let mut dj = D3D11_QUERY_DATA_TIMESTAMP_DISJOINT::default();
        match Self::get_data_raw(
            context,
            &self.q_disjoint,
            &mut dj as *mut _ as *mut _,
            std::mem::size_of::<D3D11_QUERY_DATA_TIMESTAMP_DISJOINT>() as u32,
        ) {
            Ok(true) => {}
            Ok(false) => return None, // keep in flight; poll again next frame
            Err(_) => {
                self.query_in_flight = false;
                return None;
            }
        }
        // Disjoint resolved ⇒ the enclosed timestamps have too.
        self.query_in_flight = false;
        if dj.Disjoint.as_bool() || dj.Frequency == 0 {
            return None;
        }
        let mut t0 = 0u64;
        let mut t1 = 0u64;
        let ok0 = Self::get_data_raw(context, &self.q_begin, &mut t0 as *mut _ as *mut _, 8);
        let ok1 = Self::get_data_raw(context, &self.q_end, &mut t1 as *mut _ as *mut _, 8);
        match (ok0, ok1) {
            (Ok(true), Ok(true)) if t1 > t0 => {
                Some(((t1 - t0) as u128 * 1_000_000_000u128 / dj.Frequency as u128) as u64)
            }
            _ => None,
        }
    }

    /// Copy the decoded NV12 slice into staging and render it into slot
    /// `slot_idx`'s RGBA8 texture. The caller brackets this whole call in the
    /// slot's keyed mutex AND ffmpeg's device-context lock, and flushes after.
    ///
    /// # Safety
    /// `src_tex`/`src_index` must be a live decoded surface on the same device;
    /// both locks per above.
    pub unsafe fn convert_into_slot(
        &mut self,
        context: &ID3D11DeviceContext,
        src_tex: &ID3D11Texture2D,
        src_index: u32,
        slot_idx: usize,
    ) -> Result<(), String> {
        let rtv = self
            .rtvs
            .get(slot_idx)
            .ok_or_else(|| format!("convert: no RTV for slot {slot_idx}"))?
            .clone();

        // Open a GPU-time bracket only when the previous one has resolved.
        let time_this_frame = !self.query_in_flight;
        if time_this_frame {
            context.Begin(&self.q_disjoint);
            context.End(&self.q_begin);
        }

        let region = D3D11_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: self.width,
            bottom: self.height,
            back: 1,
        };
        context.CopySubresourceRegion(&self.staging, 0, 0, 0, 0, src_tex, src_index, Some(&region));

        context.VSSetShader(&self.vs, None);
        context.PSSetShader(&self.ps, None);
        context.PSSetShaderResources(0, Some(&[Some(self.srv_y.clone()), Some(self.srv_uv.clone())]));
        context.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
        context.OMSetRenderTargets(Some(&[Some(rtv)]), None);
        let viewport = D3D11_VIEWPORT {
            TopLeftX: 0.0,
            TopLeftY: 0.0,
            Width: self.width as f32,
            Height: self.height as f32,
            MinDepth: 0.0,
            MaxDepth: 1.0,
        };
        context.RSSetViewports(Some(&[viewport]));
        context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context.Draw(3, 0);
        // Unbind before the caller flushes/shares: the RTV is a cross-process
        // texture about to be read by Chromium, and the staging SRVs are the
        // destination of next frame's CopySubresourceRegion (a bound-while-
        // copied hazard the runtime only papers over with a debug warning).
        context.OMSetRenderTargets(Some(&[None]), None);
        context.PSSetShaderResources(0, Some(&[None, None]));

        if time_this_frame {
            context.End(&self.q_end);
            context.End(&self.q_disjoint);
            self.query_in_flight = true;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden coefficient sets for the four encodings — the same numbers the
    /// renderer's `inverseCoef` produces (and Result 6's shader hardcoded).
    /// Guards drift between this Rust twin and `yuv10.ts`.
    #[test]
    fn inverse_coef_matches_ts_twin() {
        let close = |a: f64, b: f64| (a - b).abs() < 1e-6;
        let c709 = inverse_coef(BT709);
        assert!(close(c709[0], 1.5748), "709 crR {}", c709[0]);
        assert!(close(c709[1], 0.187_324_27), "709 cbG {}", c709[1]);
        assert!(close(c709[2], 0.468_124_27), "709 crG {}", c709[2]);
        assert!(close(c709[3], 1.8556), "709 cbB {}", c709[3]);
        let c601 = inverse_coef(BT601);
        assert!(close(c601[0], 1.402), "601 crR {}", c601[0]);
        assert!(close(c601[1], 0.344_136_28), "601 cbG {}", c601[1]);
        assert!(close(c601[2], 0.714_136_29), "601 crG {}", c601[2]);
        assert!(close(c601[3], 1.772), "601 cbB {}", c601[3]);
    }

    #[test]
    fn matrix_tag_selection_matches_ts_twin() {
        assert_eq!(coef_for_matrix("smpte170m"), BT601);
        assert_eq!(coef_for_matrix("bt470bg"), BT601);
        assert_eq!(coef_for_matrix("bt709"), BT709);
        // Untagged/unknown fall to the working-space default, like coefForMatrix.
        assert_eq!(coef_for_matrix(""), BT709);
        assert_eq!(coef_for_matrix("bt2020-ncl"), BT709);
    }

    #[test]
    fn norm_consts_match_nv12_ingest() {
        assert_eq!(norm_consts(false), (16.0, 219.0, 224.0));
        assert_eq!(norm_consts(true), (0.0, 255.0, 255.0));
    }
}
