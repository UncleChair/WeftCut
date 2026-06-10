---
status: accepted
---

# DirectExport export-from-original is gated to Worker-decodable codecs (H.264 + AV1)

`export_decodable_statically` (`jobs::proxy_decision`) admits a source's
**original** onto the export axis (`ExportSource::Original`) only when it is an
8-bit, browser-friendly pixel format AND its codec is one the export Worker is
proven to hardware-decode: **H.264 or AV1**. HEVC, VP9, and everything else
route to an **H.264 full proxy** for export.

## Why

Export decodes the source's original inside a **Web Worker**
(`ExportDecoderPool` in `render/worker/exportWorker.ts`), and a codec's decode
capability there is not guaranteed to match the main thread:

- H.264 and AV1 are verified to **hardware-decode in Worker scope** on Windows
  WebView2 — by a real `VideoDecoder.decode()` test (30/30 frames, NV12) and by
  a full in-app AV1 export that completes end to end.
- HEVC needs the OS "HEVC Video Extensions", which are absent on the reference
  machine (decode errors / stalls). VP9 Worker decode is unverified. Both route
  to a proxy until verified.

`isConfigSupported` is **not** evidence — it returns `true` optimistically for
codecs that then fail to decode. Admit a new codec only after a real Worker
`decode()` confirms it.

### Cross-machine safety net

The static codec gate is a fast default, not a guarantee for every GPU. The
frontend `probeSourceDecodable` gate (import sweep + the export-readiness gate
in `runPixiExport`) is the backstop: on a machine that cannot decode an admitted
codec (e.g. AV1 on a GPU without AV1 decode), the probe fails and the export is
route-corrected to a proxy before it runs.

### Note on the earlier "H.264-only" restriction

A prior revision restricted this to H.264 alone, on the theory that the Worker
could not decode AV1 — an AV1 export had wedged at frame 0. That theory was
wrong. The Worker decodes AV1 fine; the wedge was a **PTS-grid deadlock in
`ExportFrameStore.waitForPts`** (it gated on strict interval containment, which
never matched when the decoder's PTS grid drifted off the integer
`i × frameDurUs` output grid). With that fixed, AV1 export-from-original
completes, so AV1 is admitted here.

## Scope / non-goals

- **Preview is unaffected.** Preview (incl. the decodable-preview bridge)
  decodes on the main thread; HEVC/AV1/VP9 still preview from their original
  where the main thread can decode them.
- Existing media imported before this routing change keep their persisted
  `export_uses_original` flag; re-import (or proxy generation) picks up the new
  route. The export-readiness probe still protects them at export time.
- Widening export-from-original to another codec requires **verifying Worker
  decode for it** (a real `decode()`, not `isConfigSupported`, not just
  main-thread decode).
