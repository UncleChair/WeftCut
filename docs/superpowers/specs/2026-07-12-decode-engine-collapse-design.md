# Decode-engine collapse — design (preview)

**Status:** Draft — awaiting review
**Date:** 2026-07-12
**Scope:** Preview decode path only. Export (`ExportDecoderPool`) untouched this round.
**Depends on:** Phase D1–D4 merged to main first (this reshapes the code Phase D just landed).
**Supersedes routing shape of:** ADR 0030 (`EngineTier` four-tier overlay).

---

## Problem

The preview decode path routes through a single flat enum:

```ts
type EngineTier = "native-hw" | "webcodecs-original" | "native-sw" | "proxy";
```

This one enum fuses **three orthogonal concerns** — which engine, which hardware lane,
which source file — into four hand-picked points of a 2×2×2 cube. Consequences:

- **No cell for new capability.** "FFmpeg decoding a proxy" has no tier, so the model
  resists extension.
- **The lane leaks upward.** `EngineTier` and `forceStrategy` travel from the resolver
  into `Compositor.ts` (`ResolvedRendererSource.tier`, the `rs.forceStrategy` branches at
  `:1542`/`:1635`, the `onFatalError → markDowngraded(tier)` block at `:1562`). The
  Compositor should not know what a "tier" or a "hardware lane" is.
- **Two near-identical handles.** `NativeGpuSourceHandle` and `SwSourceHandle` are ~90%
  the same class (same `FrameRing`, `streamId`, `onFirstFrame`/`onFatalError` lifecycle,
  `isIdle`, coalescing `requestFrameAt`, `dispose`); they differ only in *transport*
  (MessagePort + shared texture vs NV12-over-IPC). Modelling them as peer public
  strategies is what makes HW-vs-SW a public concern.

**Goal:** turn preview decode into a *deep module* — callers pick an engine, the engine
hides HW/SW selection, sticky fallback, probes, capability cache, and device-loss
recovery — and decouple that module from the Compositor.

## Decisions (locked with the user)

1. **Scope = engine collapse for preview only.** The resolver stays pure. Export keeps its
   current WebCodecs-on-proxy path; the preview/export *session-interface* split and
   export-side native decode are explicitly later bites.
2. **HW→SW fallback is fully internal.** `FfmpegSource` swaps its transport in place against
   the same `FrameRing`; no repaint choreography. The Compositor's
   `onFatalError → markDowngraded → tier-knockout → key-swap` path for HW/SW is **deleted**.
   Only a *total* FFmpeg failure surfaces one engine-level signal.
3. **Proxy is an opt-in source, never auto-routed.** `auto` = FFmpeg-if-component-present
   else WebCodecs; it never auto-proxies. When the selected engine cannot decode the
   selected source (only reachable as WebCodecs × unsupported-original), preview shows an
   explicit **unsupported** state.
4. **Engine names:** `Automatic (recommended)` / `Standard` (tag: `ffmpeg`) / `Lite`
   (tag: `webcodecs`). The stored setting value is renamed `"native" → "ffmpeg"`
   (migration below); `Standard` is the label.
5. **Unsupported = full affordance:** a placeholder card with inline actions
   ("Switch to Standard" and "Generate proxy"), not a black frame.

---

## Target design

### 1. Type model — two public axes + one private lane

```ts
// decodeEngine.ts
export type DecodeEngineSetting = "auto" | "ffmpeg" | "webcodecs"; // was "native"
export type DecodeEngine = "ffmpeg" | "webcodecs";  // resolved engine
export type DecodeSource = "original" | "proxy";    // user's opt-in source
export type FfmpegLane   = "hardware" | "software"; // PRIVATE to FfmpegSource, not exported

export interface DecodeResolution {
  engine: DecodeEngine;
  source: DecodeSource;
  /** File path (ffmpeg) or convertFileSrc URL (webcodecs); null when pending/unsupported. */
  target: string | null;
  /** Swap identity `${engine}:${source}:${target}`; null when nothing acquirable yet. */
  key: string | null;
  /** First-class outcome — "unsupported" replaces the old silent proxy floor. */
  status: "ok" | "pending" | "unsupported";
  reason: string; // LogBus trail
}
```

`EngineTier`, `LaneState` (as a resolver input), and the old `ResolvedSource` are removed
from `decodeEngine.ts`. Names avoid the existing `resolveDecode`/`ResolvedDecode` in
`decodeRoute.ts` (a different, import-time routing concept).

**Swap consequence:** `key` changes only on engine/source flips. HW→SW no longer changes
the key, so it triggers no swap — the Compositor's key-based no-flash swap now fires only
for the rare engine flip (auto: ffmpeg→webcodecs) and the user's original↔proxy source flip.

