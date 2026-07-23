// Transition shader sources — GLSL and WGSL side by side so the backends
// cannot drift apart unnoticed (same discipline as chromaKeySources.ts).
// One small fragment body per kind riding shared vertex + uniform plumbing:
// adding a kind means adding a `TRANSITION_SOURCES` entry — the node
// (TransitionNodes.ts) never changes.
//
// LANDMINE: `#version 300 es` must stay the FIRST line of the GL sources.
// Pixi's GlProgram only checks the fragment text for that literal to pick
// ES 3.0; without it `in`/`out`/`texture()` are macro-collapsed to WebGL1
// and the compile fails (full story: chromaKeySources.ts).

import type { TransitionSummary } from "../../ipc";

/// Mesh vertex — Pixi v8 mesh conventions (uProjectionMatrix /
/// uWorldTransformMatrix / uTransformMatrix), mirroring Nv12Ingest's VERT.
export const TRANSITION_GL_VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;

/// Shared GL fragment shell: both side textures + progress + motion
/// direction are declared for every kind (Crossfade ignores uDirection).
const glFragment = (body: string): string => `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uProgress;
uniform vec2 uDirection;
void main() {
${body}
}`;

// WGSL shell. Groups follow Pixi v8's mesh-shader convention (see
// Nv12Ingest's WGSL): globalUniforms@group(0) / localUniforms@group(1) are
// auto-bound by the mesh pipe via those exact variable names; our resources
// live in group(2), matched to the `resources` keys by name. Uniform order
// in `TransitionUniforms` must match the UniformGroup declaration order.
const wgsl = (body: string): string => /* wgsl */ `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}

struct TransitionUniforms {
  uDirection: vec2<f32>,
  uProgress: f32,
}

@group(0) @binding(0) var<uniform> globalUniforms : GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms : LocalUniforms;

@group(2) @binding(0) var uTexA: texture_2d<f32>;
@group(2) @binding(1) var uTexASampler: sampler;
@group(2) @binding(2) var uTexB: texture_2d<f32>;
@group(2) @binding(3) var uTexBSampler: sampler;
@group(2) @binding(4) var<uniform> transition : TransitionUniforms;

struct VSOutput {
  @builtin(position) vPosition: vec4<f32>,
  @location(0) vUV: vec2<f32>,
}

@vertex
fn mainVert(
  @location(0) aPosition: vec2<f32>,
  @location(1) aUV: vec2<f32>,
) -> VSOutput {
  let mvp = globalUniforms.uProjectionMatrix
    * globalUniforms.uWorldTransformMatrix
    * localUniforms.uTransformMatrix;
  return VSOutput(
    vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0),
    aUV,
  );
}

@fragment
fn mainFrag(
  @location(0) vUV: vec2<f32>,
) -> @location(0) vec4<f32> {
${body}
}`;

export interface TransitionShaderSource {
  glFragment: string;
  wgsl: string;
}

