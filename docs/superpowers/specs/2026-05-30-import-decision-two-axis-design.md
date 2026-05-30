# Import decision model — decompose into two orthogonal axes (Piece A)

Status: design (brainstorming output, pending implementation plan)
Date: 2026-05-30

## Problem

`jobs::proxy_decision::decide` returns a flat 4-variant `ProxyPlan`
(`DirectBoth` / `DirectExportQuickPreview` / `FullProxyOnly` /
`QuickThenFull`). The four variants are the cross-product of **two
independent decisions** that the current code interleaves inside one
function:

- **Export source** — can WebCodecs decode this codec/profile/bit-depth on
  this machine? → use the original, else a full proxy.
- **Preview source** — is the original pleasant to scrub directly (short
  GOP, modest resolution/bitrate)? → preview from the original, else a
  scrub proxy.

Flattening these two axes into one enum is the source of the model's
perceived complexity, and it produced a concrete footgun:
`gop_is_scrub_friendly(None)` returns `true`, so a **long-GOP source whose
GOP probe hiccups is classified `DirectBoth` and never gets any proxy** —
permanent scrub freeze with no recovery. The GOP signal belongs only to the
preview axis, yet in the flattened model it can decide "no proxy at all."

This refactor also matters beyond cleanliness: the **preview axis is the
primary fix for the backward-scrub frame-freeze regression**. Since import
moved to on-demand proxy, preview began feeding the decoder long-GOP,
full-resolution originals (where it used to always get a uniform short-GOP
downscaled proxy). A backward seek past the ring's 0.5 s lookbehind forces
a decoder reset + seek-to-keyframe + forward-decode; on a long-GOP original
that is tens-to-hundreds of full-res frames, so the picture freezes on the
last painted frame while the clock free-runs. Guaranteeing that heavy /
long-GOP footage always gets a short-GOP scrub proxy (the preview axis,
plus the None-GOP fix) collapses that back to the regime where scrub never
froze.

## Scope

This spec is **Piece A only**: refactor the routing logic into two explicit
axes and fix the None-GOP footgun. Two related pieces get their own
later specs:

- **Piece B** — remove the per-machine `DecodeCaps` oracle, replacing
  codec-decodability prediction with per-file trial decode / lazy
  decode-failure recovery. (Forces a rethink of the persisted state, so the
  state-model cleanup lives here, not in Piece A.)
- **Piece C** — playback-engine graceful degradation: decode-gated scrub +
  bidirectional decoded-frame cache + direction-aware prefetch (D2), and
  mid-playback rebuffer / audio-master-clock with frame-drop (D1). Handles
  the residual freeze when preview legitimately reads an original
  (`DirectBoth`, the pre-proxy window, or the proxy toggle off).

## What Piece A does NOT touch

- **Persisted `MediaItem` schema** — `proxy_bypassed`, `export_uses_original`,
  `proxy_path`, `quick_proxy_path` stay exactly as they are. No migration.
  (Piece B reworks the state model.)
- **TS resolvers** (`previewPlaybackPathFor` / `exportPlaybackPathFor`) —
  unchanged; they read the same persisted fields. The job layer still sets
  the same fields it sets today.
- **`DecodeCaps`** — still consumed by the export axis exactly as now.
- **Preview-from-original codec set** — stays **H.264-only**. A short, small,
  decodable HEVC with `caps.hevc` continues to route to `DirectExport`
  (preview = proxy), *not* `DirectBoth`. Widening "preview from original" to
  HEVC is the design doc's open question #2 and is a conscious future
  decision, deliberately **not** smuggled in here. See "Behavior
  preservation" below.
- **Color-metadata bug** — `proxy.rs` / `quick_proxy.rs` pass no
  `-color_primaries/-color_trc/-colorspace/-color_range`, so a ≤540p quick
  proxy of a BT.709 source may render with shifted colors (sub-720p
  BT.601-default trap). This is a separate fidelity bug, tracked as its own
  task, **out of scope** for the decision-model refactor.

## Design

### The two axes

```rust
pub enum ExportSource { Original, FullProxy }
pub enum PreviewSource { Original, Proxy }

pub struct ProxyRoute {
    pub export: ExportSource,
    pub preview: PreviewSource,
}
```

`decide` returns a `ProxyRoute` computed from two predicates that already
exist in the current code — the refactor *renames and separates* them, it
does not invent new logic:

```text
export  = if decodable_directly(media, caps)        { Original } else { FullProxy }
preview = if source_is_safe_to_bypass(media, gop)   { Original } else { Proxy }
```

`source_is_safe_to_bypass` keeps its **full current predicate**, including
the `codec_is_h264` gate, the ≤1080p / ≤25 Mbps / browser-friendly-pixfmt
checks, and the GOP check. `decodable_directly` keeps its current predicate
(H.264 always; HEVC/AV1/VP9 gated by `caps`; browser-friendly pixfmt).

**Invariant:** `preview == Original ⟹ export == Original`. This holds
because `source_is_safe_to_bypass ⟹ decodable_directly` (safe-to-bypass
requires H.264 + friendly pixfmt, and H.264 + friendly pixfmt is always
`decodable_directly`). Therefore `{ FullProxy, Original }` is unreachable.

Non-video short-circuits **before** the predicates, preserving today's
early return:

```text
!Video → { export: Original, preview: Original }   // no proxy
```

### Mapping to current plans (1:1, behavior-preserving)