### 2. The resolver — `resolveDecodeEngine`, pure

Replaces `resolveEngineTier` + `orderFor`. Drops **both** native lane inputs; the only
capability input left is the one WebCodecs-original verdict.

```ts
interface DecodeResolveInputs {
  setting: DecodeEngineSetting;
  componentAvailable: boolean;          // FFmpeg component DLLs loaded?
  useProxySource: boolean;              // user opt-in for THIS media (see §4)
  proxyReady: boolean;                  // proxy built for this media?
  proxyUrl: string | null;             // convertFileSrc'd proxy preview path
  originalPath: string;                 // native decode target (ffmpeg)
  originalUrl: string;                  // convertFileSrc'd original (webcodecs)
  webcodecsCanDecodeOriginal: "ok" | "fail" | "untested"; // consulted ONLY on webcodecs×original
}
```

Logic (pure, no store reads, no probes — inputs gathered by PixiPreview, as today):

```
engine = setting==="webcodecs" ? "webcodecs"
       : setting==="ffmpeg"    ? "ffmpeg"
       : componentAvailable ? "ffmpeg" : "webcodecs"      // auto

source = useProxySource ? "proxy" : "original"            // user's axis, untouched by routing

if source==="proxy":
    proxyReady ? ok(target=proxyUrl)  : pending           // either engine decodes a proxy
else /* original */:
    engine==="ffmpeg"    → ok(target=originalPath)         // ffmpeg decodes anything
    engine==="webcodecs" → webcodecsCanDecodeOriginal:
        "ok"       → ok(target=originalUrl)
        "fail"     → unsupported(target=null)
        "untested" → pending(target=null)                  // probe kick (unchanged rhythm)
```

`hwEligibleCodec`, `classKeyOfMedia`, the HW probe, and the sticky HW/SW downgrade set are
**gone from the resolver** — they move into `FfmpegSource` (§3). ADR 0030 Risk 4 invariant
holds: the resolver remains a pure function of its inputs.

### 3. `FfmpegSource` — the deep module

One class replaces `NativeGpuSourceHandle` + `SwSourceHandle`. Still implements the existing
`DecoderHandle` (so the pool and Compositor seams and the untouched export path keep working).

```ts
class FfmpegSource implements DecoderHandle {
  readonly ring: FrameRing;                 // the stable thing; transports come and go
  private transport: GpuTransport | SwTransport;
  private lane: FfmpegLane;                 // private
  // owns: capability-cache lookup, hwEligibleCodec, classKey probe, sticky HW→SW verdict
}
```

- **open():** consult the capability cache + `hwEligibleCodec`. HW-eligible and probe ok →
  open `GpuTransport` (`lane="hardware"`). Otherwise → `SwTransport` (`lane="software"`).
- **runtime HW death** (GPU decode error, device loss, `hw-budget-exceeded`): dispose the
  GPU transport, open the SW transport **into the same `this.ring`**, flip `lane`, persist
  the sticky verdict. No external signal. Late GPU-port messages are already `streamId`- and
  `disposed`-guarded; the transport swap gets a fresh `streamId` so stale frames can't land.
- **total failure** (SW also dies, or component vanished after open): fire the single
  surviving `onFatalError` → Compositor re-resolves (auto → webcodecs, or → unsupported).
- **diagnostics:** `currentLane(): FfmpegLane` (read-only, PerfHUD/status). `isDowngraded()`
  becomes `lane === "software" && startedHardware`.
- **bench hook:** `forceLane?: FfmpegLane` (bench-only ctor option) so decode-bench can still
  pin HW vs SW to compare them — replaces today's `forceStrategy:"native"|"software"`.
  `poolSize` moves onto `FfmpegSource` (was on `NativeGpuSourceHandle`).

**Transports** are the two former handle bodies reduced to a common shape:

```ts
interface DecodeTransport {
  open(o: { streamId: string; path: string; colorSpace: ...; poolSize?: number }): Promise<void>;
  requestFrameAt(tUs: number): void;   // coalescing lives in the transport (GPU) or is a no-op dedup (SW)
  onFrame(cb: (bitmap: ImageBitmap, ptsUs: number, durUs: number) => void): void;
  onError(cb: (reason: string) => void): void; // GPU: port error; SW: open-failure only (v1)
  dispose(): void;
}
```

- `GpuTransport` = MessagePort + shared-texture body of `NativeGpuSourceHandle` (preload does
  `createImageBitmap`).