/// Per-kind fragment sources, keyed by the `TransitionKind` discriminant.
/// Crossfade is the degenerate `mix()` case; Wipe is a hard-edged boundary
/// select; Slide over-composites the moving incoming capture onto the static
/// outgoing one. Both RTs are premultiplied comp-space captures, so a
/// straight mix / hard select / premultiplied-over are the correct alpha
/// blends (no mid-transition darkening on alpha content).
///
/// Wipe and Slide each have a pure TS twin below (`wipeShowsIncoming` /
/// `slideSampleUv`) that the unit tests pin — change the shader math and the
/// twin together.
export const TRANSITION_SOURCES: Readonly<Record<string, TransitionShaderSource>> = {
  Crossfade: {
    glFragment: glFragment(
      `  vec4 a = texture(uTexA, vUV);
  vec4 b = texture(uTexB, vUV);
  finalColor = mix(a, b, uProgress);`,
    ),
    wgsl: wgsl(
      `  let a = textureSample(uTexA, uTexASampler, vUV);
  let b = textureSample(uTexB, uTexBSampler, vUV);
  return mix(a, b, vec4<f32>(transition.uProgress));`,
    ),
  },

  // Wipe — hard-edged reveal boundary sweeping the full frame along the
  // MOTION direction (uDirection, screen space, y down). Swept coordinate
  // t = dot(vUV - 0.5, uDirection) + 0.5 remaps the frame so t = 0 at the
  // edge the boundary starts from and t = 1 where the sweep ends, for all
  // four directions with one branchless expression ('left' = dir (-1, 0):
  // t = 1 - x, boundary at x = 1 - p). The swept region t <= uProgress
  // shows B; the boundary pixel (t == p exactly) belongs to B on BOTH
  // backends — GLSL and WGSL step(edge, x) both return 1.0 at x == edge.
  Wipe: {
    glFragment: glFragment(
      `  vec4 a = texture(uTexA, vUV);
  vec4 b = texture(uTexB, vUV);
  float t = dot(vUV - 0.5, uDirection) + 0.5;
  finalColor = mix(a, b, step(t, uProgress));`,
    ),
    wgsl: wgsl(
      `  let a = textureSample(uTexA, uTexASampler, vUV);
  let b = textureSample(uTexB, uTexBSampler, vUV);
  let t = dot(vUV - vec2<f32>(0.5), transition.uDirection) + 0.5;
  return mix(a, b, vec4<f32>(step(t, transition.uProgress)));`,
    ),
  },

  // Slide — incoming B glides in OVER static A along the MOTION direction.
  // Sample B at vUV + uDirection * (1 - uProgress): at p = 0 B's content is
  // displaced one full frame OPPOSITE its motion (fully offscreen at the
  // entry edge), reaching identity at p = 1 ('left' = dir (-1, 0): content
  // displaced (1 - p) x frame in +x, entering from the right edge).
  // LANDMINE: out-of-range samples must be TRANSPARENT — the RT sampler
  // clamps, which would smear B's edge pixels across the frame — so the
  // shifted UV is bounds-tested in-shader ([0, 1] inclusive on both
  // backends) and the sample zeroed. Where B is absent/transparent, A shows
  // through via the premultiplied over-composite b + a * (1 - b.a).
  Slide: {
    glFragment: glFragment(
      `  vec2 uvB = vUV + uDirection * (1.0 - uProgress);
  vec2 inRange = step(vec2(0.0), uvB) * step(uvB, vec2(1.0));
  vec4 b = texture(uTexB, uvB) * (inRange.x * inRange.y);
  vec4 a = texture(uTexA, vUV);
  finalColor = b + a * (1.0 - b.a);`,
    ),
    wgsl: wgsl(
      `  let uvB = vUV + transition.uDirection * (1.0 - transition.uProgress);
  let inRange = step(vec2<f32>(0.0), uvB) * step(uvB, vec2<f32>(1.0));
  let b = textureSample(uTexB, uTexBSampler, uvB) * (inRange.x * inRange.y);
  let a = textureSample(uTexA, uTexASampler, vUV);
  return b + a * (1.0 - b.a);`,
    ),
  },
};

/// Sources for `kindName`, falling back to Crossfade for a kind with no
/// shader yet (`isFallback` lets the node warn once).
export function shaderSourceFor(kindName: string): {
  source: TransitionShaderSource;
  isFallback: boolean;
} {
  const source = TRANSITION_SOURCES[kindName];
  if (source) return { source, isFallback: false };
  return { source: TRANSITION_SOURCES.Crossfade!, isFallback: true };
}

/// Motion-direction unit vector in composition screen space (y grows down):
/// direction means where the incoming content MOVES TOWARD — `left` = (−1, 0),
/// `up` = (0, −1). Crossfade (no direction) → (0, 0). ONE vector serves both
/// kinds: Wipe reads it as the boundary's sweep axis, Slide as the sampling
/// offset that walks B in along its motion.
export function directionVector(kind: TransitionSummary["kind"]): [number, number] {
  const d = "direction" in kind ? kind.direction : null;
  switch (d) {
    case "left":
      return [-1, 0];
    case "right":
      return [1, 0];
    case "up":
      return [0, -1];
    case "down":
      return [0, 1];
    default:
      return [0, 0];
  }
}

// Pure TS twins of the Wipe / Slide fragment math, exported so the unit
// tests can pin the semantics (boundary convention, direction handedness)
// without a GL context. LANDMINE: each must mirror its shader bodies above
// EXACTLY — the tests also string-pin the shader expressions, so changing
// either side without the other fails fast.

/// Wipe twin: does the pixel at `uv` show the incoming side (B)?
/// t = dot(uv - 0.5, dir) + 0.5 is the position along the motion axis,
/// 0 at the boundary's starting edge, 1 where the sweep ends; the swept
/// region t <= progress shows B (boundary pixel inclusive to B, matching
/// step()'s x >= edge on both backends).
export function wipeShowsIncoming(
  uv: readonly [number, number],
  direction: readonly [number, number],
  progress: number,
): boolean {
  const t = (uv[0] - 0.5) * direction[0] + (uv[1] - 0.5) * direction[1] + 0.5;
  return t <= progress;
}

/// Slide twin: where B is sampled for the pixel at `uv`, and whether that
/// sample is in range ([0, 1]² inclusive) — out of range renders B
/// transparent, letting A show through the over-composite.
export function slideSampleUv(
  uv: readonly [number, number],
  direction: readonly [number, number],
  progress: number,
): { uv: [number, number]; inRange: boolean } {
  const x = uv[0] + direction[0] * (1 - progress);
  const y = uv[1] + direction[1] * (1 - progress);
  return { uv: [x, y], inRange: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}