| `decodable_directly` | `safe_to_bypass` | `ProxyRoute`              | = current plan |
|---|---|---|---|
| true  | true  | `{ Original, Original }`  | `DirectBoth` |
| true  | false | `{ Original, Proxy }`     | `DirectExportQuickPreview` |
| false | false | `{ FullProxy, Proxy }`    | `FullProxyOnly` (small) / `QuickThenFull` (else) |
| false | true  | —                         | unreachable (`safe_to_bypass ⟹ decodable`) |

### Job-layer mapping

`spawn_proxy_decision` consumes `{ export, preview }` plus `is_small_source`
and fans out to today's job paths unchanged:

- `{ Original, Original }` → commit bypass flags, no proxy job.
- `{ Original, Proxy }` → set `export_uses_original`, spawn a standalone
  quick proxy (no chained full proxy).
- `{ FullProxy, Proxy }` + `is_small` → `spawn_proxy` directly (full proxy,
  no quick phase). **`preview = Proxy` resolves to the full proxy here** —
  there is no quick proxy; preview waits for the full proxy. This is today's
  `FullProxyOnly`.
- `{ FullProxy, Proxy }` + not small → `spawn_quick_proxy(then_full = true)`
  (quick → full). `preview = Proxy` resolves to the quick proxy first, then
  the full proxy. Today's `QuickThenFull`.
- `{ FullProxy, Original }` → `unreachable!()` with an explanatory message.

So `FullProxyOnly` stops being a peer plan and becomes a scheduling input
("the source is small enough to skip the quick phase") inside the
`{ FullProxy, Proxy }` branch.

### None-GOP fix (the one deliberate behavior change)

`gop_is_scrub_friendly(None)` flips from `true` → `false`: an unknown GOP is
treated as **not** scrub-friendly. Because the GOP check lives inside
`source_is_safe_to_bypass` (the preview axis), this means a friendly H.264
whose GOP probe failed now fails `safe_to_bypass` → `preview = Proxy`, while
`decodable_directly` still holds → `export = Original`. The file routes to
`{ Original, Proxy }` (DirectExport) instead of `{ Original, Original }`
(DirectBoth-with-no-proxy-forever).

Failure direction inverts from **silent permanent freeze** (long-GOP file
mistakenly bypassed) to **a wasted quick proxy** (friendly short-GOP file on
a probe hiccup) — the graceful direction. This is justified more strongly
now that we know a mis-bypassed long-GOP original freezes on backward scrub
with no recovery.

## Behavior preservation

Every routing outcome is identical to today **except** the None-GOP case.
We prove this mechanically by treating the existing `decide` truth table as
a **characterization oracle**:

- Rewrite each existing test to assert the mapped `{ export, preview }`
  equals what its prior `ProxyPlan` implies (per the mapping table above).
- Add the two cases the current suite is missing:
  - **short + small + HEVC + `caps.hevc`** — must stay `{ Original, Proxy }`
    (DirectExport), proving the preview axis did **not** silently widen to
    HEVC. This case has no coverage today, so without it the refactor could
    regress preview-from-original to HEVC undetected.
  - **friendly H.264 + unknown GOP** — must become `{ Original, Proxy }`
    (the deliberate None-GOP change; previously `DirectBoth`).
- Pin the non-video early return: `!Video → { Original, Original }`.

If every prior case maps identically except the documented None-GOP flip,
behavior preservation is established.

## Consequences / trade-offs

- **Existing frozen `DirectBoth` imports do not self-heal — and that's
  acceptable.** `enqueue_for_media` runs per media item on workspace open
  (`commands.rs` media-pool loop), but short-circuits any item with
  `proxy_bypassed == true` straight to `spawn_decorations` without
  re-running `decide`. A long-GOP file currently mis-bypassed (and frozen)
  stays bypassed after Piece A. The project is pre-release with no projects
  to protect, so a stale frozen import is resolved by re-importing or wiping
  the cache — no migration or self-heal pass is warranted. New imports route
  correctly immediately; non-bypassed proxy-less items also pick up the fix
  on open.
- **Probe-hiccup cost.** With None → not-friendly, every source whose GOP
  probe fails now generates a quick proxy, including friendly H.264 that
  would have instant-bypassed. Acceptable because the failure is graceful and
  probe hiccups are expected to be rare. If the hiccup rate proves
  non-trivial in practice, the follow-up is a separate "harden the GOP probe"
  task — not a revert of this direction.

## Non-goals

- Piece B (remove `DecodeCaps` oracle / trial-decode) and the persisted
  state-model cleanup.
- Piece C (playback-engine graceful degradation, master-clock rework).
- The `-color_*` quick-proxy fidelity fix.
- Widening preview-from-original beyond H.264 (open question #2).
- Migrating the persisted `MediaItem` schema.
- Re-deriving / healing already-imported `proxy_bypassed` items.

## Testing

- **`proxy_decision::decide`** — the characterization truth table above:
  every existing case re-asserted as `{ export, preview }`; new
  short-small-HEVC-with-caps and friendly-H.264-unknown-GOP cases;
  non-video early return.
- **Job-layer mapping** — `{ export, preview, is_small }` → spawned job kind,
  including the `{ FullProxy, Original }` → `unreachable!` guard and the
  small-source skip-quick-phase branch.
- No new TS tests (resolvers untouched). Existing resolver tests must keep
  passing unchanged.

## Open questions

1. GOP probe hiccup rate — does it warrant a follow-up "harden the probe"
   task, or is graceful fallback enough? (Decide from telemetry / observed
   behavior after landing.)