- `SwTransport` = NV12-over-IPC body of `SwSourceHandle` (does its own NV12→VideoFrame→
  ImageBitmap conversion). SW still has no mid-stream error channel (open-failure only) — the
  internal fallback therefore triggers on the *GPU* transport's errors; a total SW failure at
  open surfaces as the engine-level fatal.

`FfmpegSource` wires `transport.onFrame → this.ring.push`, owns `onFirstFrame`, `isIdle`,
`requestFrameAt` (delegates to the live transport), and `dispose`.

### 4. Proxy source axis (forward-compat shape only this bite)

The `source` axis is part of the model, but its *activation* is deferred with "Generate
proxy" (§7). Recon finding: proxy jobs are backend-orchestrated at import by route; there is
no on-demand "build a proxy for this media" command and no per-media "use proxy" control, so
nothing populates a proxy-source preference in this bite.

- The resolver **takes** `useProxySource: boolean` (the axis is real and typed).
- PixiPreview passes `false` for now — no activation path exists yet. A one-line comment marks
  the follow-up that flips it.
- The `Set<mediaId>` infrastructure and its trigger are **deferred to the Generate-proxy
  follow-up** (YAGNI — build the set alongside the thing that writes it).

**Accepted consequence (documented, not silent):** on a machine with *no* FFmpeg component
(macOS/Linux; not a shipping target — v1 bundles the component on Windows only), a media that
WebCodecs can't decode shows `unsupported` even if a proxy already exists on disk, because the
proxy is no longer auto-routed and there is no opt-in trigger yet. The Generate-proxy follow-up
closes this.

### 5. Pool changes

`SourceDecoderPool.acquire` branches on `engine` instead of `forceStrategy`:

```
engine==="ffmpeg"    → new FfmpegSource(...)       // internally picks lane
engine==="webcodecs" → new SourceHandle(...)       // via shared refcounted SourceMedia (unchanged)
```

