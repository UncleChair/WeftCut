# Direct export from decodable sources — split the proxy predicate

Status: design (brainstorming output, pending implementation plan)
Date: 2026-05-29

## Problem

Importing a video that isn't already in the editor's narrow decode contract
(H.264, ≤1080p, 8-bit, ≤25 Mbps) generates a **full 1080p H.264 CRF-22
proxy** (`jobs/proxy.rs`, `PROXY_HEIGHT_CAP = 1080`). For the footage that
actually hurts — 4K HEVC / 4K H.264, long-GOP, high-bitrate camera and phone
material — that means:

1. A full-clip transcode runs on import (minutes for long clips), purely to
   produce an *export master*.
2. Export then decodes from that 1080p CRF-22 intermediate
   (`exportPlaybackPathFor`), so output is **capped at 1080p** for 4K-output
   projects and carries a generational re-compression loss even for 1080p
   projects.

Yet WebCodecs in the WebView2 webview can hardware-decode this footage
directly on a capable machine (verified locally: HEVC/AV1 Media Foundation
extensions installed, RTX 3050 + Intel UHD 730, both with hardware HEVC/AV1
decode). On such a machine the full proxy is doing work the export path could
do for free, at higher quality, from the original.

## What this is *not*

- **Not** a mediabunny adoption. ADR 0002 ("Mediabunny for demux and mux")
  is `status: proposed` and was never wired up; the real demuxer/muxer is
  **mp4box.js** (`render/decoder/Demuxer.ts`, `render/worker/encoder.ts`,
  `package.json` → `mp4box ^2.3.0`). mp4box already demuxes MP4/MOV originals
  and already extracts `hvcC`/`vpcC`/`av1C` config, so reading the original
  directly needs no new library. mediabunny would only matter for non-MP4
  containers or for replacing ffmpeg with client-side transcode — both out of
  scope here.
- **Not** "just widen the existing `proxy_bypassed` flag." A naive widen would
  feed long-GOP 4K straight to preview (scrubs like a slideshow) and would
  break preview entirely on end-user machines lacking the HEVC extension. The
  whole design exists to avoid that.
- **Not** dropping the preview proxy. The proxy is a *scrub-performance*
  device (1 s GOP, no B-frames, downscaled), not only a codec shim. Long-GOP
  4K is decodable yet not pleasantly scrubbable, and worse when several layers
  decode at once. Preview keeps a cheap proxy.

## Core idea

Split today's single `proxy_bypassed` decision into **two independent
predicates per source**, driven by a **per-machine WebCodecs decode-capability
profile** (the verdict lives in the webview, not in the Rust ffprobe
heuristic):

