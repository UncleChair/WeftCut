# Chromakey v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `chromakey` effect (color-difference / Vlahos-family keyer with screen balance, screen subtraction, despill, and single-pass shrink/feather) to the effects catalog.

**Architecture:** One custom Pixi v8 `Filter` — the repo's first non-stock filter — with WGSL + GLSL sources in a shared constants module, registered as one `effectRegistry.ts` entry. UI param rows, keyframes, undo, and MCP `add_effect` are data-driven off the registry and need zero changes. Spec: `docs/superpowers/specs/2026-07-09-chromakey-design.md`.

**Tech Stack:** pixi.js ^8.18.1 (`Filter`, `GlProgram`, `GpuProgram`, `UniformGroup`), Vitest (unit), Playwright `_electron` (e2e), the local f16 parity gate (`apps/desktop/e2e/effects-f16-parity/`).

## Global Constraints

- Working directory for all npm commands: `apps/desktop` (repo root `C:\Users\jonny\Desktop\learning\videtor`).
- All effect params are scalar `number` (`Animated<f64>`); no color/bool param types exist. Key color = 3 scalars `keyR/keyG/keyB` (spec decision).
- `colorspace: "display-gamma"` — all shader math on gamma-encoded BT.709 in [0,1].
- `fidelity` starts `"precision-reduced"`; flips to `"f16-verified"` ONLY after the f16 parity gate passes (Task 5, same branch).
- `chromaKeySources.ts` must contain **no TS-only syntax** (no type annotations) — the f16 gate evals it as plain JS after stripping `export `. A unit test enforces this.
- Never call `TexturePool.clear(true)`; the new filter must NOT allocate extra render targets (single-pass by design).
- Do NOT port shader code from OBS/Natron/other GPL sources — implement only the math in this plan.
- The user edits this checkout in parallel sessions: `git add` **explicit paths only**, re-check `git status --short` before each commit, never `git add -A`.
- Commit messages: conventional commits, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- e2e requires a fresh instrumented build: `VITE_WEFTCUT_E2E=1 npm run build` (PowerShell: `$env:VITE_WEFTCUT_E2E='1'; npm run build`). A stale `out/` bundle makes new-feature e2es fail while old ones pass — always rebuild after renderer changes. Don't run the dev app while building or running e2e.
- Unit tests: `npx vitest run <file>` (if `@weftcut/eval` wasm is missing locally, run `npm run build:wasm` once first).

---

## The algorithm (reference for Tasks 1–2)

Single pass, per fragment. `key = (keyR, keyG, keyB)`, `dom` = one-hot mask of key's largest channel, gamma-encoded values in [0,1]:

1. `diffVsKey(c) = c[dom] − mix(max(c[a],c[b]), min(c[a],c[b]), balance)` — Keylight-style screen balance (0 = conservative `max`, 1 = aggressive `min`, 0.5 default).
2. `alphaRaw = 1 − diffVsKey(px) / max(diffVsKey(key), ε)`; levels: `alpha = clamp((alphaRaw − clipBlack) / max(clipWhite − clipBlack, ε), 0, 1)`.
3. Shrink (5-tap cross min/max at |shrink| texels) nested inside feather (5-tap cross average at feather texels); alpha recomputed at taps — worst case 25 evaluations, pure ALU + `textureLod`/`textureSampleLevel` (no derivative/uniformity hazards). Zero radius collapses to center tap.
4. Screen subtraction: `fg = max(px.rgb − key × (1 − alpha) × srcA, 0)` — result IS the premultiplied foreground; output alpha `alpha × srcA`.
5. Despill: `limit = mean(fg[a], fg[b])`, `spill = max(fg[dom] − limit, 0) × despill`, subtract from dominant channel, restore `spill × lumaWeight[dom] × 0.5` as neutral luma (Rec.709 weights).
6. `viewMatte > 0.5` → output `(alpha, alpha, alpha, 1)` (after step 3, before 4–5).

---

### Task 1: Shader sources module + drift/gate-contract tests

