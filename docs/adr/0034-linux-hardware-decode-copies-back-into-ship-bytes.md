---
status: accepted
---

# Linux hardware decode lanes are copy-back producers into the ship-bytes transport, NVDEC before VAAPI, with zero-copy deferred

## Context

On Windows the Standard engine has a private hardware lane: `preview-gpu`
decodes with D3D11VA and shares the GPU texture zero-copy into the renderer,
its speed resting precisely on never copying pixel bytes
([ADR 0029](0029-native-sw-decode-ships-bytes-not-shared-texture.md)). On Linux
the Standard engine had only its software lane
([ADR 0029 Addendum](0029-native-sw-decode-ships-bytes-not-shared-texture.md#addendum);
issue #5 Blocks A/B) — every source decoded on the CPU, so multi-track
timelines and effects had no hardware headroom to draw on. The engine already
treats the hardware lane as one of three independent layers of truth
([ADR 0030](0030-decode-engine-overlay-and-native-component.md)), kept private
to `FfmpegSource`; the question this ADR settles is how a *Linux* hardware lane
delivers its frames and how the engine chooses one.

The zero-copy option exists but is not free. Electron exposes a native-pixmap
shared-texture handle that could import a decoder's DMA-BUF surface without a
CPU round-trip, but DRM format-modifier negotiation, multi-GPU import, and
NVIDIA's DMA-BUF export path are each an independent risk surface with no
measurements yet to justify the complexity. Meanwhile the ship-bytes transport
already moves software NV12 frames renderer-ward over classic IPC at a measured
~1 GB/s (ADR 0029), and hardware-vs-software is already invisible below the
engine.

Two supply-chain facts constrain the hardware path. The component links the
BtbN linux64 LGPL **shared** ffmpeg build, which enables vaapi and ffnvcodec;
that build **implib-gen's** the system `libva`/`libcuda` (lazy `dlopen` of
whatever the host ships) rather than hard-linking them. And on a multi-GPU
machine libva's default device selection routinely picks the wrong GPU, so a
VAAPI lane cannot assume a single implicit device.

## Decision

### The Linux hardware lanes are copy-back producers into the ship-bytes transport

NVDEC and VAAPI decode on the GPU, then `av_hwframe_transfer_data` copies the
surface to a CPU NV12 frame that feeds the **same** ship-bytes preview transport
as software (ADR 0029) — the identical `previewSw` / `SwTransport` path, the
identical `PreviewSwFrame` NV12 contract. This extends ADR 0029's ship-bytes
principle to hardware on Linux: **one transport for software and both hardware
APIs, no new IPC surface, the renderer untouched, and hardware-vs-software
stays private to the Standard engine**. The lane is a decode *source* swap
inside `SwVideoStream` (attach a CUDA/VAAPI device + a `get_format` override,
then transfer each frame back before packing); the packed bytes are
byte-identical to the software lane's, so nothing downstream can tell which
produced them. This deliberately diverges from the Windows d3d11va lane
(zero-copy shared texture, kept as-is): a GPU-resident frame that will stay a
GPU handle is worth sharing zero-copy; a frame we must land in CPU memory to
cross the sandbox gains nothing from a shared-texture dance it would only undo.

### NVDEC before VAAPI; Vulkan Video and VDPAU excluded

Both lanes land in v1, resolved **NVDEC-first** — mirroring the encode side's
established NVENC > VAAPI ordering — so an NVIDIA machine uses its native
decoder rather than the flaky NVIDIA VAAPI shim (validated: the shim can crash
the copy-back). VAAPI is the Intel/AMD path (and NVIDIA's shim only as a last
resort a real machine reaches only when NVDEC is unavailable for the family).
Vulkan Video and VDPAU are excluded — the bundled build needs no change for any
of this.

### The probe generalizes to `(lane, classKey, device)`, advertisement-gated, and prefers hardware within a covered family

The one-frame decode probe, formerly d3d11va-specific, generalizes to a machine
Capability-cache key of `(lane, format-class key, and — for VAAPI — device)`.
Resolution is an advertisement-gated priority walk over the lanes
`capabilities()` reports (NVDEC → VAAPI → d3d11va): a lane the addon never
compiled is never probed. VAAPI enumerates the DRM render nodes and probes each,
recording which node passed — device enumeration is load-bearing, not defensive,
because libva's default selection picks the wrong GPU on a multi-GPU box.
Coverage is the **interframe delivery families only — H.264, HEVC, VP9, AV1**;
intra/production formats (ProRes, DNx, MJPEG) are never probed, and MPEG-2/VC-1
stay on software decode (cheap, uniform transport). Where a lane probes clean,
hardware is preferred at every resolution in v1 (no resolution gate; bench
refines later). Cache invalidation stays tied to the component's avcodec version
plus GPU/driver identity, so a driver update or ffmpeg bump re-probes.

### A hardware failure falls back to software, invisibly

A hardware probe failure, or a mid-session hardware failure, falls back to the
Standard engine's **software** lane. It never alters the Decode engine
resolution, never downgrades to Lite, and is invisible to the user beyond a log
line — the private HW-vs-SW choice of ADR 0030, extended to Linux.

### VAAPI is additionally gated at runtime on the system libva exporting `vaMapBuffer2`

Advertisement gates NVDEC and VAAPI on the compiled lanes, but VAAPI carries one
more gate. The copy-back (`av_hwframe_transfer_data` mapping a VAAPI surface to
CPU) calls `vaMapBuffer2` through the implib'd **system** libva. On a host libva
that predates that symbol (`vaMapBuffer2` is a 2024 libva addition, NEWER than
the 2.20 current stable distros ship — e.g. Ubuntu 24.04) the implib trampoline asserts and
**aborts the process uncatchably on the first mapped frame** — while decode and
the one-frame probe still pass, because they never map a surface. So the
component `dlsym`-checks `vaMapBuffer2` up front and declines to advertise VAAPI
(and refuses to attach the device) when it is absent, turning a would-be crash
into a clean decline + software fallback. NVDEC is immune: its implib'd libcuda
is the current NVIDIA driver's, and a missing libcuda merely makes the probe
`Err` cleanly.

## Considered options

- **Zero-copy DMA-BUF import via Electron's native-pixmap shared texture.**
  *Deferred, not rejected.* The API exists, but DRM format-modifier negotiation,
  multi-GPU import, and NVIDIA DMA-BUF export are three independent risk
  surfaces; copy-back ships now over the proven transport, and the zero-copy
  decision waits until decode-bench shows copy-back leaving enough on the table
  to justify them.
- **Export through the hardware lanes.** *Deferred.* Export keeps the software
  lane, matching Windows and
  [ADR 0033](0033-export-decode-joins-the-engine-overlay.md); hardware readback
  for export is a fast-follow candidate gated on the same bench numbers.
- **Bundle libva with the component instead of gating on the system one.**
  Rejected: libva is the gateway to the host's GPU driver, coupled to the kernel
  and the installed driver; shipping our own would fight the very driver it must
  reach. It is correctly a system library — so the version mismatch is gated, not
  bundled around.
- **Drop NVDEC and reach NVIDIA GPUs through the VAAPI shim.** Rejected: the
  shim is flaky (observed to crash the copy-back), which is exactly why NVDEC is
  preferred; a machine falls to VAAPI only when NVDEC can't serve the family.
- **A second IPC surface / a distinct hardware frame message.** Rejected: the
  copy-back yields the same NV12 bytes software already ships, so a new channel
  would fork the transport for no difference the renderer can observe.

## Consequences

- One transport carries software, NVDEC, and VAAPI; the renderer, the IPC
  surface, and the `previewSw:frame` contract are unchanged. Adding a lane is a
  decode-source swap plus a `capabilities()` entry, not new plumbing.
- Copy-back costs a GPU→CPU transfer per frame — the trade that frees CPU decode
  headroom, which is the point — and leaves the zero-copy win on the table by
  design until bench justifies it.
- VAAPI availability depends on the host libva version; an old-libva machine
  silently runs software for VAAPI-eligible sources (NVDEC unaffected). This is a
  supply-chain property of the implib'd shared build, recorded here so a future
  loader or ffmpeg change re-checks it rather than re-discovering the abort.
- CI runs the software and unit seams only (shared runners have no GPU); hardware
  conformance is local, the preview-conformance e2e parameterized by lane and
  skipping cleanly when a lane is unadvertised. NVDEC copy-back is validated on
  the reference RTX 3050 (correct NV12 through the wired session path); VAAPI
  decode + per-node probing are validated, but its copy-back awaits a
  newer-libva machine — gated off, not broken, on the current dev box.

## References

- ADR 0029 — native decode ships bytes, not a shared texture (the transport this
  ADR extends to hardware; the Windows d3d11va zero-copy lane it deliberately
  diverges from).
- ADR 0030 — the decode-engine overlay and the conditional component (the
  three-layers-of-truth model whose *hardware lane* layer this ADR fills in for
  Linux, the private HW-vs-SW choice this ADR extends, and the Linux
  loading/supply-chain amendment this build's implib behavior sits under). The
  component's own `capabilities()` advertisement is the surface this ADR
  generalizes from one hardware lane to a probe-gated set.
- ADR 0033 — export decode joins the engine overlay (why export stays on the
  software lane; the deferral this ADR inherits).
- Issue #5 (`UncleChair/WeftCut`) — the grill-confirmed Blocks A/B/C spec.
- `src/main/decode-capability.ts` (`resolveHwLane`, the `(lane, classKey, device)`
  cache), `src/main/index.ts` (`decodeCap:probeHw` dispatch, DRM-node
  enumeration), `native/decode/src/preview_sw/decoder.rs`
  (`DecodeAccel`, the copy-back, `vaapi_copyback_supported`).
- [`docs/preview.md`](../preview.md#decode-engine), [`docs/decode-bench.md`](../decode-bench.md)
  (the deferred zero-copy / export-hardware decisions gate on its Linux HW cells).
