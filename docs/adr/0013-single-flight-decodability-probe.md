---
status: accepted
---

# Single-flight the decodability pre-flight probe

The decodability probe (`probeSourceDecodable` — configure a `VideoDecoder`,
decode one key packet, race the outcome against the decoder's error callback
and a deadline; see ADR 0010) runs from two independent paths: the import
preview sweep (which route-corrects an undecodable DirectExport source to a
proxy) and the export-readiness gate (`prepareExportMedia`, the pre-flight that
runs before the export Worker launches). Both — plus the preview decoder for any
clip already on the timeline — open WebCodecs decoders that draw from the same
hardware buffer pool (~13 slots on common desktop GPUs; ADR 0004).

**The probe must be single-flight per source.** When two probes — or a probe and
an active preview decode — of the same source run concurrently, they exhaust the
pool: neither decoder produces a frame before the deadline, the probe times out,
and a perfectly decodable source is reported undecodable. That false negative
needlessly route-corrects the source to a full proxy, and the decision is sticky
— a proxied source leaves the probe candidate set and is never re-probed.

The export gate therefore **defers to an in-flight sweep probe** instead of
launching its own. If the shared probe memo already holds `"pending"` for a
referenced source, the gate does not re-probe: `export_uses_original` is still
true, so `exportPlaybackPathFor` returns the original and `waitForProxies`
resolves on its first check. The export Worker's own decoder is the real
backstop — if the source is genuinely undecodable, the Worker's decode fails and
the existing recovery (route-correct + retry from the proxy) takes over.

## Why

The probe is a pre-flight, not the decode of record. Gating an export on a probe
that false-negatives under transient buffer-pool pressure fails an export the
Worker would have completed. Deferring to the one in-flight verdict removes the
redundant decoder, and the Worker's decode is the ground truth regardless.

Serializing the two probes against each other (a global probe mutex) was
considered and rejected: it does not help when the *preview* decoder is the
contender (a lone serialized probe still times out against an active preview),
and it adds latency. Deferring sidesteps the probe entirely in the contended
window.

## Consequences

- The export gate trusts the import sweep's in-flight verdict during the brief
  `"pending"` window; it re-probes only when no probe is in flight and the memo
  is cold.
- The decodability guarantee in that window rests on the Worker's own decode plus
  the existing route-correct-and-retry recovery, not on a second pre-flight.
- Residual, not yet addressed: the probe maps a deadline **timeout** (ambiguous
  under load) and a hard decode **error** (definitive) to the same `false`, so
  the import sweep can still route-correct on a bare timeout under heavier
  contention than normal use produces. A future refinement would distinguish the
  two and avoid a sticky route-correction on a mere timeout.
