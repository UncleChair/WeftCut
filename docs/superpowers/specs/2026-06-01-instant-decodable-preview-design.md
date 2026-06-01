# Instant decodable preview — preview decodable originals immediately, proxy only what needs it

Status: design (grill-me output, pending implementation plan)
Date: 2026-06-01

## Problem

After the two-axis routing
([2026-05-30 import-decision-two-axis](2026-05-30-import-decision-two-axis-design.md),
ADR 0009) + import-time decodability probe
([2026-05-31 import-time decodability probe](2026-05-31-import-time-decodability-probe-design.md),
ADR 0010), **preview reads the original ONLY for `proxy_bypassed`** (friendly
H.264: ≤1080p, 8-bit, ≤25Mbps, short-GOP ≤0.5s — `proxy_decision::source_is_safe_to_bypass`).
Every other source previews from a proxy: `previewPlaybackPathFor` returns
`quick_proxy_path ?? proxy_path ?? (proxy_bypassed ? original : null)`. So a
**DirectExport source** (8-bit HEVC/AV1/VP9, or 4K/long-GOP/high-bitrate H.264 —
`export=Original, preview=Proxy`) shows a **blank preview until its quick proxy
lands**, even though this machine can decode the original directly.

That blank window is the cost we want to remove. A friend's pure-web editor
(clipcombo) has no proxy at all — it decodes originals via WebCodecs and is usable
the instant a file is dropped. We can't drop the proxy (long-form/desktop wants
the smooth-scrub steady state), but we can **stop making the proxy a precondition
for preview**: preview the original immediately for anything this machine can
decode, and demote the proxy to a background "needs-optimization" upgrade.

Belief this overturns: the recorded note (phase-status; the `hevc_10bit_proxies_both`
test; `pix_fmt_is_browser_friendly` = `yuv420p`/`nv12` only) treats **Hi10P/10-bit
as undecodable by WebCodecs → MUST proxy**. That was empirically disproved
(2026-05-31/06-01: Chrome 148 software-decodes Hi10P → `I420P10`; Edge 148
`isConfigSupported` = true; verified via same-engine CDP — see
[[reference_webcodecs_hi10p]]). The **static** pixfmt gate is what blocks Hi10P,
not the runtime probe (which passes). This design moves the preview decision off
the static gate and onto the runtime probe; the static gate keeps its conservative
role only for **import-time job scheduling** and **export** routing.

## Goal

For every source this machine's WebCodecs can decode (HW or SW, including Hi10P),
preview from the original **immediately** (gated by the import probe), build a
proxy only when the source genuinely needs one ("needs optimization"), and swap
preview onto the proxy without a flash when it lands.

## Scope

A webview-led change with one Rust routing extension. Touches: `proxy_decision`
(`decide` gains a `decodable_here` axis input; `source_is_safe_to_bypass`
generalized), a new webview→Rust "downgrade route / cancel quick proxy" command
(mirror of `ensure_full_proxy`), `previewPlaybackPathFor` + a session-scoped
"preview-from-original" signal, the `Compositor`/`SourceDecoderPool` overlap-swap,
the open-project re-probe + lazy proxy build, and the `importOptimize` classifier
(→ three-state). NOT persisted to the project; NOT changing export correctness.

## Core decisions (locked via grill-me)

1. **Scope = all runtime-probe-decodable sources** (HW or SW, incl. Hi10P).
   Preview from original immediately; proxy is a background needs-optimization
   upgrade.
2. **Gate on the import probe result, not optimistic decode.** Preview-from-
   original turns on once `probeSourceDecodable` confirms this machine can decode
   the source. (Rejected: optimistically decoding the original in the preview loop
   with a deadline-race fallback — too much added complexity in the hot loop.)
3. **Transient scrub = best-effort.** During the window before a proxy lands, a
   long-GOP source's backward scrub may stutter for a few seconds (decode from the
   nearest keyframe). Accepted as a bounded transient (not the permanent Piece-A
   freeze — a proxy is coming). No special throttling/keyframe-snapping.
4. **Narrow proxy generation (in v1).** A decodable + scrub-friendly source builds
   **no proxy at all** — generalize bypass from "H.264 only" to the whole decodable
   family. Only decodable-but-not-scrub-friendly (long-GOP/4K/high-bitrate) and
   undecodable sources still get a proxy.
