# Comment style

How to write — and how much to write — in source comments. The goal is comments
that earn their space: they tell a reader something the code cannot, and they
stay true as the code changes.

## Principle: evergreen, with the landmine exception

A comment reads as if authored today. The same rule the `docs/` tree follows
applies in code: **history, dates, commit hashes, phase numbers, and superseded
approaches do not belong inline.** Their home is git history, an ADR, or a
`project_*` / `feedback_*` memory note.

There is exactly one exception — the **landmine**. When the history *is* the
constraint ("you cannot change this because X breaks"), that single fact stays
inline, in compressed form. A landmine is not "here is what we used to do"; it is
"here is the wall you will hit if you undo this." See
[Protected comments](#protected--never-cut-even-though-it-looks-like-history).

## What a comment carries

In priority order, a comment may hold these four kinds of content:

1. **Abstraction-level summary** — what this unit does, one level above the code,
   and *only* when the name and signature don't already say it. A summary that
   restates the identifier is noise.
2. **The non-obvious why** — a counter-intuitive choice, a constraint, or the
   reason behind an invariant. If a reader would ask "why is it done *this* way?"
   and the answer isn't visible in the code, answer it here.
3. **Landmines / invariants** — "change X and Y deadlocks", "must stay
   byte-identical to its twin", "this ordering is load-bearing". The evergreen
   exception lives here.
4. **Pointers** — a link to the ADR, the spec section, or the twin file that
   carries the full story. Pointers are cheap and high-value; prefer a pointer
   over inlining the full rationale.

## What a comment never carries

- **How** — the code is the authoritative statement of how. Don't narrate it.
- **Restating the obvious** — a comment that paraphrases the next line earns
  nothing.
- **Rejected approaches** — what we tried and dropped lives in git/ADR. The lone
  exception is when re-introducing it would reintroduce a bug, in which case it
  is a landmine: one line, not a postmortem.
- **Dates, commit hashes, phase numbers** — these date the comment and rot.
- **Changelogs / per-version history** — see
  [Changelog-shaped comments](#changelog-shaped-comments).

## One home per fact: say it once, at the most specific site

A fact stated twice drifts. Rationale sinks to the **most specific site** that
owns it — the constant, the function, the field. The file-level `//!` (Rust) or
top-of-file (TS) header is for **navigation only**:

- what the module owns,
- what it explicitly does **not** own (the boundary), and
- a pointer to the spec / ADR.

The header does not re-explain a rationale that already lives at a constant below
it. If you find yourself writing the same "why" in the header and at the
constant, delete it from the header and leave a pointer.

## Changelog-shaped comments

An enumerated "v0 → v1 → v2 …" history inside a comment is the most expensive
form of rot. Collapse it to **current state + the rule**:

- the rule that governs the value ("bump this when the args change; older
  artifacts are invalidated and re-encoded"), and
- whatever about the *current* version is load-bearing (a constraint you'd break
  if you didn't know it).

Per-version diffs go to the ADR and git. Knowing what v2 was buys nothing once v2
no longer exists on disk.

## Protected — never cut even though it looks like history

These read like history but are load-bearing landmines. A compression pass must
**preserve** them (compressing the wording is fine; deleting the fact is not):

- **Cross-language twins.** `ENGINE_SOURCE` (animation resolution, TS ↔ Rust) and
  `snap_frame_round` / `snapFrameRound` (time snapping, TS ↔ Rust) must stay
  byte-identical; no automated test enforces it. The "diff both sides when you
  touch one" warning is the only guard.
- **Deadlock landmines.** "No `flush()` between ranges — flushing deadlocks
  against the VideoFrame pool slots the worker holds" (export decoder) and the
  EOS-tail flush ordering are not history; they are the reason the code is shaped
  the way it is.
- **Counter-intuitive probe gotchas.** A lone IDR self-stalls until `flush()`;
  `prefer-hardware` turns AV1 support into a false negative; the WebCodecs
  encoder ignores input `colorSpace`; holding `VideoFrame`s past ~13 slots stalls
  the decoder pool. Each looks like trivia and is actually a wall.

When in doubt about whether a history-shaped comment is a landmine, ask: *if a
future maintainer deleted this and "fixed" the code accordingly, would something
break?* If yes, it stays.

## Before / after

Real examples from this codebase.

### Collapse a changelog

**Before** — eight versions of archaeology on one constant:

```rust
/// Bump whenever the proxy ffmpeg args change ...
///
/// Versions:
///   0 — pre-versioning / legacy. ~8 s GOP from libx264 defaults.
///   1 — `-g 30 -keyint_min 30` for ~1 s keyframe spacing; 540p cap.
///   2 — 1080p cap (replaces 540p) ... `avc1.640028` decodes universally.
///   3 — GOP scales with source fps ... See ADR 0003.
///   4 — `-bf 0` disables B-frames ... (full paragraph on the CTS reorder offset)
///   5 — short fixed GOP ... See ADR 0008.
///   6 — export master: cap raised 1080p->2160p ... See ADR 0011.
///   7 — source color tags asserted ... (ADR 0014's full-range follow-up).
pub const PROXY_FORMAT_VERSION: u32 = 7;
```

**After** — the rule, plus what's load-bearing about the *current* version:

```rust
/// Bump whenever the proxy ffmpeg args change in a way that affects playback,
/// scrub, or color: `io::load_from_dir` invalidates any proxy whose stored
/// version is older, and the background job re-encodes it.
///
/// Current format: export master, source-resolution H.264 capped at 2160p, High
/// profile, `-bf 0` (PTS=DTS — keeps the auto-pause last-frame snap correct),
/// short fixed GOP (`PROXY_GOP_FRAMES`), and source color tags asserted with
/// `+write_colr` so mediabunny reads a `colr` atom. See ADR 0008, 0011, 0014.
pub const PROXY_FORMAT_VERSION: u32 = 7;
```

The `-bf 0` note survives as a landmine (turning B-frames back on breaks the
snap); the per-version diffs move to the ADRs they already cite.

### Kill header ↔ constant duplication

**Before** — the short-GOP rationale is told in the `//!` header *and* again at
the constant:

```rust
//! ... GOP is a short fixed frame count (`PROXY_GOP_FRAMES`) so any scrub
//! target decodes at most a few frames from its keyframe — the enabler for
//! frame-accurate live scrubbing. This shortens the seek-to-IDR tail from
//! ~1 s ... See ADR 0008 ...

/// Keyframe spacing (frames) for the full proxy. Short + fixed so any scrub
/// target decodes at most `PROXY_GOP_FRAMES - 1` frames from its keyframe,
/// bounding seek latency ... — the enabler for frame-accurate live scrubbing.
/// Replaces the prior `round(source_fps)` (~1 s) GOP ... See ADR 0008 ...
pub const PROXY_GOP_FRAMES: u32 = 6;
```

**After** — the header navigates; the constant owns the why, said once:

```rust
//! Proxy generation: transcodes a source to an H.264/AAC export master for
//! codecs WebCodecs can't decode directly. Preview reads the lighter quick
//! proxy, not this. See ADR 0011; output at `<cache>/proxies/<file_hash>.mp4`.

/// Keyframe spacing for the proxy. Short and fixed so any scrub target decodes
/// at most `PROXY_GOP_FRAMES - 1` frames from its keyframe — the enabler for
/// frame-accurate live scrubbing. `-bf 0` is kept so PTS=DTS holds. See ADR 0008.
pub const PROXY_GOP_FRAMES: u32 = 6;
```

### Trim history, keep the constraint

**Before** — a load-bearing cap buried in comparative history:

```rust
/// 10-bit lane ring cap, derived from RESOLUTION ... 1080p (6.2 MB) hits the 48
/// ceiling — today's behavior unchanged at ~300 MB; 4K (24.9 MB) clamps to the
/// 20 floor ≈ 500 MB (vs 1.2 GB when the cap was a flat 48 entries). The MIN
/// floor is the deadlock guard: ... No live byte accounting ... (known
/// limitation). ...
```

**After** — keep the formula's intent and the deadlock guard (a landmine); drop
the "vs 1.2 GB when the cap was flat" comparison:

```rust
/// 10-bit ring cap, derived from coded frame size: a byte target / frame bytes,
/// clamped to [MIN, MAX]. The MIN floor is the deadlock guard — output is
/// presentation-ordered, so an unsatisfied waiter implies everything held is
/// evictable, but the floor keeps headroom over the DPB-16 reorder window.
/// No cross-ring budget: N simultaneous 10-bit sources stack N× this bound.
```