The `forceStrategy:"software"` branch is deleted. `SourceMedia`, refcounting, and the idle
sweeper are unchanged (the sweeper's `isIdle` contract is preserved by `FfmpegSource`).

### 6. Compositor decoupling (the deliverable)

- `ResolvedRendererSource` drops `tier` and `forceStrategy`; gains `{ engine, source, status }`.
- The `rs.forceStrategy ? {...}` spreads (`:1542`, `:1635`) become an `engine` switch.
- The `rs.forceStrategy && source.onFatalError` block (`:1562`) collapses: `onFatalError` now
  means *engine-level total failure*, handled by a re-resolve (auto → webcodecs, or →
  unsupported) rather than a tier knockout. `markDowngraded`/tier vocabulary leaves the
  Compositor entirely.
- `rsFromExportProxy` (`:195`) returns `{ engine:"webcodecs", source:"proxy", ... }` — a
  mechanical shape change; **export behavior is byte-identical**.

### 7. Unsupported UI — placeholder card + Switch to Standard

When a clip on-screen resolves to `status === "unsupported"`, PixiPreview renders a React
overlay card (not a black frame) with one action this bite:

- **Switch to Standard** — sets `decode_engine = "ffmpeg"` via the existing settings-apply
  path. Only shown when `componentAvailable` (on a no-component machine the card states the
  format is unsupported by the Lite engine, with no switch action).

Plumbing: the Compositor surfaces unsupported media via an `onUnsupported(mediaId)`
notification (mirroring its existing repaint/first-frame callbacks) and skips acquiring a
handle for them; PixiPreview tracks the set of currently-on-screen unsupported media and
renders the card. Copy is i18n'd (en-US + zh-CN).

**"Generate proxy" is a separate follow-up plan** — it needs a new on-demand backend
proxy-build command (§4 recon finding), out of scope here.

### 8. Settings + naming migration

- `DecodeEngineSetting` value `"native"` → `"ffmpeg"`. Add a one-shot migration in
  `app-settings.ts` mapping any persisted `"native"` to `"ffmpeg"` on load.
- UI labels: `Automatic (recommended)` / `Standard` + small `ffmpeg` tag / `Lite` + small
  `webcodecs` tag. i18n keys updated in en-US + zh-CN.

### 9. Capability module split (`decodeCapability.ts`)

- **Moves into `FfmpegSource`'s private capability sub-module:** `hwLaneByMedia`,
  `swLaneByMedia`, `hwEligibleCodec`, `classKeyOfMedia` (keep the byte-identical twin
  invariant with main's `classKeyOf` — the existing cross-language guard must survive the
  module move), `kickHwProbe`,
  `setHwLane`/`setSwLane`, and the HW/SW entries of `downgradedByMedia`.
- **Stays resolver-facing:** the WebCodecs-original probe memo (the one lane the resolver
  still needs) and `noteResolution` LogBus logging.

---

## Blast radius (files touched)

- `decoder/decodeEngine.ts` — new types + `resolveDecodeEngine`; delete `EngineTier`/`orderFor`.
- `decoder/decodeEngine.test.ts` — rewrite around the new resolution matrix.
- `decoder/FfmpegSource.ts` — **new**; absorbs `NativeGpuSourceHandle.ts` + `SwSourceHandle.ts`.
- `decoder/transports/{GpuTransport,SwTransport}.ts` — **new**; extracted transport bodies.
- `decoder/NativeGpuSourceHandle.ts`, `SwSourceHandle.ts` — **deleted** (bodies migrated).
- `decoder/decodeCapability.ts` — split (§9).
- `decoder/SourceDecoderPool.ts` — acquire branches on `engine`; drop `"software"` branch.
- `render/Compositor.ts` — `ResolvedRendererSource` reshape; delete HW/SW downgrade path;
  unsupported placeholder; `rsFromExportProxy` shape.
- `decoder/decodeBench.ts` — `forceLane` bench hook instead of `forceStrategy`.
- `settings/appSettingsStore.ts`, `shared/app-settings.ts`, `main/app-settings.ts` —
  `"native"→"ffmpeg"` value + migration.
- `i18n/locales/{en-US,zh-CN}.ts` — engine labels + unsupported-card copy.
- e2e: `decode-engine.spec.ts`, `preview-gpu-order.spec.ts`, `preview-sw-conformance.spec.ts`,
  `preview-sw-families.spec.ts` — retarget off `EngineTier`; add the tests below.
- `testhook/e2eHook.ts` — drop `EngineTier` references.

## Testing / verification

- **Resolver unit tests** — the full matrix: {auto, ffmpeg, webcodecs} × {component present/
  absent} × {original, proxy} × {webcodecs ok/fail/untested} → assert `{engine, source,
  status, target}`. Especially: `webcodecs × original × fail → unsupported`;
  `auto × no-component × unsupported-original → unsupported` (no auto-proxy).
- **Internal HW→SW fallback (new, the risky piece)** — drive continuous forward decode of the
  index-encoded barcode clip on `hardware`, inject a GPU decode error mid-playback, assert:
  (a) frames keep flowing on `software` into the *same* ring, (b) no gap/dupe across the
  switch (reuse `preview-gpu-order.spec.ts`'s barcode==pts-index assertion), (c) no key-swap
  fired, (d) `currentLane()` flips hardware→software. This is the behavior-observed gate, not
  just a unit test.
- **No auto-proxy** — a WebCodecs-unsupported original on `ffmpeg`/auto+component previews via
  ffmpeg-SW (never builds a proxy); on `Lite`/no-component it reaches `unsupported`.
- **Affordance** — "Switch to Standard" re-resolves to ffmpeg and decodes; "Generate proxy"
  builds + swaps onto proxy.
- **Export regression** — an export run is byte-identical (SSIM 1.0000) to pre-change
  (`rsFromExportProxy` shape change only).
- **Settings migration** — a persisted `"native"` loads as `"ffmpeg"`.

## Risks

- **In-place transport switch** is the one genuinely new mechanism. Failure mode: a stale GPU
  frame lands in the ring after the switch (mitigated by fresh `streamId` + `disposed` guard),
  or a visible gap while SW spins up (mitigated: last HW frame stays in the ring). Gated by
  the fallback test above.
- **Removing the proxy floor** changes behavior on machines with no FFmpeg component
  (possibly macOS/Linux per the ADR): unsupported originals now show the placeholder instead
  of silently proxying. This is intended (native-NLE convention) but is a real, visible change
  — the affordance is the mitigation.
- **Capability twin** (`classKeyOfMedia` ↔ main `classKeyOf`) moves modules but must stay
  byte-identical; keep the cross-language guard.

## Sequencing

1. Land Phase D1–D4 to main (its own merge decision; unpushed today).
2. This bite on top of merged main.

## Out of scope (explicitly deferred)

- Preview/export **session-interface split** (`PreviewDecodeSession` / `ExportDecodeSession`)
  — the next bite; `FfmpegSource` keeps implementing the shared `DecoderHandle` for now.
- **Export-side native decode** and the export proxy-policy flip (the old D5/D6).
- **"Generate proxy" on-demand** — a new backend proxy-build command + button wiring + the
  `useProxySource` `Set<mediaId>` and its persistence (its own follow-up plan).
- Unified `DecodedFrame` metadata/ownership standardization (external suggestion #2) — safe to
  do later; the union already exists.
