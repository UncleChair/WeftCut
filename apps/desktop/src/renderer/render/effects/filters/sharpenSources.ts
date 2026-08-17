// Sharpen shader sources — GLSL (WebGL: the 10-bit export forces it) and WGSL
// (WebGPU: the preview and the 8-bit export prefer it) side by side so they
// cannot drift apart unnoticed.
//
// Algorithm: 3x3 cross unsharp on STRAIGHT (unpremultiplied) colour —
// out = centre + amount * ((centre - n) + (centre - s) + (centre - e) +
// (centre - w)) — which is the kernel `centre*(1 + 4a) - (n+s+e+w)*a` in its
// difference form, so its weights sum to 1 and DC is preserved. Alpha is
// carried through untouched (never convolved), and the output is
// re-premultiplied. Single pass, one tap per direction, no matte texture, no
// TexturePool interaction.
//
// LANDMINE: this file must remain valid plain JavaScript (no TS-only syntax,
// no imports) — the f16 parity gate (e2e/effects-f16-parity/index.html) loads
// it with fs.readFileSync + strip-`export ` + new Function. A unit test
// replays that loading path; type annotations here break the gate.

// Three things below are load-bearing, all three inherited from
// chromaKeySources.ts rather than rediscovered:
//
//  1. The `#version 300 es` line. Pixi's GlProgram only checks the FRAGMENT
//     text for that literal string to decide isES300; without it Pixi
//     macro-collapses `in`/`out`/`finalColor` down to WebGL1
//     (`varying`/`gl_FragColor`), which has no `textureLod`. The vertex source
//     needs no copy — Pixi applies the same isES300 flag to both stages.
//  2. `uInputSize` declared `highp` explicitly. It is shared with the vertex
//     stage, which Pixi always compiles highp, and a real ES-3.00 linker
//     requires matching precision for a uniform across stages. Redundant while
//     point 3 below holds — kept because it is the requirement, not a
//     consequence of the default, and it is what breaks first if the default
//     ever moves back.
//  3. `precision highp float;` on the fragment's first body line. Pixi injects
//     `precision mediump float;` ahead of it (its `preferredFragmentPrecision`
//     default) and a second precision statement is legal GLSL — the later one
//     wins for every declaration below it, `vTextureCoord` included. That
//     matters here and not in the chromakey sibling: this kernel taps ONE texel
//     away, and a 4K frame's texel is 1/3840 in UV — a quarter of fp16's
//     spacing near 0.5, so mediump interpolated UVs would land the tap between
//     texels and smear the kernel. Carried in the source string rather than
//     passed as a `GlProgram` option so it cannot be lost at a construction
//     site (the parity gate builds its own program from this text).
//  4. `uInputSize.zw` is the texel size Pixi hands every filter — 1 / the
//     input texture's dimensions. Deriving the tap offset from it is what
//     makes the result identical at Full / 1/2 / 1/4 preview and in the
//     export: filter intermediates are always allocated at resolution 1
//     (`Filter.defaultOptions.resolution`), so one texel is one composition
//     pixel everywhere. A hand-fed constant is the defect that disqualified
//     pixi-filters' ConvolutionFilter.
//
// Two things are this filter's own:
//
//  - Taps read STRAIGHT colour (`rgb / a`) and a tap with no alpha falls back
//    to the centre's, so the kernel degenerates to identity at a soft alpha
//    edge instead of dragging the sprite's transparent surround into the
//    negative lobes. That is the dark-fringe-on-text failure, and it is also
//    why no `padding` is set: edge behaviour comes from `uInputClamp`.
//  - The kernel is written as a sum of DIFFERENCES rather than
//    `centre*(1 + 4a) - sum*a`. The two are algebraically identical, but the
//    difference form subtracts nearby values (exact, by Sterbenz) and adds a
//    small correction to the centre, so on a constant region or a linear ramp
//    the correction is exactly zero and the pixel comes out bit-identical at
//    any precision. The expanded form would subtract two ~1.0-scale terms to
//    land on the same answer, and its rounding noise would read as banding the
//    pool never introduced. (Measured: the parity gate's f16 condition reports
//    `rampMaxDiff` of exactly 0 for this kernel on a smooth ramp.)
export const SHARPEN_FRAG_GL = `#version 300 es
precision highp float;

in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform vec4 uInputClamp;

uniform float uAmount;

// Straight (unpremultiplied) colour of one tap, clamped into the filter
// region so a tap can never read pooled residue outside it. A tap with no
// alpha carries no colour — fall back to the centre's, which zeroes that
// direction's contribution below.
vec3 tapStraight(vec2 uv, vec3 centre) {
    vec4 c = textureLod(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw), 0.0);
    if (c.a < 0.0001) return centre;
    return c.rgb / c.a;
}

void main() {
    vec4 src = textureLod(uTexture, vTextureCoord, 0.0);
    float amount = uAmount * 0.01;
    // Exact pass-through at the catalog default: the untouched texel, not the
    // unpremultiply/re-premultiply round trip of it.
    if (amount <= 0.0 || src.a < 0.0001) {
        finalColor = src;
        return;
    }

    vec3 centre = src.rgb / src.a;
    vec2 t = uInputSize.zw;
    vec3 detail = (centre - tapStraight(vTextureCoord + vec2(t.x, 0.0), centre))
        + (centre - tapStraight(vTextureCoord - vec2(t.x, 0.0), centre))
        + (centre - tapStraight(vTextureCoord + vec2(0.0, t.y), centre))
        + (centre - tapStraight(vTextureCoord - vec2(0.0, t.y), centre));

    // Clamped before re-premultiplying: an overshoot past 1.0 or an
    // undershoot below 0.0 is not signal worth keeping, and either one would
    // leave RGB outside [0, A] — not a valid premultiplied colour for the
    // blend that follows.
    vec3 sharp = clamp(centre + detail * amount, 0.0, 1.0);
    finalColor = vec4(sharp * src.a, src.a);
}
`;

