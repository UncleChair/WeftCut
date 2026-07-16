---
status: accepted
---

# Export decode joins the engine overlay; the native lane is a credit-windowed session that never falls back mid-export

## Context

Preview decode resolves through the engine overlay — Standard (`ffmpeg`) or
Lite (`webcodecs`) per source, hardware-vs-software private to the Standard
engine ([ADR 0030](0030-decode-engine-overlay-and-native-component.md)).
Export decode did not: `ExportDecoderPool` decoded WebCodecs-only, so every
WebCodecs-blind source (ProRes, DNxHD, MPEG-2, VC-1) exported from its lossy
libx264 full proxy — a generation loss the preview side had already
eliminated. The persisted [Decode Route](../../CONTEXT.md#decode-routing)
carries the import-time blind-spot verdict; the native component ships bytes
over IPC ([ADR 0029](0029-native-sw-decode-ships-bytes-not-shared-texture.md)).

Export could not simply reuse the preview decode protocol. Preview is
best-effort realtime (anchor + pump, frames may drop); export is exactly-once
coverage of a presentation range, driven by an encode loop that must never
observe a gap. The two contracts differ in what a frame *means*.

## Decision

### Export decode is routed by the overlay, resolved once per export

`ExportSettings` gains `decodeEngine: "auto" | "ffmpeg" | "webcodecs"` beside
`encoderEngine` — an independent axis, persisted per project as user *intent*.
Resolution is never persisted, extending ADR 0030's rule to export: the
settings merge only snaps out-of-enum values to `auto`, and an `ffmpeg` pin on
a machine without the component degrades to `auto` at resolve time
(`effectiveSetting`), because capability re-resolves per machine.

`resolveExportDecodeRouting` (`render/exportDecodeRouting.ts`) is PURE —
a function of setting × component availability × composite bit depth ×
per-media decode route. It runs once, at export start, on the renderer main
thread, before the readiness gate, and produces a per-media routing table
(`{ engine: "webcodecs" } | { engine: "native"; sourcePath }`) that rides the
init protocol into the export Worker. The Worker stays policy-free; nothing
re-resolves mid-run. Under `auto`, decodable sources keep the in-worker
WebCodecs path and only persisted blind spots route native; an `ffmpeg` pin
routes every source native as an explicit fidelity promise. Native-routed
sources skip the pre-export full-proxy wait entirely (`proxyWaitScope`), and
the export dialog's routing-summary line derives from the same table
(`routingSourceCounts`), so the dialog can never disagree with the run.

### The session API is dedicated, and flow control is a credit window

`@weftcut/native-decode` gains an export session (`export_sw`):
`open(path, outFormat)` → session + stream metadata, `decodeRange(a, b)`
performs GOP-aligned exact coverage of the presentation range and emits frames
in presentation order, `close()` tears down. Rust owns GOP walking, reorder,
and EOS drain — the WebCodecs-specific complexity (no-mid-flush rule, floated
EOS flush, stop-key overshoot, pool-slot deadlocks) does not carry over.

Backpressure is a **credit window** (default 6 frames in flight): the producer
thread parks when credits run out; the consumer returns exactly one credit per
frame that has *left* the export ring — consumed, evicted, or freed — bounding
main-process frame memory to ~100–200 MB even at 4K 10-bit. Credit returns
bypass the command channel so they land even while the session is mid-range.

Everything the session emits travels **in-band on one ordered channel** as a
tagged `ExportSwMsg` (`frame` / `rangeEnd` / `ended` / `error`), relayed
verbatim main → renderer → Worker. Delivery order IS the contract — an `ended`
arriving before its tail frames would corrupt the export tail — so control
signals are never split onto a second channel. The transport format follows
the export's composite bit depth, table-wide (`NV12` at 8-bit, `I420P10` at
10-bit); frames cross main → renderer over classic IPC and renderer → Worker
as transferred ArrayBuffers. On the Worker side `NativeExportSourceHandle`
implements the existing `ExportDecodeSession` contract, so `waitForPts` /
`evictBefore` / the export main loop are unchanged, and the frames convert to
RGB in owned shaders, never by the browser
([ADR 0032](0032-cpu-plane-yuv-converts-in-owned-shaders.md)). The lane is
software-only; hardware-lane readback is profiling-gated future work.

### Failure is loud, and mid-export fallback is forbidden

Cross-engine or cross-source fallback mid-export is FORBIDDEN: a mid-video
quality seam is worse than a failed export, and — the wait having been
skipped — the proxy a fallback would want may not even exist. Seek overshoot
on index-poor files is absorbed inside the Rust session (bounded re-seek
retries); any error the session does surface fails the export ring
immediately, aborting loudly through the existing ring-failure path. The
design admits exactly one same-engine session rebuild before that abort, and
an abort message that names the source and suggests a Lite re-run; the native
lane implements neither yet (the WebCodecs lane keeps its rebuild machinery,
and the failure message is today's generic export error) — both recorded as
roadmap debt rather than silently claimed.

## Considered options

- **Reuse the preview anchor/pump protocol.** Rejected: contract mismatch —
  best-effort realtime delivery cannot express exactly-once range coverage.
- **Pull-per-frame (consumer requests each frame).** Rejected: serializes
  decode behind encode; the credit window keeps both pipelined.
- **Couple decode to `encoderEngine` (one Standard/Lite switch).** Rejected:
  the axes fail independently — encode capability and decode capability have
  different supply chains and different pins.
- **Silent proxy fallback when a native session errors.** Rejected: violates
  the pin's fidelity promise, and the skipped readiness wait means the proxy
  is not guaranteed to exist.

## Consequences

- Blind-spot sources export from their originals: the ProRes differential
  gate holds the native path above the proxy path it replaces (SSIM 0.931 vs
  0.892), and the wedge gates assert `nativeHandles ≥ 1` so a silent fallback
  to the proxy path cannot pass vacuously.
- A `webcodecs` pin preserves the pre-overlay behavior exactly, including the
  full-proxy wait for blind spots.
- One export spawns several concurrent sessions (one per phase group); the
  main process keeps a registry so a renderer crash mid-export cannot strand
  native decode threads (`closeAllExportSw` orphan reclaim).
- 4:2:2 chroma halves before compositing (swscale to I420P10) — the faithful
  ProRes-422 ceiling needs a 4:2:2 transport format; this and the other
  deliberate scope cuts live in the roadmap's export-decode debt list.

## References

- ADR 0029 — native decode ships bytes, not a shared texture (the transport
  precedent this session follows; its preview relay is the pattern
  `exportSw` mirrors).
- ADR 0030 — the decode-engine overlay and the conditional component (the
  intent-persists / resolution-never rule this ADR extends to export).
- ADR 0032 — CPU-plane YUV converts in owned shaders (why the relay's
  buffer-defined frames bypass Chromium's color conversion).
- [`docs/render.md`](../render.md) — export source resolution and the decode
  pipelines as the Worker drives them.
- [`docs/export-ipc-transport.md`](../export-ipc-transport.md) — both
  directions of the export frame transport.
- Gates: `e2e/electron/export-native-wedges.spec.ts`,
  `e2e/electron/export-prores-fidelity.spec.ts`,
  `src/main/export-decode-native.integration.test.ts`, and the
  `export_sw/session.rs` coverage/credit/EOS test suite.
