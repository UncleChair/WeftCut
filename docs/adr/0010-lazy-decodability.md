---
status: accepted
---

# Lazy decodability — export pre-flight instead of a capability oracle

Export-source decodability for non-H.264 codecs is decided by **trying**, not by
a predictive per-machine capability profile. The `DecodeCaps` oracle (a startup
`VideoDecoder.isConfigSupported` probe persisted to `decode_caps.json` and read by
`decide`) is removed.

`jobs::proxy_decision::decide` routes the export axis by **static facts only**:
8-bit browser-friendly pixfmt + a codec in the WebCodecs family
`{h264, hevc, av1, vp9}` ⇒ `Original`; otherwise (10-bit/HDR, or a non-family
codec like ProRes/MPEG-2) ⇒ `FullProxy`. Whether *this machine* actually decodes
a family codec is confirmed by a main-thread **pre-flight decode** at export
start (`probeSourceDecodable`): configure a decoder and decode one key packet,
racing the outcome against the decoder's error callback **and** a deadline —
"undecodable" = errored OR no frame within the deadline OR a synchronous
configure throw (WebCodecs can silently stall, so the timeout arm is required).
A failure enqueues a full proxy (`ensure_full_proxy`) and aborts the export with
a retry message, before the export Worker is launched, so no partial file is
produced.

## Why

The oracle was a predictive, machine-wide, persisted, cross-process guess (a
generic 4K profile, not the actual file; `isConfigSupported` can over-report
software decoders) that could be wrong on a specific file — which is why the
DirectExport design already owed a decode-failure recovery as a backstop. Lazy
decodability stops guessing and uses ground truth, and the recovery it needs is
the one already owed — so deleting the oracle nets less machinery for the same
correctness guarantee.

## Decodability is an export-only question

The preview axis is H.264-only (`source_is_safe_to_bypass`), and the preview
resolver no longer falls through to a non-H.264 original (a DirectExport source
previews from its quick proxy, or shows nothing until it lands). So preview never
decodes a non-H.264 original, and the entire decode-failure surface lives on the
export path.

## Consequences

- Incapability is re-discovered per session rather than cached: on a machine that
  cannot decode a codec, the first export of each such source pre-flight-fails and
  enqueues a proxy; an interrupted recovery proxy re-fails on the next attempt.
  On a capable machine the pre-flight always passes — zero cost.
- No persisted state-model change: recovery sets `proxy_path`, which the existing
  resolvers prefer.
- VP8 is excluded from the family (extinct; routed to a full proxy).
- A DirectExport source whose quick proxy fails to generate previews blank rather
  than decoding its (possibly undecodable) original.