/// WGSL twin of the GL source above (vertex boilerplate mirrors
/// node_modules/pixi.js/lib/filters/defaults/alpha/alpha.wgsl.mjs). Uses
/// textureSampleLevel (explicit LOD) like its chromakey sibling: the taps sit
/// under a non-uniform early-out, and an implicit-derivative sample there is
/// a uniformity-analysis hazard.
export const SHARPEN_WGSL = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};

struct SharpenUniforms {
  uAmount: f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@group(1) @binding(0) var<uniform> sharpenUniforms: SharpenUniforms;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return vec4<f32>(position, 0.0, 1.0);
}

fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
  return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
}

fn tapStraight(uv: vec2<f32>, centre: vec3<f32>) -> vec3<f32> {
  let cuv = clamp(uv, gfu.uInputClamp.xy, gfu.uInputClamp.zw);
  let c = textureSampleLevel(uTexture, uSampler, cuv, 0.0);
  if (c.a < 0.0001) { return centre; }
  return c.rgb / c.a;
}

@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSampleLevel(uTexture, uSampler, uv, 0.0);
  let amount = sharpenUniforms.uAmount * 0.01;
  if (amount <= 0.0 || src.a < 0.0001) {
    return src;
  }

  let centre = src.rgb / src.a;
  let t = gfu.uInputSize.zw;
  let detail = (centre - tapStraight(uv + vec2<f32>(t.x, 0.0), centre))
    + (centre - tapStraight(uv - vec2<f32>(t.x, 0.0), centre))
    + (centre - tapStraight(uv + vec2<f32>(0.0, t.y), centre))
    + (centre - tapStraight(uv - vec2<f32>(0.0, t.y), centre));

  let sharp = clamp(centre + detail * amount, vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(sharp * src.a, src.a);
}
`;

/// Uniform defaults — single source of truth for the filter constructor and
/// the gate's seed values. `uAmount` carries the catalog's PERCENTAGE (the
/// number on the slider); the shader does the /100, so the gate — which loads
/// this source but not the filter class — drives the same number the UI shows.
/// NOT the registry's param defaults, which are hard-coded there.
export const SHARPEN_UNIFORM_DEFAULTS = {
  uAmount: 0,
};