| Predicate | Use the original when… | Otherwise |
|---|---|---|
| **Export source** | WebCodecs decodes the codec/profile/bit-depth on *this* machine | Full ffmpeg proxy (today's `proxy_path`) |
| **Preview source** | decodable **and** scrub-friendly (short GOP + modest bitrate/resolution) | Cheap preview proxy (today's `quick_proxy_path`, resolution bumped) |

"Decodable ≠ editable" is the load-bearing distinction: export tolerates a
heavy original (non-real-time); preview does not.

### Decode classification

Each imported video resolves to one class (re-derivable on workspace open, so
a later driver/extension change re-evaluates older imports):

- **`DirectBoth`** — decodable *and* scrub-friendly. No proxy at all. Export
  and preview both read the original. This is today's `proxy_bypassed` case
  (H.264 ≤1080p short-GOP), now reachable for more footage (e.g. short-GOP
  HEVC on a capable GPU).
- **`DirectExport`** — decodable but heavy (long GOP, or >1080p, or high
  bitrate). **Export reads the original**; **preview reads a cheap proxy**.
  This is the new path that captures the user's 4K HEVC / 4K H.264 footage.
- **`ProxyBoth`** — not decodable here (no HEVC extension), or a carve-out
  (10-bit/HDR — see below). Full proxy for export, cheap proxy for preview.
  This is exactly today's behavior; the settings toggle does **not** apply.

### Settings toggle (per the user's requirement)

A global app preference **`auto_generate_preview_proxy`**, default **on**,
auto-generating the preview proxy in the background. It governs **only the
`DirectExport` class** (where the preview proxy is an optimization, not a
necessity):

- **On (default):** background-generate the preview proxy. Until it lands,
  preview reads the original (functional, possibly janky); export reads the
  original throughout.
- **Off:** no preview proxy is generated. Preview reads the original directly
  (the user accepts long-GOP 4K scrub jank to save CPU/disk); export still
  reads the original. A per-clip manual **"Generate preview proxy"** action
  provides an escape hatch.

For `ProxyBoth`, the proxy is mandatory (WebCodecs can't read the source at
all) and the toggle is ignored. For `DirectBoth`, there's nothing to generate.

Granularity: **global toggle + per-clip manual override** (right-click
"Generate / Remove preview proxy" on a media-pool item). Global covers the
common case; the per-clip action handles a single heavy file on a weak
machine without flipping the global default.

## Architecture & components

### 1. `DecodeCapabilityProbe` (webview, new)

- **Does:** at app startup, probe `VideoDecoder.isConfigSupported(...)` across
  a small matrix (h264, hevc Main, hevc Main10, vp9, av1; a couple of
  resolution buckets up to 4K). For each "supported" result, run a **short
  trial decode** of a tiny embedded sample to confirm real throughput —
  `isConfigSupported` returns `true` for software decoders that run at a few
  fps, which would scrub fine but defeats the "skip the proxy" goal. Record
  `hardwareAcceleration` outcome where available.
- **Produces:** a `DecodeCapabilityProfile` — a map of
  `codec/profile/bit-depth/resolution-bucket → { supported, hardware }`.
- **Interface:** calls a Tauri command `report_decode_capabilities(profile,
  invalidationKey)` once per session when the key changes.
- **Depends on:** WebCodecs in WebView2 only.

### 2. `DecodeCapabilityStore` (Rust, new)

- **Does:** persist the latest `DecodeCapabilityProfile` keyed by an
  **invalidation key** = GPU name(s) + driver version (Win32_VideoController)
  + WebView2 runtime version. A key mismatch marks the profile stale and the
  webview re-probes.
- **Interface:** `get() -> Option<DecodeCapabilityProfile>`,
  `set(profile, key)`. Same JSON-on-disk / atomic-rename discipline as
  `AppSettingsStore`.
- **First-run / missing-profile fallback:** `decide` treats unknown
  capability as **not decodable** → `ProxyBoth` (today's safe behavior). Once
  the profile lands, subsequent imports use it; re-derivation on open upgrades
  earlier imports.
- **Depends on:** filesystem, the webview report.

### 3. `proxy_decision::decide` v2 (Rust, modify)

- **Does:** replace the 3-way `ProxyDecision` with the classification above.
  Inputs: `MediaItem` metadata (codec, dimensions, pix_fmt/bit-depth,
  estimated bitrate), **GOP length** (new — see §GOP), the
  `DecodeCapabilityProfile`, and `auto_generate_preview_proxy`.
- **Rules (sketch):**
  - non-8-bit pix_fmt (10-bit/HDR) → `ProxyBoth` (carve-out, see Risks).
  - not decodable per profile → `ProxyBoth`.
  - decodable + short-GOP + ≤1080p + ≤25 Mbps → `DirectBoth`.
  - decodable otherwise → `DirectExport`.
- **Keeps:** the cheap ffprobe-derived inputs as a pre-filter; the *only* new
  external input is the capability profile and GOP.
- **Tested:** pure function, unit-tested exactly like today's `decide`.

### 4. `MediaItem` state (Rust, modify)

- Replace `proxy_bypassed: bool` with a `decode_class` enum
  (`DirectBoth` / `DirectExport` / `ProxyBoth`) plus the existing
  `proxy_path` (full proxy, now only for `ProxyBoth`) and `quick_proxy_path`
  (preview proxy, now for `DirectExport`+`ProxyBoth`).
- Migration: existing `proxy_bypassed = true` → `DirectBoth`; existing
  `proxy_path` present, not bypassed → `ProxyBoth`. Bump `proxy_format_version`
  if the preview-proxy recipe changes (resolution bump, §below).

### 5. Import flow (`jobs/mod.rs::spawn_proxy_decision`, modify)

- `DirectBoth` → commit class, no proxy job (today's bypass branch).
- `DirectExport` → commit class + export-from-original immediately editable;
  if `auto_generate_preview_proxy`, `spawn_quick_proxy` in the background
  (preview-only; never blocks export).
- `ProxyBoth` → today's `spawn_quick_proxy` (quick-then-full) /
  `spawn_proxy` path, unchanged.
- The pending-hash machinery (ADR 0007) is unaffected — preview proxies still
  enqueue against `pending-{media_id}` and migrate on hash finalize.

### 6. Source resolvers (`state/projectStore.ts`, modify)

- `previewPlaybackPathFor`: `proxy_path` → `quick_proxy_path` →
  (`DirectBoth | DirectExport` ? original : null). (i.e. `DirectExport`
  with no preview proxy yet, or with the toggle off, falls through to the
  original.)
- `exportPlaybackPathFor`: `proxy_path` (only `ProxyBoth`) →
  (`DirectBoth | DirectExport` ? original : null). Export **never** uses the
  preview/quick proxy (preserves ADR 0006's "quick proxy is preview-only"
  invariant).

### 7. Runtime decode-failure recovery (new, both paths)

The capability profile is a prediction; a specific file can still fail
`VideoDecoder.configure`/decode (corrupt bitstream, an unusual profile the
matrix didn't cover). On a hard decode failure against an original:

- **Preview:** surface via LogBus and fall back to a generated proxy
  (enqueue if absent).
- **Export:** abort the export with an explicit error and enqueue a full
  proxy so a retry succeeds — never silently produce a broken file.

This is a new robustness requirement; today there is no "decode failed →
regenerate proxy" recovery because the proxy is always present.

### 8. Preview proxy resolution bump

Because the full proxy disappears for `DirectExport`, the preview proxy is now
the *only* preview surface (no later sharpen-into-full-proxy step). Raise the
quick-proxy cap from ≤540p to **720p** (short GOP, `-preset ultrafast`,
`-bf 0`), still seconds to generate, so 4K-project preview isn't mushy. 1080p
is an option at higher generation cost/disk; 720p is the recommended default.

## GOP analysis

Distinguishing `DirectBoth` (preview from original) from `DirectExport`
(preview needs a proxy) requires GOP length, which today's `decide` doesn't
read. Get it cheaply from ffprobe at import: read keyframe flags for the first
N seconds (`-read_intervals %+N`, `-show_frames -skip_frame nokey`) and derive
the max keyframe interval. A short GOP (≤ ~1–2 s) qualifies for `DirectBoth`;
longer → `DirectExport`. This is one extra cheap ffprobe pass at import.

## Behavior matrix (summary)

| Footage (this machine) | Class | Export source | Preview source |
|---|---|---|---|
| H.264 ≤1080p, short GOP, ≤25 Mbps | `DirectBoth` | original | original |
| 4K HEVC/H.264, long GOP / high bitrate, 8-bit, decodable | `DirectExport` | **original** | preview proxy (toggle on) / original (toggle off) |
| HEVC on machine w/o extension | `ProxyBoth` | full proxy | preview proxy |
| 10-bit / HDR HEVC | `ProxyBoth` (carve-out) | full proxy | preview proxy |

## Non-goals

- mediabunny adoption; client-side WebCodecs transcode replacing ffmpeg.
- Non-MP4/MOV originals (WebM/MKV) read directly — still proxied.
- 10-bit/HDR direct export (carve-out; revisit when the render+encode path is
  10-bit aware).
- Per-project (vs global + per-clip) proxy settings.

## Risks & mitigations

- **End-user machine lacks HEVC/AV1 extension** → profile reports
  undecodable → `ProxyBoth` (today's behavior). Graceful by construction.
- **`isConfigSupported` over-reports software decode** → the trial-decode
  throughput check gates `hardware`; software-only decode is treated as not
  qualifying for `DirectExport` (it would decode but not scrub/export at
  speed). Decision detail to confirm during implementation.
- **10-bit/HDR** → render/texture/encode pipeline is 8-bit (`yuv420p`/`nv12`).
  Carve-out to `ProxyBoth` until that pipeline is 10-bit aware. Detect via
  ffprobe pix_fmt bit depth.
- **Profile staleness after driver/extension/WebView2 update** → invalidation
  key forces a re-probe; re-derivation on workspace open re-classifies
  existing media.
- **Export decode of 4K HEVC originals is heavier** than the 1080p proxy →
  acceptable (non-real-time export); watch the WebCodecs buffer-pool
  constraint (ADR 0004 evict-after-use already applies on the export path).

## Testing

- Rust: `decide` v2 truth table (every class × decodable/undecodable × GOP ×
  bit-depth × toggle); `DecodeCapabilityStore` parse / invalidation /
  corrupt-file fallback (mirror `app_settings` tests); migration of
  `proxy_bypassed` → `decode_class`.
- Webview: `DecodeCapabilityProbe` against a stub `VideoDecoder`; resolver
  truth tables for `previewPlaybackPathFor` / `exportPlaybackPathFor` across
  classes and proxy-presence states.
- Integration/smoke: import a 4K HEVC fixture on a capable machine → asserts
  `DirectExport`, export reads original, preview proxy generated; toggle off →
  no proxy; decode-failure injection → recovery enqueues a proxy.

## Open questions

1. Trial-decode sample: embed a tiny per-codec bitstream, or trial-decode the
   first GOP of the imported file itself (more accurate, slower)?
2. Does `DirectBoth` widen beyond H.264 in v1 (e.g. short-GOP HEVC preview
   from original), or stay H.264-only for preview and let HEVC always be
   `DirectExport` until the preview-from-HEVC path is proven?
3. Exact GOP threshold for `DirectBoth` vs `DirectExport`.