**Files:**
- Create: `apps/desktop/src/renderer/render/effects/filters/chromaKeySources.ts`
- Test: `apps/desktop/src/renderer/render/effects/filters/chromaKeySources.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (imported by Tasks 2 & 5): `CHROMA_VERT_GL: string`, `CHROMA_FRAG_GL: string`, `CHROMA_WGSL: string` (vertex+fragment, entry points `mainVertex`/`mainFragment`), `CHROMA_UNIFORM_DEFAULTS` = `{ uKey: [0,1,0], uBalance: 0.5, uClipBlack: 0, uClipWhite: 1, uDespill: 1, uFeather: 0, uShrink: 0, uViewMatte: 0 }`.

- [ ] **Step 1: Write the failing test**

`chromaKeySources.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CHROMA_FRAG_GL,
  CHROMA_VERT_GL,
  CHROMA_WGSL,
  CHROMA_UNIFORM_DEFAULTS,
} from "./chromaKeySources";

describe("chromaKeySources", () => {
  it("every uniform appears in BOTH fragment sources (dual-source drift guard)", () => {
    for (const name of Object.keys(CHROMA_UNIFORM_DEFAULTS)) {
      expect(CHROMA_FRAG_GL, `GLSL missing ${name}`).toContain(name);
      expect(CHROMA_WGSL, `WGSL missing ${name}`).toContain(name);
    }
  });

  it("WGSL carries both entry points; GL vertex is the pixi filter vertex", () => {
    expect(CHROMA_WGSL).toContain("mainVertex");
    expect(CHROMA_WGSL).toContain("mainFragment");
    expect(CHROMA_VERT_GL).toContain("filterVertexPosition");
  });

  it("stays loadable by the f16 gate's strip-export eval (no TS-only syntax)", () => {
    const text = readFileSync(
      fileURLToPath(new URL("./chromaKeySources.ts", import.meta.url)),
      "utf8",
    ).replace(/^export /gm, "");
    const mod = new Function(
      text + "\nreturn { CHROMA_FRAG_GL, CHROMA_UNIFORM_DEFAULTS };",
    )();
    expect(mod.CHROMA_FRAG_GL).toBe(CHROMA_FRAG_GL);
    expect(mod.CHROMA_UNIFORM_DEFAULTS).toEqual(CHROMA_UNIFORM_DEFAULTS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/desktop`): `npx vitest run src/renderer/render/effects/filters/chromaKeySources.test.ts`
Expected: FAIL — cannot resolve `./chromaKeySources`.

- [ ] **Step 3: Write the sources module**

`chromaKeySources.ts` — **entire file** (note the header landmine comment; keep this file free of type annotations forever):

```ts
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

export const CHROMA_FRAG_GL = `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform vec4 uInputSize;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/render/effects/filters/chromaKeySources.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/effects/filters/chromaKeySources.ts apps/desktop/src/renderer/render/effects/filters/chromaKeySources.test.ts
git commit -m "feat(effects): chromakey shader sources (GLSL+WGSL) with drift guards"
```

---

### Task 2: ChromaKeyFilter class

**Files:**
- Create: `apps/desktop/src/renderer/render/effects/filters/ChromaKeyFilter.ts`
- Test: `apps/desktop/src/renderer/render/effects/filters/ChromaKeyFilter.test.ts`

**Interfaces:**
- Consumes: `CHROMA_VERT_GL`, `CHROMA_FRAG_GL`, `CHROMA_WGSL`, `CHROMA_UNIFORM_DEFAULTS` from `./chromaKeySources`.
- Produces (used by Task 3): `type ChromaParamName = "keyR" | "keyG" | "keyB" | "balance" | "clipBlack" | "clipWhite" | "despill" | "feather" | "shrink" | "viewMatte"`; `class ChromaKeyFilter extends Filter` with `constructor()` (no args) and `applyParam(name: ChromaParamName, value: number): void`.

- [ ] **Step 1: Write the failing test**

`ChromaKeyFilter.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ChromaKeyFilter, type ChromaParamName } from "./ChromaKeyFilter";
import { CHROMA_UNIFORM_DEFAULTS } from "./chromaKeySources";

function uniforms(f: ChromaKeyFilter): Record<string, number | Float32Array> {
  return (f.resources as Record<string, { uniforms: Record<string, number | Float32Array> }>)
    .chromaUniforms!.uniforms;
}

describe("ChromaKeyFilter", () => {
  it("constructs with spec defaults (green key, balance 0.5)", () => {
    const f = new ChromaKeyFilter();
    const u = uniforms(f);
    expect(Array.from(u.uKey as Float32Array)).toEqual(CHROMA_UNIFORM_DEFAULTS.uKey);
    expect(u.uBalance).toBe(0.5);
    expect(u.uClipWhite).toBe(1);
    expect(u.uDespill).toBe(1);
    expect(u.uViewMatte).toBe(0);
  });

  it("applyParam maps every catalog param onto its uniform", () => {
    const f = new ChromaKeyFilter();
    const cases: Array<[ChromaParamName, () => number]> = [
      ["keyR", () => (uniforms(f).uKey as Float32Array)[0]!],
      ["keyG", () => (uniforms(f).uKey as Float32Array)[1]!],
      ["keyB", () => (uniforms(f).uKey as Float32Array)[2]!],
      ["balance", () => uniforms(f).uBalance as number],
      ["clipBlack", () => uniforms(f).uClipBlack as number],
      ["clipWhite", () => uniforms(f).uClipWhite as number],
      ["despill", () => uniforms(f).uDespill as number],
      ["feather", () => uniforms(f).uFeather as number],
      ["shrink", () => uniforms(f).uShrink as number],
      ["viewMatte", () => uniforms(f).uViewMatte as number],
    ];
    cases.forEach(([name, read], i) => {
      const v = 0.125 + i * 0.0625;
      f.applyParam(name, v);
      expect(read(), `param ${name}`).toBeCloseTo(v, 5);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/render/effects/filters/ChromaKeyFilter.test.ts`
Expected: FAIL — cannot resolve `./ChromaKeyFilter`.

- [ ] **Step 3: Write the filter class**

`ChromaKeyFilter.ts` — **entire file** (constructor pattern mirrors pixi's own `AlphaFilter`):

```ts
// Chroma key: the repo's first custom (non-stock) Pixi filter. Shader math
// lives in chromaKeySources.ts (shared with the f16 parity gate); this class
// is the pixi plumbing — dual program + uniform group + the scalar-param
// glue the effect registry drives every frame.

import { Filter, GlProgram, GpuProgram, UniformGroup } from "pixi.js";
import {
  CHROMA_FRAG_GL,
  CHROMA_VERT_GL,
  CHROMA_WGSL,
  CHROMA_UNIFORM_DEFAULTS,
} from "./chromaKeySources";

export type ChromaParamName =
  | "keyR"
  | "keyG"
  | "keyB"
  | "balance"
  | "clipBlack"
  | "clipWhite"
  | "despill"
  | "feather"
  | "shrink"
  | "viewMatte";

interface ChromaUniforms {
  uKey: Float32Array;
  uBalance: number;
  uClipBlack: number;
  uClipWhite: number;
  uDespill: number;
  uFeather: number;
  uShrink: number;
  uViewMatte: number;
}

export class ChromaKeyFilter extends Filter {
  constructor() {
    const d = CHROMA_UNIFORM_DEFAULTS;
    const gpuProgram = GpuProgram.from({
      vertex: { source: CHROMA_WGSL, entryPoint: "mainVertex" },
      fragment: { source: CHROMA_WGSL, entryPoint: "mainFragment" },
    });
    const glProgram = GlProgram.from({
      vertex: CHROMA_VERT_GL,
      fragment: CHROMA_FRAG_GL,
      name: "chromakey-filter",
    });
    super({
      gpuProgram,
      glProgram,
      resources: {
        chromaUniforms: new UniformGroup({
          uKey: { value: new Float32Array(d.uKey), type: "vec3<f32>" },
          uBalance: { value: d.uBalance, type: "f32" },
          uClipBlack: { value: d.uClipBlack, type: "f32" },
          uClipWhite: { value: d.uClipWhite, type: "f32" },
          uDespill: { value: d.uDespill, type: "f32" },
          uFeather: { value: d.uFeather, type: "f32" },
          uShrink: { value: d.uShrink, type: "f32" },
          uViewMatte: { value: d.uViewMatte, type: "f32" },
        }),
      },
    });
  }

  applyParam(name: ChromaParamName, value: number): void {
    const u = (this.resources as { chromaUniforms: { uniforms: ChromaUniforms } })
      .chromaUniforms.uniforms;
    switch (name) {
      case "keyR": u.uKey[0] = value; break;
      case "keyG": u.uKey[1] = value; break;
      case "keyB": u.uKey[2] = value; break;
      case "balance": u.uBalance = value; break;
      case "clipBlack": u.uClipBlack = value; break;
      case "clipWhite": u.uClipWhite = value; break;
      case "despill": u.uDespill = value; break;
      case "feather": u.uFeather = value; break;
      case "shrink": u.uShrink = value; break;
      case "viewMatte": u.uViewMatte = value; break;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/render/effects/filters/ChromaKeyFilter.test.ts`
Expected: PASS (2 tests). A failure inside `GpuProgram.from` means a WGSL syntax error in `CHROMA_WGSL` (pixi parses the struct/bindings at construction) — fix the source, not the test.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/render/effects/filters/ChromaKeyFilter.ts apps/desktop/src/renderer/render/effects/filters/ChromaKeyFilter.test.ts
git commit -m "feat(effects): ChromaKeyFilter — dual-program pixi filter with scalar param glue"
```

---

### Task 3: Registry entry + i18n + MCP catalog string

**Files:**
- Modify: `apps/desktop/src/renderer/render/effects/effectRegistry.ts`
- Modify: `apps/desktop/src/renderer/i18n/locales/en-US.ts` (effects block ~line 528)
- Modify: `apps/desktop/src/renderer/i18n/locales/zh-CN.ts` (effects block ~line 514)
- Modify: `apps/desktop/src/main/state/mcp-commands.ts:362` (add_effect description)
- Test: `apps/desktop/src/renderer/render/effects/effectRegistry.test.ts`

**Interfaces:**
- Consumes: `ChromaKeyFilter`, `ChromaParamName` from `./filters/ChromaKeyFilter`.
- Produces: registry kind `"chromakey"` (10 params, order `keyR, keyG, keyB, balance, clipBlack, clipWhite, despill, feather, shrink, viewMatte`), i18n keys `effects.chromakey.name` + `effects.chromakey.params.*`.

- [ ] **Step 1: Write the failing tests** — append to `effectRegistry.test.ts`:

```ts
describe("chromakey", () => {
  it("descriptor builds a ChromaKeyFilter and routes params to uniforms", () => {
    const d = getDescriptor("chromakey")!;
    expect(d.fidelity).toBe("precision-reduced"); // flips to f16-verified in the gate task
    expect(d.nameI18nKey).toBe("effects.chromakey.name");
    const f = d.create();
    expect(f).toBeInstanceOf(ChromaKeyFilter);
    d.params.keyR!.apply(f, 0.25);
    d.params.balance!.apply(f, 0.9);
    const u = (f.resources as Record<string, { uniforms: Record<string, unknown> }>)
      .chromaUniforms!.uniforms;
    expect((u.uKey as Float32Array)[0]).toBeCloseTo(0.25);
    expect(u.uBalance).toBeCloseTo(0.9);
  });

  it("carries the 10 spec params, in spec order, with spec defaults", () => {
    const d = getDescriptor("chromakey")!;
    expect(Object.keys(d.params)).toEqual([
      "keyR", "keyG", "keyB", "balance", "clipBlack",
      "clipWhite", "despill", "feather", "shrink", "viewMatte",
    ]);
    expect(d.params.keyG!.default).toBe(1);
    expect(d.params.balance!.default).toBe(0.5);
    expect(d.params.clipWhite!.default).toBe(1);
    expect(d.params.despill!.default).toBe(1);
    expect(d.params.shrink!.range).toEqual([-5, 5]);
    expect(d.params.feather!.range).toEqual([0, 10]);
  });
});
```

Add the import at the top of the test file: `import { ChromaKeyFilter } from "./filters/ChromaKeyFilter";`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/render/effects/effectRegistry.test.ts`
Expected: FAIL — `getDescriptor("chromakey")` returns null.

- [ ] **Step 3: Add the registry entry**

In `effectRegistry.ts`, add the import and a `chromakey` entry after `blur` inside `REGISTRY`:

```ts
import { ChromaKeyFilter, type ChromaParamName } from "./filters/ChromaKeyFilter";
```

```ts
  chromakey: {
    kind: "chromakey",
    nameI18nKey: "effects.chromakey.name",
    create: () => new ChromaKeyFilter(),
    params: (() => {
      const p = (name: ChromaParamName, def: number, range: [number, number], step: number) => ({
        default: def,
        range,
        step,
        apply: (f: Filter, v: number) => (f as ChromaKeyFilter).applyParam(name, v),
      });
      return {
        keyR: p("keyR", 0, [0, 1], 0.01),
        keyG: p("keyG", 1, [0, 1], 0.01),
        keyB: p("keyB", 0, [0, 1], 0.01),
        balance: p("balance", 0.5, [0, 1], 0.01),
        clipBlack: p("clipBlack", 0, [0, 1], 0.01),
        clipWhite: p("clipWhite", 1, [0, 1], 0.01),
        despill: p("despill", 1, [0, 1], 0.01),
        feather: p("feather", 0, [0, 10], 0.5),
        shrink: p("shrink", 0, [-5, 5], 0.5),
        viewMatte: p("viewMatte", 0, [0, 1], 1),
      };
    })(),
    fidelity: "precision-reduced",
    colorspace: "display-gamma",
  },
```

- [ ] **Step 4: Add i18n blocks**

In `en-US.ts`, inside the existing `effects:` object after the `blur` sub-block:

```ts
    chromakey: {
      name: "Chroma Key",
      params: {
        keyR: "Key red",
        keyG: "Key green",
        keyB: "Key blue",
        balance: "Screen balance",
        clipBlack: "Clip black",
        clipWhite: "Clip white",
        despill: "Despill",
        feather: "Feather",
        shrink: "Shrink",
        viewMatte: "View matte",
      },
    },
```

In `zh-CN.ts`, same position:

```ts
    chromakey: {
      name: "色度抠像",
      params: {
        keyR: "键色红",
        keyG: "键色绿",
        keyB: "键色蓝",
        balance: "屏幕平衡",
        clipBlack: "黑场裁剪",
        clipWhite: "白场裁剪",
        despill: "溢色抑制",
        feather: "羽化",
        shrink: "收扩边",
        viewMatte: "查看遮罩",
      },
    },
```

- [ ] **Step 5: Update the MCP catalog string**

In `mcp-commands.ts:362`, change `` `kind` is the catalog key (v1: "blur"). `` to `` `kind` is the catalog key ("blur", "chromakey"). `` — the description only; schema and parseArgs stay untouched (kind is already permissive).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/renderer/render/effects/effectRegistry.test.ts`
Expected: PASS (all, including the pre-existing blur tests).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/render/effects/effectRegistry.ts apps/desktop/src/renderer/render/effects/effectRegistry.test.ts apps/desktop/src/renderer/i18n/locales/en-US.ts apps/desktop/src/renderer/i18n/locales/zh-CN.ts apps/desktop/src/main/state/mcp-commands.ts
git commit -m "feat(effects): register chromakey in the catalog (10 params, en/zh labels)"
```

---

### Task 4: e2e smoke test

**Files:**
- Modify: `apps/desktop/e2e/electron/effects-smoke.spec.ts` (append one test — reuses the file-local `connectMcp`, `effectsOf`, `sampleAt` helpers and existing imports)

**Interfaces:**
- Consumes: registry kind `"chromakey"` (Task 3); MCP tools `add_effect`, `update_effect`, `undo`; helpers `launchApp`, `newProject`, `invokeCmd`, `summary` from `./helpers/driver`.
- Produces: nothing downstream; this is the behavioral gate.

- [ ] **Step 1: Append the test** to `effects-smoke.spec.ts`:

```ts
test('effects: chromakey keys out a green color layer; viewMatte previews the matte', async () => {
  test.skip(
    process.env.WEFTCUT_E2E_NO_EXPORT === '1',
    'pixel sampling needs a real GPU not on headless CI; verified locally',
  )
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'weftcut-chromakey-smoke-'))
  await newProject(page, {
    parentFolder: parent,
    name: 'chromakey-smoke',
    canvas: { width: 640, height: 360, fpsNum: 30, fpsDen: 1 },
  })

  // Full-frame green screen + a white text layer on a second track.
  const bgTrack = await invokeCmd<string>(page, 'add_track', {})
  const bgId = await invokeCmd<string>(page, 'add_color_layer', {
    trackId: bgTrack,
    color: { r: 0, g: 1, b: 0, a: 1 },
    tStartUs: 0,
    durationUs: 2_000_000,
  })
  const fgTrack = await invokeCmd<string>(page, 'add_track', {})
  await invokeCmd<string>(page, 'add_text_layer', {
    trackId: fgTrack,
    content: 'CHROMA',
    tStartUs: 0,
    durationUs: 2_000_000,
  })

  // Baseline: bottom-right corner is green (also validates the Rgba scale —
  // if this reads black, add_color_layer took the color as 0..255).
  const before = await sampleAt(page, 500_000, 600, 340)
  expect(before.g).toBeGreaterThan(200)
  expect(before.r).toBeLessThan(60)
  expect(before.a).toBe(255)
  const FULL = 640 * 360
  expect(before.nonTransparent).toBe(FULL)

  // Key the background via real MCP.
  const info = (await page.evaluate(() => (window as any).api.mcp.getInfo())) as McpInfo
  const mcp = await connectMcp(info)
  const addRes = await mcp.callTool({ name: 'add_effect', arguments: { layer_id: bgId, kind: 'chromakey' } })
  const effectId = JSON.parse(JSON.stringify(addRes.content))[0].text as string
  expect(effectId.length).toBeGreaterThan(0)

  const keyed = await sampleAt(page, 500_000, 600, 340)
  expect(keyed.a).toBe(0) // green screen fully keyed at the corner
  expect(keyed.nonTransparent).toBeGreaterThan(0) // text survives
  expect(keyed.nonTransparent).toBeLessThan(FULL * 0.25)

  // viewMatte=1 → whole bg layer outputs (alpha,alpha,alpha,1): opaque black at the corner.
  await mcp.callTool({ name: 'update_effect', arguments: {
    layer_id: bgId, effect_id: effectId,
    patch: { params: { viewMatte: { mode: 'Static', value: 1 } } },
  } })
  const matte = await sampleAt(page, 500_000, 600, 340)
  expect(matte.a).toBe(255)
  expect(matte.r).toBeLessThan(10)
  expect(matte.g).toBeLessThan(10)
  expect(matte.nonTransparent).toBe(FULL)

  // Undo the param patch and the add — chain must empty.
  await mcp.callTool({ name: 'undo', arguments: {} })
  await mcp.callTool({ name: 'undo', arguments: {} })
  await page.waitForTimeout(800)
  const s = await summary(page)
  const fx = effectsOf(s as any, bgId) as Array<{ kind: string }>
  expect(fx).toHaveLength(0)
  const restored = await sampleAt(page, 500_000, 600, 340)
  expect(restored.g).toBeGreaterThan(200)

  await app.close()
})
```

Teardown is a bare `await app.close()` at the end — this matches the file's existing tests exactly (they use no try/finally).

- [ ] **Step 2: Rebuild with the e2e hooks** (MANDATORY — stale `out/` mimics real failures)

```bash
VITE_WEFTCUT_E2E=1 npm run build
```
PowerShell: `$env:VITE_WEFTCUT_E2E='1'; npm run build; Remove-Item Env:\VITE_WEFTCUT_E2E`

- [ ] **Step 3: Run the new test**

Run: `npm run e2e:electron -- -g "chromakey"`
Expected: PASS. If the baseline-green assertion fails (corner reads black), `add_color_layer` took `color` as 0–255 — change to `{ r: 0, g: 255, b: 0, a: 255 }` and re-run.

- [ ] **Step 4: Run the whole effects suite to check for regressions**

Run: `npm run e2e:electron -- effects-smoke.spec.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/e2e/electron/effects-smoke.spec.ts
git commit -m "test(e2e): chromakey smoke — keys green bg, viewMatte, undo"
```

---

### Task 5: f16 parity gate phase + fidelity flip

**Files:**
- Modify: `apps/desktop/e2e/effects-f16-parity/index.html` (add chroma phase after the blur phase)
- Modify: `apps/desktop/e2e/effects-f16-parity/run.mjs` (assert the chroma phase; update header comment)
- Modify: `apps/desktop/src/renderer/render/effects/effectRegistry.ts` (fidelity flip)
- Modify: `apps/desktop/src/renderer/render/effects/effectRegistry.test.ts` (expectation flip)

**Interfaces:**
- Consumes: `chromaKeySources.ts` via the strip-export eval contract (Task 1 test guards it); gray gradient + green key ⇒ mathematical pass-through, so the distinct-count assertions are identical to blur's.
- Produces: `chromakey` registry entry advertises `fidelity: "f16-verified"`.

- [ ] **Step 1: Add the chroma phase to `index.html`** — insert between the blur `phase(...)` call (line ~106) and `ipcRenderer.send("gate-result", out)`:

```js
          // Chromakey pass-through: gray gradient vs green key → alpha 1
          // everywhere, output == input, so the same distinct-count math
          // applies. Loads the REAL product shader sources (the sources file
          // is type-annotation-free JS by contract; a unit test replays this
          // exact loading path).
          const fsMod = require("fs");
          const pathMod = require("path");
          const srcText = fsMod
            .readFileSync(pathMod.resolve(__dirname, "../../src/renderer/render/effects/filters/chromaKeySources.ts"), "utf8")
            .replace(/^export /gm, "");
          const S = new Function(srcText + "\nreturn { CHROMA_VERT_GL, CHROMA_FRAG_GL, CHROMA_UNIFORM_DEFAULTS };")();
          const { Filter, GlProgram, UniformGroup } = PIXI;
          const cd = S.CHROMA_UNIFORM_DEFAULTS;
          const chromaFilter = new Filter({
            glProgram: GlProgram.from({ vertex: S.CHROMA_VERT_GL, fragment: S.CHROMA_FRAG_GL, name: "chromakey-gate" }),
            resources: {
              chromaUniforms: new UniformGroup({
                uKey: { value: new Float32Array(cd.uKey), type: "vec3<f32>" },
                uBalance: { value: cd.uBalance, type: "f32" },
                uClipBlack: { value: cd.uClipBlack, type: "f32" },
                uClipWhite: { value: cd.uClipWhite, type: "f32" },
                uDespill: { value: cd.uDespill, type: "f32" },
                uFeather: { value: cd.uFeather, type: "f32" },
                uShrink: { value: cd.uShrink, type: "f32" },
                uViewMatte: { value: cd.uViewMatte, type: "f32" },
              }),
            },
          });
          const chromaRT = RenderTexture.create({ width: W, height: H, format: "rgba16float" });
          const chromaStage = new Container();
          const chromaSp = new Sprite(srcRT);
          chromaSp.filters = [chromaFilter];
          chromaStage.addChild(chromaSp);
          renderer.render({ container: chromaStage, target: chromaRT });
          phase("chroma", () => readRed(chromaRT, "chroma-passthrough"));
```

- [ ] **Step 2: Assert the chroma phase in `run.mjs`** — replace the two assertion blocks (lines 87–107) with a loop over both filters:

```js
// --- Condition A: default pool ---
const defaultResult = runCondition(false);
// --- Condition B: f16 pool ---
const f16Result = runCondition(true);

const DEFAULT_THRESHOLD = 260;
const F16_THRESHOLD = 900;

for (const filterPhase of ["blur", "chroma"]) {
  const distinctDefault = defaultResult.phases?.[filterPhase]?.distinct ?? -1;
  if (distinctDefault <= DEFAULT_THRESHOLD && distinctDefault > 0) {
    console.log(`[f16-parity] PASS default-pool ${filterPhase}: distinct=${distinctDefault} <= ${DEFAULT_THRESHOLD} (bands as expected)`);
  } else {
    console.error(`[f16-parity] FAIL default-pool ${filterPhase}: distinct=${distinctDefault} — expected banding in (0, ${DEFAULT_THRESHOLD}]`);
    failed = true;
  }

  const distinctF16 = f16Result.phases?.[filterPhase]?.distinct ?? -1;
  if (distinctF16 > F16_THRESHOLD) {
    console.log(`[f16-parity] PASS f16-pool ${filterPhase}: distinct=${distinctF16} > ${F16_THRESHOLD} (precision preserved)`);
  } else {
    console.error(`[f16-parity] FAIL f16-pool ${filterPhase}: distinct=${distinctF16} <= ${F16_THRESHOLD} — pool bump not preserving precision`);
    failed = true;
  }
}
```

Also update the "What it checks" header comment (lines 17–25) to mention both filters, e.g. "BlurFilter and the chromakey pass-through through an 8-bit / f16 pool intermediate".

- [ ] **Step 3: Run the gate**

Run (from repo root): `node apps/desktop/e2e/effects-f16-parity/run.mjs`
Expected: `GATE PASSED` with four PASS lines (blur/chroma × default/f16). A `GATE_ERROR` mentioning shader compilation means a GLSL error in `CHROMA_FRAG_GL` — this is the first real WebGL compile of that source; fix the shader in `chromaKeySources.ts` (Task 1's tests still apply).

- [ ] **Step 4: Flip the fidelity flag** — in `effectRegistry.ts` change the chromakey entry's `fidelity: "precision-reduced"` to `fidelity: "f16-verified"`, and in `effectRegistry.test.ts` change the expectation `expect(d.fidelity).toBe("precision-reduced");` to `expect(d.fidelity).toBe("f16-verified");` (drop the flip comment).

- [ ] **Step 5: Re-run unit tests**

Run: `npx vitest run src/renderer/render/effects/effectRegistry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/e2e/effects-f16-parity/index.html apps/desktop/e2e/effects-f16-parity/run.mjs apps/desktop/src/renderer/render/effects/effectRegistry.ts apps/desktop/src/renderer/render/effects/effectRegistry.test.ts
git commit -m "test(gate): chromakey phase in f16 parity gate; mark f16-verified"
```

---

### Task 6: Docs sync + final gates

**Files:**
- Modify: `docs/render.md:20-26` (the "Per-layer effects" bullet)
- Modify (conditional): `docs/roadmap.md`

**Interfaces:** none — documentation and whole-suite verification.

- [ ] **Step 1: Update `docs/render.md`** — in the "Per-layer effects" bullet, change "(v1: Blur)" to "(Blur, Chroma Key)". Keep the sentence otherwise intact (evergreen style: no dates, no version numbers).

- [ ] **Step 2: Check `docs/roadmap.md`** — run `rg -n -i "blur|effect" docs/roadmap.md`; if any line claims the effects catalog is Blur-only or lists "more filters" as wholly unstarted, adjust the minimal wording to reflect that Chroma Key shipped. If nothing asserts catalog contents, change nothing. Do NOT edit ADR 0027 (it is a decision record; its "catalog grows filter-by-filter" path is exactly what this feature follows).

- [ ] **Step 3: Full unit suite + typecheck**

Run: `npm test` (from `apps/desktop`; runs `build:wasm` via pretest)
Expected: PASS, no regressions.
Run: `npm run typecheck` (= `tsc -b`; `pretypecheck` builds the wasm first)
Expected: clean.

- [ ] **Step 4: Final status check + commit**

```bash
git status --short   # verify only the intended doc files are dirty
git add docs/render.md docs/roadmap.md
git commit -m "docs: effects catalog now ships Blur + Chroma Key"
```

---

## Acceptance checklist (mirrors the spec)

- [ ] Unit: descriptor shape, param specs, uniform glue (Tasks 1–3).
- [ ] e2e: green fixture keyed, foreground survives, viewMatte grayscale, undo restores (Task 4).
- [ ] f16 parity gate passes with the chromakey phase; fidelity flag flipped in the same branch (Task 5).
- [ ] 10-bit filtered-export end-to-end stays a known repo-wide deferred gate (no task; chromakey rides the proven pool technique).
- [ ] Docs name the new catalog entry (Task 6).