5. **Coordination = eager schedule + probe-then-cancel, decided in Rust.** Routing
   logic stays in one place: `decide(media, source_gop_secs, decodable_here)`.
   Import time → `decodable_here = None` → conservative route as today. Webview
   reports the probe verdict via a new command → Rust re-decides and **cancels the
   quick-proxy job** + flips the source to preview-from-original. Mirrors the
   existing `ensure_full_proxy` route-correction, in the "build less" direction.
6. **Session-scoped, not persisted; re-probe each open.** The probe/bypass decision
   is never written to the project (continues Piece B's deletion of
   `decode_caps.json`). On opening a project, re-probe; a previously-bypassed source
   that this machine **can't** decode → lazily build its proxy on open (reuse
   `ensure_full_proxy` + the export readiness gate; brief wait returns, same as a
   fresh import on a weak machine). Project stays portable: a skipped proxy is just
   `quick_proxy_path = null`, always re-buildable.
7. **Overlap-swap, no flash.** When a proxy lands for a source currently previewing
   from its original, keep the original handle alive, spin up a second handle on the
   new URL, and on its `onFirstFrame` at the current playhead atomically repoint the
   sprite, then dispose the old handle. Keep the existing `createImageBitmap`
   snapshot (ADR 0004 buffer-pool discipline) and `prefer-software` fallback
   (`decoderFallback`) unchanged.
8. **Contention = rely on existing bounds (v1).** Preview decode is already scoped
   to on-screen layers (`SourceDecoderPool.acquire` per layerId + 5s idle-dispose),
   so a bulk import does not spawn N concurrent preview decodes. The proxy queue
   runs as-is. (Follow-up, not v1: bump the actively-previewed source's proxy to the
   queue front. Explicitly NOT doing: webview↔Rust CPU throttling of the queue.)
9. **Three-state import notification.** `importOptimize` classifier: instant &
   final (decodable + scrub-friendly, no proxy) → **silent / not listed**; instant
   preview, optimizing scroll in background (decodable + long-GOP) → "可即时预览,
   后台优化滚动"; not yet usable, transcoding (undecodable) → "暂不可用,转码中". Fixes
   the now-wrong "H.264 10-bit · 需优化" copy for machines that decode Hi10P.

## Design

### A. Rust routing: `decide` gains a `decodable_here` axis input

`proxy_decision::decide(media, source_gop_secs, decodable_here: Option<bool>)`:

- `decodable_here = None` (import time, before the webview probe): route exactly as
  today (`export_decodable_statically`, `source_is_safe_to_bypass`).
- `decodable_here = Some(true)` (probe confirmed): the **preview** axis may upgrade
  to `Original` for the whole decodable family (not just static H.264), and if the
  source is also scrub-friendly (`gop_is_scrub_friendly` + within res/bitrate), the
  route becomes bypass-equivalent (no quick proxy — `ProxyJob::None`).
- `decodable_here = Some(false)`: route as today (preview from proxy).

`source_is_safe_to_bypass` (the **no-proxy bypass** gate) is widened under
`decodable_here == Some(true)` to the whole **8-bit** decodable family via
`export_decodable_statically` (instead of static `codec_is_h264`); `None`/`Some(false)`
keep the conservative static-H.264 gate. The res/bitrate/scrub-friendly-GOP gates
apply in both modes.

**Invariant guard — 10-bit never bypasses.** `ProxyRoute` keeps
`preview == Original ⟹ export == Original` (`{ FullProxy, Original }` is
`unreachable!`). Gating bypass on `export_decodable_statically` (which requires an
8-bit browser-friendly pixfmt → `export = Original`) preserves that invariant, so a
**10-bit** source (export `FullProxy`) is *never* a no-proxy bypass. Its instant
preview-from-original is the **frontend bridge** (§C) layered over a **kept** proxy
— which also guarantees 10-bit always has a durable proxy (no incapable-machine
hole). So the belief-overturn is: the static pixfmt gate no longer gates **preview
visibility** (the runtime probe + the bridge do), but it still bounds **no-proxy
bypass** and **export**. `hevc_10bit_proxies_both` stays `BOTH_PROXY`; what changes
is that a probe-decodable 10-bit source *previews from its original immediately*
via §C while that proxy builds.

