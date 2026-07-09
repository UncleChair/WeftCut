// Chromakey shader sources — GLSL (WebGL: 10-bit export) and WGSL (WebGPU:
// preview + 8-bit export) side by side so they cannot drift apart unnoticed.
// Algorithm: color-difference (Vlahos) matte with Keylight-style screen
// balance → clip levels → nested shrink/feather (alpha recomputed at taps;
// single pass, no matte texture, no TexturePool interaction) → screen
// subtraction (output = premultiplied foreground) → despill + fixed neutral
// luma restore. Spec: docs/superpowers/specs/2026-07-09-chromakey-design.md.
//
// LANDMINE: this file must remain valid plain JavaScript (no TS-only syntax,
// no imports) — the f16 parity gate (e2e/effects-f16-parity/index.html) loads
// it with fs.readFileSync + strip-`export ` + new Function. A unit test
// replays that loading path; type annotations here break the gate.

/// Pixi v8 default filter vertex (verbatim from
/// node_modules/pixi.js/lib/filters/defaults/defaultFilter.vert.mjs) — the
/// gate needs it exported because pixi does not export it publicly.
export const CHROMA_VERT_GL = `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void )
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;

    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;

    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

// LANDMINE: the `#version 300 es` line is load-bearing, not decorative. Pixi's
// GlProgram only checks the FRAGMENT text for that literal string to decide
// isES300; without it, Pixi silently macro-collapses `in`/`out`/`finalColor`
// down to WebGL1 (`varying`/`gl_FragColor`) — which has no `textureLod`, so
// the shader fails to compile (caught by the f16 parity gate's first real
// WebGL run). The vertex source doesn't need its own copy: Pixi applies the
// same isES300 flag to both stages when assembling the final program.
// Also load-bearing: `uInputSize` below is declared `highp` explicitly
// because it's shared with the vertex stage, which Pixi always gives highp
// precision (this frag's other uniforms default to Pixi's mediump) — a real
// ES-3.00 linker requires matching precision for a uniform across stages;
// same fix as pixi's own displacement.frag.
export const CHROMA_FRAG_GL = `#version 300 es
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform highp vec4 uInputSize;
uniform vec4 uInputClamp;

uniform vec3 uKey;
uniform float uBalance;
uniform float uClipBlack;
uniform float uClipWhite;
uniform float uDespill;
uniform float uFeather;
uniform float uShrink;
uniform float uViewMatte;

float m3max(vec3 v) { return max(v.x, max(v.y, v.z)); }
float m3min(vec3 v) { return min(v.x, min(v.y, v.z)); }

// One-hot mask of the key's dominant channel (ties: g, then r).
vec3 domMask(vec3 k) {
    if (k.g >= k.r && k.g >= k.b) return vec3(0.0, 1.0, 0.0);
    if (k.r >= k.b) return vec3(1.0, 0.0, 0.0);
    return vec3(0.0, 0.0, 1.0);
}

// Vlahos color difference with screen balance: dominant channel minus a
// balance-weighted mix of the other two (max→min as uBalance goes 0→1).
// The +dom*2.0 trick excludes the dominant slot from the min.
float diffVsKey(vec3 c, vec3 dom) {
    float d = dot(c, dom);
    float omx = m3max(c * (vec3(1.0) - dom));
    float omn = m3min(c + dom * 2.0);
    return d - mix(omx, omn, uBalance);
}

float keyAlphaAt(vec2 uv, vec3 dom, float mKey) {
    vec3 px = textureLod(uTexture, clamp(uv, uInputClamp.xy, uInputClamp.zw), 0.0).rgb;
    float aRaw = 1.0 - diffVsKey(px, dom) / mKey;
    return clamp((aRaw - uClipBlack) / max(uClipWhite - uClipBlack, 0.0001), 0.0, 1.0);
}

float chokedAlphaAt(vec2 uv, vec3 dom, float mKey) {
    float c = keyAlphaAt(uv, dom, mKey);
    float r = abs(uShrink);
    if (r < 0.01) return c;
    vec2 t = uInputSize.zw * r;
    float a1 = keyAlphaAt(uv + vec2(t.x, 0.0), dom, mKey);
    float a2 = keyAlphaAt(uv - vec2(t.x, 0.0), dom, mKey);
    float a3 = keyAlphaAt(uv + vec2(0.0, t.y), dom, mKey);
    float a4 = keyAlphaAt(uv - vec2(0.0, t.y), dom, mKey);
    float lo = min(c, min(min(a1, a2), min(a3, a4)));
    float hi = max(c, max(max(a1, a2), max(a3, a4)));
    return uShrink < 0.0 ? lo : hi;
}

float matteAlphaAt(vec2 uv, vec3 dom, float mKey) {
    float c = chokedAlphaAt(uv, dom, mKey);
    if (uFeather < 0.01) return c;
    vec2 t = uInputSize.zw * uFeather;
    float sum = c
        + chokedAlphaAt(uv + vec2(t.x, 0.0), dom, mKey)
        + chokedAlphaAt(uv - vec2(t.x, 0.0), dom, mKey)
        + chokedAlphaAt(uv + vec2(0.0, t.y), dom, mKey)
        + chokedAlphaAt(uv - vec2(0.0, t.y), dom, mKey);
    return sum * 0.2;
}

void main() {
    vec4 src = textureLod(uTexture, vTextureCoord, 0.0);
    vec3 dom = domMask(uKey);
    float mKey = max(diffVsKey(uKey, dom), 0.0001);
    float alpha = matteAlphaAt(vTextureCoord, dom, mKey);

    if (uViewMatte > 0.5) {
        finalColor = vec4(alpha, alpha, alpha, 1.0);
        return;
    }

    // Screen subtraction: observed minus screen contribution IS the
    // premultiplied foreground — matches pixi's premultiplied convention.
    vec3 fg = max(src.rgb - uKey * (1.0 - alpha) * src.a, vec3(0.0));

    // Despill the dominant channel toward the mean of the other two, then
    // restore half the removed spill as neutral luma.
    float fd = dot(fg, dom);
    float omx = m3max(fg * (vec3(1.0) - dom));
    float omn = m3min(fg + dom * 2.0);
    float limit = 0.5 * (omx + omn);
    float spill = max(fd - limit, 0.0) * uDespill;
    fg -= dom * spill;
    float lumaW = dot(dom, vec3(0.2126, 0.7152, 0.0722));
    fg += vec3(spill * lumaW * 0.5);

    finalColor = vec4(fg, alpha * src.a);
}
`;

