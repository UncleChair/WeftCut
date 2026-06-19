---
status: accepted
---

# Short fixed-GOP proxy for frame-accurate scrubbing

The full preview proxy uses a short fixed GOP (`PROXY_GOP_FRAMES`, currently 6 frames) via `-g`/`-keyint_min`, replacing the prior `round(source_fps)` (~1 s) GOP. `-bf 0` is retained.

## Context

The renderer seeks by decoding from a target's keyframe forward to the target frame. With a ~1 s GOP, a mid-GOP scrub target had to decode up to ~30 frames (~1.2 s at the measured decode rate) before `frameAt(target)` could be satisfied. Scrubbing *within* a GOP therefore showed a static frame until the user paused long enough for the decode to finish — and a naive "decode during drag" timer made it worse: it re-targeted the decoder ~10× faster than one seek's decode completed, flushing every in-flight decode (churn) and never landing a frame.

Instrumentation isolated the bottleneck: during a scrub burst the decoder sustains realtime throughput, the `weftcut-media://` reads are cache-served (no I/O stall), and `createImageBitmap` is negligible. The only thing setting per-seek latency is **decode-from-keyframe depth**, which is set by GOP size. So the fix lives in the proxy recipe, not the frontend.

## Decision

Shorten the GOP to a short fixed frame count so any scrub target decodes at most `PROXY_GOP_FRAMES - 1` frames from its IDR — a few frames regardless of source fps. This bounds per-seek decode latency to a handful of frames, which (a) makes a settle-seek land in ~tens of ms instead of ~1.2 s, and (b) makes periodic decode-during-drag viable without churn, because each seek's decode now completes well within the re-target interval. The frontend re-enables decode-during-drag on top of this.

`PROXY_FORMAT_VERSION` bumps to 5; the existing open-time regeneration (`invalidate_stale_proxies` clears proxies below the current version, the background derivative fan-out re-encodes them, the job's success patch re-stamps the version) rebuilds every proxy automatically — no new pipeline.

## Relationship to ADR 0003

ADR 0003 ("Forward GOP-crossings don't reset the decoder") is **retained and becomes more load-bearing**: with a 6-frame GOP the pump crosses an IDR roughly every 0.2 s, and it must keep flowing the new IDR's `"key"` chunk in-stream without `reset()` + `ring.flush()`. Re-introducing the spurious forward-GOP reset would now stall playback ~5×/s. This ADR changes GOP *size* only; the no-reset policy is unchanged. ADR 0003's original rationale (1 s-GOP to bound the seek tail) is superseded here — the seek tail is now bounded by frame count, which is tighter.

## Consequences / trade-offs

- **Proxy ~50 % larger** (denser keyframes). Proxies are local-only cache and regenerable; the larger size is acceptable.
- **Export is unaffected.** Proxy-based export decodes then re-encodes with its own GOP, so the proxy's keyframe density does not propagate to exported files; if anything, denser keyframes are equal-or-better decode input.
- **`-bf 0` retained**, so PTS = DTS and the auto-pause last-frame snap (PROXY_FORMAT_VERSION 4) still holds — GOP size is orthogonal to B-frame reorder.
- **Quick proxy unchanged** (ADR 0006): it remuxes/fast-transcodes for speed and keeps its own GOP, so scrubbing is coarse until the full proxy is ready.
- **`PROXY_GOP_FRAMES` is tunable**: smaller → smoother live scrub, larger proxy. If truly-instant every-frame live scrubbing is wanted, the next step is a dedicated low-resolution all-intra *scrub* proxy alongside the play/export proxy (a new derivative riding the same background pipeline, plus frontend source-switching) — deferred until the short-GOP feel is judged insufficient.
