# Preview decode scrub stall — investigation (open)

Status: **root cause NOT yet pinned; diagnostic instrumentation shipped,
candidate fix identified, awaiting a repro to confirm before fixing.**

## Symptom (real WebView2, 2026-06-12, user session)

Scrubbing/playing a project (1080p30 comp; one Hi10P 1080p anime clip on
a 720p 8-bit proxy + a countdown Motif) produced, in F12:

```
decoder throughput: 28 frames in 30291ms (0.9 fps) [total=75 queue=20 ring=1@501ms]
frameAt(733333) → null (ringFirst=null ringLast=null)
A VideoFrame was garbage collected without being closed.
```

i.e. a ~30 s window where preview decode crawled at ~0.9 fps with the
decoder input queue stuck at 20 and the ring nearly empty, then recovered
to ~36 fps on play. Surfaced while the user was setting up a 10-bit export
— but the stall is **pre-export**: the export path suspends the preview
compositor (`PixiPreview.tsx` `setSuspended(true)`), so it is not
export↔preview decode contention.

## Established (by reading code + the session logs)

- Preview ring (`FrameRing`) stores **ImageBitmap**, not VideoFrame; the
  decoder output callback in `SourceDecoderPool` snapshots via
  `createImageBitmap(frame)` and `frame.close()`s in every path (success,
  bitmap-identity-mismatch, conversion-error, decoder-replaced). So the
  steady-state pool-hold the snapshot was added to fix (the line ~335
  comment) is handled.
- **The real code-visible gap:** the pump (`PacketPump`) bounds the INPUT
  queue (`decodeQueueSize < MAX_QUEUE=24`) but nothing bounds the
  OUTPUT-side count of VideoFrames decoded-but-not-yet-snapshotted. Each
  such in-flight frame pins one hardware-decoder output-pool slot (~13 on
  desktop GPUs). A decode burst (the pump can dispatch up to 24) that
  outruns `createImageBitmap` resolution exhausts the pool → the decoder
  can't allocate an output buffer → stall until conversions resolve and
  free slots. This matches "queue=20 stuck, ring≈1, ~1 output/s".
- The stall window coincides with the **countdown Motif** attach/setup,
  which captures via a hidden `motif-host` WebView2 + CDP
  `Page.captureScreenshot` (GPU-heavy, ~98 ms cold/1080p — see the
  Tauri-WebView2-CDP reference). A plausible co-trigger: Motif capture
  saturates the GPU, throttling `createImageBitmap` to ~1/s, which then
  pins the pool via the gap above.

## Unknown (needs the shipped instrumentation on a repro)

1. Is the stall **pool-pinning** (many frames awaiting `createImageBitmap`)
   or **external GPU starvation** (few in flight, but each conversion slow)?
   → The `inflight=/peak=` fields added to the throughput log
   (`SourceDecoderPool`, commit `4e6896b1`) answer this directly: a high
   `peak` (→ ~13) means pool-pinning; a low `peak` with slow fps means
   starvation.
2. Source of `A VideoFrame was garbage collected without being closed` —
   not located to any `SourceDecoderPool` path (all close). Candidates: the
   export worker's lane under load, or a frame orphaned if a
   `createImageBitmap` promise is dropped under extreme pressure. Re-confirm
   which window emits it (main vs. export worker) on repro.

## Candidate fix (do NOT implement before the instrumentation confirms #1)

If the repro shows a high `peak` (pool-pinning), bound the output side: add
a `conversionsInFlight` gate the pump checks alongside `decodeQueueSize`
(e.g. pause dispatch when in-flight conversions ≥ ~8, leaving headroom
under the ~13 pool ceiling). This converts a hard 0.9-fps wedge into a
graceful conversion-paced slowdown and closes the documented
pool-exhaustion mechanism's remaining half. `conversionsInFlight` already
exists as a field (added for the diagnostic); the fix is to expose it to
`PacketPump` (via the `PumpDecoder`/handle interface) and gate the fill
loop on it.

If instead the repro shows GPU starvation from Motif capture, the lever is
Motif-side (throttle/cache capture during scrub), not the decoder.

## Notes

- Pre-existing issue (ADR 0004 / the WebCodecs buffer-pool reference), not a
  regression from the 10-bit export work.
- 23.976 fps source into a 30 fps composition is a separate, expected
  resampling default — not part of this stall.