/// WGSL twin of the two GL sources above (vertex boilerplate mirrors
/// node_modules/pixi.js/lib/filters/defaults/alpha/alpha.wgsl.mjs). Uses
/// textureSampleLevel (explicit LOD) so taps under uniform branches carry no
/// uniformity-analysis hazard.
export const CHROMA_WGSL = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};

struct ChromaUniforms {
  uKey: vec3<f32>,
  uBalance: f32,
  uClipBlack: f32,
  uClipWhite: f32,
  uDespill: f32,
  uFeather: f32,
  uShrink: f32,
  uViewMatte: f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@group(1) @binding(0) var<uniform> chromaUniforms: ChromaUniforms;

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

fn m3max(v: vec3<f32>) -> f32 { return max(v.x, max(v.y, v.z)); }
fn m3min(v: vec3<f32>) -> f32 { return min(v.x, min(v.y, v.z)); }

fn domMask(k: vec3<f32>) -> vec3<f32> {
  if (k.g >= k.r && k.g >= k.b) { return vec3<f32>(0.0, 1.0, 0.0); }
  if (k.r >= k.b) { return vec3<f32>(1.0, 0.0, 0.0); }
  return vec3<f32>(0.0, 0.0, 1.0);
}

fn diffVsKey(c: vec3<f32>, dom: vec3<f32>) -> f32 {
  let d = dot(c, dom);
  let omx = m3max(c * (vec3<f32>(1.0) - dom));
  let omn = m3min(c + dom * 2.0);
  return d - mix(omx, omn, chromaUniforms.uBalance);
}

fn keyAlphaAt(uv: vec2<f32>, dom: vec3<f32>, mKey: f32) -> f32 {
  let cuv = clamp(uv, gfu.uInputClamp.xy, gfu.uInputClamp.zw);
  let px = textureSampleLevel(uTexture, uSampler, cuv, 0.0).rgb;
  let aRaw = 1.0 - diffVsKey(px, dom) / mKey;
  return clamp((aRaw - chromaUniforms.uClipBlack) / max(chromaUniforms.uClipWhite - chromaUniforms.uClipBlack, 0.0001), 0.0, 1.0);
}

fn chokedAlphaAt(uv: vec2<f32>, dom: vec3<f32>, mKey: f32) -> f32 {
  let c = keyAlphaAt(uv, dom, mKey);
  let r = abs(chromaUniforms.uShrink);
  if (r < 0.01) { return c; }
  let t = gfu.uInputSize.zw * r;
  let a1 = keyAlphaAt(uv + vec2<f32>(t.x, 0.0), dom, mKey);
  let a2 = keyAlphaAt(uv - vec2<f32>(t.x, 0.0), dom, mKey);
  let a3 = keyAlphaAt(uv + vec2<f32>(0.0, t.y), dom, mKey);
  let a4 = keyAlphaAt(uv - vec2<f32>(0.0, t.y), dom, mKey);
  let lo = min(c, min(min(a1, a2), min(a3, a4)));
  let hi = max(c, max(max(a1, a2), max(a3, a4)));
  if (chromaUniforms.uShrink < 0.0) { return lo; }
  return hi;
}

fn matteAlphaAt(uv: vec2<f32>, dom: vec3<f32>, mKey: f32) -> f32 {
  let c = chokedAlphaAt(uv, dom, mKey);
  if (chromaUniforms.uFeather < 0.01) { return c; }
  let t = gfu.uInputSize.zw * chromaUniforms.uFeather;
  let sum = c
    + chokedAlphaAt(uv + vec2<f32>(t.x, 0.0), dom, mKey)
    + chokedAlphaAt(uv - vec2<f32>(t.x, 0.0), dom, mKey)
    + chokedAlphaAt(uv + vec2<f32>(0.0, t.y), dom, mKey)
    + chokedAlphaAt(uv - vec2<f32>(0.0, t.y), dom, mKey);
  return sum * 0.2;
}

@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSampleLevel(uTexture, uSampler, uv, 0.0);
  let dom = domMask(chromaUniforms.uKey);
  let mKey = max(diffVsKey(chromaUniforms.uKey, dom), 0.0001);
  let alpha = matteAlphaAt(uv, dom, mKey);

  if (chromaUniforms.uViewMatte > 0.5) {
    return vec4<f32>(alpha, alpha, alpha, 1.0);
  }

  var fg = max(src.rgb - chromaUniforms.uKey * (1.0 - alpha) * src.a, vec3<f32>(0.0));

  let fd = dot(fg, dom);
  let omx = m3max(fg * (vec3<f32>(1.0) - dom));
  let omn = m3min(fg + dom * 2.0);
  let limit = 0.5 * (omx + omn);
  let spill = max(fd - limit, 0.0) * chromaUniforms.uDespill;
  fg = fg - dom * spill;
  let lumaW = dot(dom, vec3<f32>(0.2126, 0.7152, 0.0722));
  fg = fg + vec3<f32>(spill * lumaW * 0.5);

  return vec4<f32>(fg, alpha * src.a);
}
`;

/// Uniform defaults — single source of truth for the filter constructor
/// (Task 2), the registry param defaults (Task 3), and the gate (Task 5).
export const CHROMA_UNIFORM_DEFAULTS = {
  uKey: [0, 1, 0],
  uBalance: 0.5,
  uClipBlack: 0,
  uClipWhite: 1,
  uDespill: 1,
  uFeather: 0,
  uShrink: 0,
  uViewMatte: 0,
};