The bridge (preview-from-original for decodable-but-not-bypassed sources, incl.
all 10-bit and long-GOP/4K decodable) is **not** a `decide` route — it is the §C
frontend session signal over the unchanged `(export=Original|FullProxy, preview=Proxy)`
route.

### B. New webview→Rust command: downgrade route / cancel quick proxy

Mirror of `ensure_full_proxy`, opposite direction. After the import sweep's probe
resolves `decodable_here = true` for a source, the webview calls e.g.
`mark_preview_original(media_id)`:

- Rust re-runs `decide(..., Some(true))`.
- If the new route drops the quick proxy (scrub-friendly): **cancel** the quick-
  proxy job (if queued/running) and leave `quick_proxy_path = null`.
- Sets the session signal the webview reads for preview-from-original (see C).

Idempotent; safe if the job already completed (the proxy just exists — harmless,
preview still prefers it). Job cancellation builds on the existing media-job queue
(`importCancel` precedent).

### C. Preview path selection: `previewPlaybackPathFor` + session signal

Extend `previewPlaybackPathFor` so a **probe-decodable** source returns the
**original** until a proxy lands:

```
quick_proxy_path ?? proxy_path
  ?? (proxy_bypassed || previewDecodableThisSession(id) ? original : null)
```

`previewDecodableThisSession` reads a **session-scoped** signal (a store map / ref
keyed by media_id, set from the probe verdict), NOT a durable `MediaItem` field.
`proxy_bypassed` stays **durable and H.264-only** (universally safe); the
generalized non-H.264 case is session-derived and re-established by the probe each
open (Q6). When a quick/full proxy later lands, the `?? quick_proxy_path` prefix
naturally wins → the swap (D) fires.

### D. Overlap-swap in the Compositor / `SourceDecoderPool`

`SourceMedia` holds an immutable URL; `acquire(layerId)` returns the existing
handle. So a source-URL change is **not** an in-place update — naive
release+reacquire disposes the old ring (closes its ImageBitmaps) → flash.
Overlap-swap instead:

1. Compositor notices `previewPlaybackPathFor(layer)` resolved to a new URL.
2. Acquire a **second** handle on the new URL under a temporary key (avoid colliding
   with the live `layerId`).
