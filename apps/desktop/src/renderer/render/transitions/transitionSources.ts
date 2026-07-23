// Transition shader sources — GLSL and WGSL side by side so the backends
// cannot drift apart unnoticed (same discipline as chromaKeySources.ts).
// One small fragment body per kind riding shared vertex + uniform plumbing:
// adding a kind (Wipe/Slide) means adding a `TRANSITION_SOURCES` entry —
// the node (TransitionNodes.ts) never changes.
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
/// Crossfade is the degenerate `mix()` case; both RTs are premultiplied
/// comp-space captures, so a straight mix is the correct alpha blend (no
/// mid-transition darkening on alpha content).
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
/// `up` = (0, −1). Crossfade (no direction) → (0, 0).
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
