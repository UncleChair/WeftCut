---
status: accepted
---

# Native software decode for WebCodecs-blind formats ships bytes, not a shared texture

## Context

WebCodecs cannot open certain professional codecs at all (ProRes today;
other blind-spot families are future work), so those sources have only ever
previewed through a proxy — an import-time transcode wait before the clip is
scrubbable. The project already has one precedent for native (non-WebCodecs)
decode reaching the preview compositor: `preview-gpu`, a Windows-only D3D11VA
hardware-decode path that shares a GPU texture zero-copy into the renderer
(see [`decode-bench.md`](../decode-bench.md#native-strategy)). That path's
speed comes precisely from never copying pixel bytes — the frame is already a
GPU handle and stays one all the way to `createImageBitmap`.

Software-decoded frames are not GPU-resident. libavcodec software decode
produces frames in CPU memory; forcing them through a D3D11 upload just to
reuse the shared-texture transport would add a GPU upload and a convert
shader that buys nothing, since the bytes are already in a form that copies
and crosses process boundaries cheaply. A cross-process transport spike
(`poc/export-frame-transport/FINDINGS.md`) measured classic Electron
`ipcRenderer`/`webContents.send` at ~1 GB/s (327 fps @1080p, 86 fps @4K NV12)
with no CPU zero-copy available across the main↔renderer boundary at all —
that is the transport this decision commits to.

Two existing conventions bear on the shape of the fix: mainstream NLE preview
behavior treats native decode as the default and proxy as a user-opt-in
convenience, never an automatic format-driven swap
(`feedback_native_nle_conventions`); and the project's color-convergence
discipline (ADR 0021) confines all YUV→RGB conversion to one chokepoint
(`VideoClipSprite.drawImage`) so preview and export composite identically
regardless of which decoder produced the frame.

## Decision

- **Native libavcodec SOFTWARE decode** is the entry point for
  WebCodecs-blind formats, starting with ProRes. Decode runs in the Electron
  **main** process (napi-rs), on its own per-source session thread, mirroring
  the *structure* of `preview_gpu`'s session/pump/registry but with none of
  its D3D11 device, keyed-mutex, or shared-texture plumbing.
- **Ship 8-bit NV12 bytes, not a shared texture.** Each decoded frame is
  `swscale`'d to 8-bit NV12 and crosses to the renderer as a plain napi
  `Buffer` (delivered via a `ThreadsafeFunction`) → `webContents.send` → a
  renderer `SwSourceHandle`. This is a deliberate divergence from
  `preview-gpu`: a GPU-resident frame is worth sharing zero-copy; a CPU frame
  gains nothing from a GPU upload it doesn't already have, so classic ipc
  (measured fastest) is the right transport — not `MessageChannelMain`
  (measured slower, and `MessagePortMain` rejects `ArrayBuffer` transfer
  outright) and not a `SharedArrayBuffer` (no CPU zero-copy exists across the
  main↔renderer boundary regardless of channel).
- **Single color model — no YUV→RGB on the Rust side.** The native decoder
  tags each frame with a `colorSpace` derived from the source's color tags
  and ships YUV; the renderer reconstructs `new VideoFrame(nv12,
  { colorSpace })` → `createImageBitmap` → the existing `FrameRing`.
  Conversion still converges exactly once, at the existing
  `VideoClipSprite.drawImage` chokepoint (ADR 0021) — native-SW frames and
  WebCodecs frames become indistinguishable the moment they enter the ring.
- **A dedicated `DecodeRoute::NativeSw` variant**, carrying the same
  proxy-path payload shape as `Proxied` (`quick_proxy`, `full_proxy`,
  `format_version`). With the feature toggle off, the resolver returns the
  proxy path exactly as `Proxied` would — no behavior change for anyone who
  hasn't opted in. With the toggle on, an overlay
  (`forceStrategy: "software"` at the `SourceDecoderPool.acquire` seam)
  routes to `SwSourceHandle`, which decodes the ORIGINAL directly.
- **User opt-in, not automatic.** The route is gated behind an off-by-default
  `experimental_native_sw_decode` AppSettings toggle. Preview never
  auto-swaps between native-SW and proxy — matching the mainstream-NLE
  convention that native decode is the default preview source and proxy is
  an opt-in convenience, never the reverse.

## Considered options

- **Reuse `preview-gpu`'s D3D11 shared-texture transport for software
  frames.** Rejected: shared-texture zero-copy is a property of GPU handles
  crossing the Chromium sandbox; a software frame would first need an upload
  to become GPU-resident, which is strictly more work than shipping the CPU
  bytes it already has. Also Windows-only, where software decode needs to
  stay cross-platform.
- **`MessageChannelMain` (with or without transfer) instead of classic
  ipc.** Rejected on spike data: slower than classic `ipcRenderer` at both
  1080p and 4K, and `MessagePortMain` cannot transfer `ArrayBuffer`s at all,
  so "transfer + recycle" degrades to a copy anyway while adding
  port-lifecycle complexity for no win.
- **Convert YUV→RGB on the Rust side before shipping.** Rejected: would fork
  the color model into two conversion sites (Rust `swscale` plus the existing
  `drawImage` chokepoint), reopening exactly the risk ADR 0021 closed.
- **Auto-swap preview to native-SW whenever available, no toggle.** Rejected
  for now: native-SW is new, unproven in the field, and covers only one
  codec; an off-by-default experimental toggle ships the path without
  changing default behavior for any existing project.

## Consequences

- Preview for WebCodecs-blind formats can skip the proxy wait entirely once a
  user opts in — the original decodes directly through `SwSourceHandle` into
  the same `FrameRing`/compositor path as every other preview source.
- The transport carries a real per-frame copy cost (~1 GB/s ceiling;
  `createImageBitmap` is the dominant per-frame cost, ~3.25 ms @1080p /
  ~11.75 ms @4K) — acceptable for preview. Export is deliberately out of
  scope: a non-realtime path could tolerate the same cost, but the
  main→worker frame hop export would need is new surface that isn't built.
- `DecodeRoute` gains a fourth persisted variant; every exhaustive match over
  the enum (Rust and TS) must add a `NativeSw` arm. The toggle-off default
  keeps existing projects byte-identical in behavior.
- Because native-SW ships the same YUV+`colorSpace` shape the WebCodecs path
  already produces, no new color-conformance surface is needed — the
  existing `drawImage`-chokepoint gate covers it.
- Only ProRes is wired today; the remaining WebCodecs-blind families and any
  decode-degrade stack (thread tuning, frame-drop, playback-resolution
  throttle) are unbuilt future work, not implied by this ADR.

## Addendum (2026-07-09)

Two consequence-section facts have moved since acceptance; the decision
itself is unchanged:

- **The blind-spot set widened past ProRes** (`codec_is_blindspot`):
  DNxHD/DNxHR, MPEG-2, and VC-1/WMV3 now route here too, with per-family
  decoder threading (intra families slice-only; long-GOP frame+slice) and a
  re-seek-with-margin fix for index-less long-GOP backward seeks. Of the
  decode-degrade stack, the frame-drop floor shipped; the
  playback-resolution throttle and its UI remain unbuilt.
- **A successor design widens the route's role.** The dual-engine
  architecture spec
  (`docs/superpowers/specs/2026-07-09-dual-engine-decode-export-design.md`)
  promotes this path from a blind-spot fallback to the Native engine's
  software lane — probe-arbitrated rather than list-gated, user-selectable,
  and shipped as an optional native-decode component. The ship-bytes
  transport and single-color-model decisions made here carry over unchanged.

## References

- ADR 0021 — color converges at ingest; the working space is the output
  space (the chokepoint this route must not bypass).
- ADR 0024 — desktop runtime is Electron + napi-rs (the main-process/renderer
  boundary this route crosses).
- ADR 0028 — Decode Route persisted as a folded enum (the enum this ADR adds
  a fourth variant to).
- [`docs/preview.md`](../preview.md#proxies),
  [`docs/decode-bench.md`](../decode-bench.md).
