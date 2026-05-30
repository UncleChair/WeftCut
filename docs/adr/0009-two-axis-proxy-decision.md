---
status: accepted
---

# Two-axis proxy decision (export source × preview source)

> **Superseded in part by [ADR 0010](0010-lazy-decodability.md).** The
> export-axis decodability mechanism described below — `decodable_directly`
> plus the per-machine `DecodeCaps` probe, and "the `DecodeCaps` oracle is
> unchanged" — no longer holds: the oracle is removed and the export axis is a
> static predicate (`export_decodable_statically`) confirmed by an export-time
> pre-flight decode. The two-axis decomposition, the `job_for` scheduler, and
> the unknown-GOP direction below still stand.

`jobs::proxy_decision::decide` returns a `ProxyRoute { export, preview }`
instead of a flat plan enum. The two axes are independent:

- **Export source** (`ExportSource::Original | FullProxy`) — driven by
  `decodable_directly`: can WebCodecs decode this codec/profile/bit-depth on
  this machine (H.264 always; HEVC/AV1/VP9 gated by the `DecodeCaps` probe;
  8-bit browser-friendly pixfmt required)?
- **Preview source** (`PreviewSource::Original | Proxy`) — driven by
  `source_is_safe_to_bypass`: is the original pleasant to scrub directly
  (H.264, <=1080p, <=25 Mbps, browser-friendly pixfmt, short GOP)?

Invariant: `preview == Original` implies `export == Original`, because
`source_is_safe_to_bypass` is a strict subset of `decodable_directly`. So
`{ FullProxy, Original }` is unreachable. A pure `job_for(route, is_small)`
maps the route to the background job, absorbing the small-source
"skip the quick phase" choice that the prior flat enum encoded as a peer
variant.

## Why

The prior `ProxyPlan` (`DirectBoth` / `DirectExportQuickPreview` /
`FullProxyOnly` / `QuickThenFull`) was the cross-product of these two axes
flattened into one enum, which interleaved the export and preview decisions
inside one function and let the GOP signal — which only concerns scrub
comfort — decide "no proxy at all." That produced a footgun: a long-GOP
source whose GOP probe failed was bypassed with no proxy and froze on
backward scrub. The decomposition isolates each axis and is the primary fix
for that freeze regression: heavy / long-GOP footage is now guaranteed a
short-GOP scrub proxy on the preview axis.

## Unknown-GOP direction

`gop_is_scrub_friendly(None)` is `false`: an unknown GOP is treated as not
scrub-friendly, so a probe hiccup generates a scrub proxy (a small waste)
rather than a silent permanent freeze. The same helper governs
`quick_proxy::can_remux`, so an unknown-GOP source is transcoded to a short
GOP rather than remuxed.

## Preserved behavior / non-goals

- Preview-from-original stays **H.264-only**. A decodable HEVC (even short
  and small, with `caps.hevc`) routes to `{ Original, Proxy }`
  (export from original, preview from proxy), not to bypass. Widening
  preview-from-original beyond H.264 is a separate future decision.
- No persisted-schema change: `proxy_bypassed`, `export_uses_original`,
  `proxy_path`, `quick_proxy_path` and the TS resolvers are untouched. The
  `DecodeCaps` oracle is unchanged. (Both are revisited in the later
  oracle-removal work.)
- Existing `proxy_bypassed` imports are not re-routed on open
  (`enqueue_for_media` short-circuits them); pre-release, a stale frozen
  import is resolved by re-import or cache wipe.
