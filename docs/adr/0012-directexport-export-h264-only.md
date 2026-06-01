---
status: accepted
---

# DirectExport export-from-original is H.264-only (Worker decode limitation)

`export_decodable_statically` (`jobs::proxy_decision`) gates the **export** axis
to `Original` only for **H.264** (8-bit, browser-friendly pixfmt). HEVC / AV1 /
VP9 — previously admitted as a "WebCodecs family codec" — now route to a
**full proxy** for export.

## Why

Export decodes the source's **original** inside a **Web Worker**
(`ExportDecoderPool` in `render/worker/exportWorker.ts`). The decode-capability
of a codec in a Worker is not the same as on the main thread:

- The main-thread import probe (`probeSourceDecodable`) and the preview path
  decode on the **main thread**, where this machine has hardware AV1 (and, with
  the OS extension, HEVC) decode → they succeed.
- The export **Worker** can silently fall back to **software** decode
  (`isConfigSupported(prefer-hardware)` returns `true` optimistically, but the
  Worker doesn't actually get the hardware path). On common Windows WebView2,
  **software AV1 decode STALLS** (no output after the first frame) and
  **software HEVC errors** ("Unsupported configuration"). Either wedges the
  export at frame 0 (the encode loop awaits a source frame that never arrives).

So `probeSourceDecodable` passing on the main thread does **not** guarantee the
Worker can decode the original — the probe can't see the Worker's capability.
Symptom: exporting an 8-bit AV1 (DirectExport) hung at 0% with the decoder
emitting only `output #1`.

H.264 is the one codec with universal hardware decode that is proven to decode
reliably in Worker scope, so export-from-original is restricted to it. HEVC /
AV1 / VP9 export via an H.264 full proxy, which the Worker decodes fine.

## Scope / non-goals

- **Preview is unaffected.** Preview (incl. the decodable-preview bridge) decodes
  on the main thread; HEVC/AV1/VP9 still preview from their original where the
  main thread can decode them.
- Existing media imported before this change keep their persisted
  `export_uses_original` flag; they must be re-imported (or have a proxy
  generated) to pick up the new route. No migration is shipped.
- Widening export-from-original to another codec requires **verifying Worker
  decode for it** (not just `isConfigSupported`, not just main-thread decode).
- This supersedes the "8-bit WebCodecs family" export scope from
  [0009](0009-two-axis-proxy-decision.md) / the DirectExport design for the
  export axis only; the preview axis is unchanged.