3. `requestFrameAt(currentPlayheadUs)`; subscribe `onFirstFrame`.
4. On first frame (new handle's ring has the current playhead frame), atomically
   repoint the sprite's frame source to the new handle, then `release` the old.

Bounds a brief double-decoder to the warmup. Only fires for the long-GOP-decodable
subset (short-GOP decodable builds no proxy → no swap; undecodable → blank-then-
proxy as today). Snapshot + SW-fallback paths untouched.

### E. Open-project re-probe + lazy proxy build

On open, the existing import-style sweep re-probes timeline-referenced sources
(`probeSourceDecodable`, session-memoized via `decodeProbeMemo`). For a source that
was bypassed (no proxy) but this machine **can't** decode → enqueue its proxy
(`ensure_full_proxy`) and let the export/preview readiness gate
(`render/exportReadiness`) cover the wait, exactly like a fresh import on a weak
machine. Decodable sources just preview from original again.

### F. Notification (three-state)

`panels/importOptimize` classifier gains the partition from Q9:
- decodable + scrub-friendly (no proxy) → **not listed** (silent).
- decodable + long-GOP (instant preview, scroll proxy building) → listed under a
  new "可即时预览·优化滚动中" state.
- undecodable (blank until proxy) → "暂不可用·转码中".
Drop/repair the codec-specific 10-bit reason so a Hi10P-decoding machine doesn't
see "需优化" for a clip it can already preview. i18n keys updated en-US + zh-CN.

## Consequences / trade-offs

- **Long-GOP transient scrub stutters** for the seconds before the scroll proxy
  lands (Q3). Bounded, not the permanent Piece-A freeze.
- **A skipped proxy makes previewability machine-specific**, resolved by session
  re-probe + lazy on-open build (Q6) — opening on a weak machine pays a proxy build
  at open. `proxy_bypassed` stays H.264-only-durable to keep the project portable.
- **Cancel races the transcode**: a tiny clip's quick proxy may finish before the
  cancel arrives → harmless wasted work, and it's the cheapest proxy class (Q4/Q5).
- **Overlap-swap = brief double decoder** for the long-GOP subset (Q7). Bounded to
  warmup; the only no-flash option.
- **Preview decode contends with the Rust proxy queue** on bulk heavy imports (Q8);
  accepted for v1 because preview is already scoped to visible clips and the bridge
  already makes the focused clip instantly viewable.
- **Belief-overturn churn**: `proxy_decision` tests change meaning
  (`hevc_10bit_proxies_both` is no longer the whole story once `decodable_here` is
  Some(true)); the static gate's docstring/role must be re-described as
  scheduling/export-only, not preview.

## Non-goals

- Dropping the proxy entirely (clipcombo-style). Proxy stays the smooth-scrub +
  export destination.
- Persisting probe/decode capability to the project (Piece B deleted that; keep it
  session-scoped).
- Optimistic decode-in-the-preview-loop with deadline fallback (rejected in Q2).
- Active-clip proxy queue prioritization, and webview↔Rust CPU throttling (Q8
  follow-up / explicitly not done).
- Any change to export correctness, the export readiness gate's decode set, or the
  final mux.

## Testing

- **`decide` (pure, unit):** new `decodable_here` axis — `None` reproduces today's
  table; `Some(true)` + scrub-friendly non-H.264 (e.g. short-GOP 8-bit HEVC,
  Hi10P) → bypass-equivalent (`ProxyJob::None`, `preview=Original`); `Some(true)` +
  long-GOP decodable → `preview=Original` but quick proxy still scheduled;
  `Some(false)` → today's proxy route. Update `hevc_10bit_proxies_both` to assert
  the `None` vs `Some(true)` split.
- **`source_is_safe_to_bypass` (pure):** generalized predicate — decodable + short-
  GOP + ≤res + ≤bitrate across codecs; still false on long-GOP / oversize /
  high-bitrate / `decodable_here != Some(true)`.
- **`previewPlaybackPathFor` (pure):** probe-decodable session signal → original
  before proxy; quick/full proxy present → proxy wins (swap precondition);
  not-decodable + no proxy → null.
- **Cancel command (Rust):** `mark_preview_original` cancels a queued quick-proxy
  job; idempotent if already complete; sets the session signal.
- **Overlap-swap (render helpers where possible):** old handle retained until new
  handle's `onFirstFrame`; sprite repoints atomically; old handle released after;
  no window where the ring is empty/visible.
- **Open re-probe (manual/integration):** bypassed source on a capable machine →
  previews original, no proxy build; on an incapable machine → lazy proxy build +
  readiness wait.
- **Classifier (pure):** three-state partition; instant-final silent; Hi10P on a
  decoding machine not labeled "需优化".
- **Smoke (`tauri:dev`, the gate — typecheck/prod build red at baseline,
  [[weftcut-toolchain-baseline-red]]):** (a) import 8-bit HEVC → preview appears
  immediately from original, no blank; quick proxy lands → no visible flash.
  (b) import Hi10P MKV → previews immediately (SW decode), long-GOP scrub stutters
  during window then smooths after proxy. (c) import short-GOP 1080p HEVC → previews
  instantly, **no proxy job runs**, not listed in the notification. (d) import
  ProRes → blank-then-proxy as today, listed "暂不可用·转码中". (e) close + reopen a
  project with a bypassed HEVC on the same machine → previews original again, no
  rebuild. (f) (if feasible) open it on a machine that can't decode → lazy proxy
  build + brief wait.

## Open questions (for the plan)

1. Exact signal shape for the cancel/downgrade command and how job cancellation
   composes with the existing media-job queue (cancel-if-queued vs discard-output-
   if-running).
2. Where the session "preview-decodable" signal lives (Zustand store map vs a ref)
   and how it invalidates on source change / reload.
3. Temporary-key scheme for the overlap-swap's second handle in `SourceDecoderPool`
   (avoid `layerId` collision; ensure idle-sweeper doesn't reap mid-swap).
4. Does the long-GOP "optimizing scroll" notification state warrant its own copy or
   fold into a quieter badge — confirm against the just-shipped `ImportProxyDialog`
   surface.
