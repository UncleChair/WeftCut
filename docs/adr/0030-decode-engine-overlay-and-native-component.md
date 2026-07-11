---
status: accepted
---

# The decode engine is a runtime overlay, and native decode ships as a conditional component

## Context

Decode routing has so far named exactly one persisted fact per source: the
[Decode Route](../../CONTEXT.md#decode-routing) — which derivatives exist on
disk, decided once by `decide()` and folded into a small enum (ADR 0028).
That fact answers "what can this source play from," not "which decoder
should play it right now" — a question whose answer depends on the machine
(does it have a GPU decode path, a native software decoder, can WebCodecs
open this codec at all), not on the project. Two mechanisms had been
conflating those questions: an `experimental_native_sw_decode` toggle that
hard-coded one machine-dependent choice as a project-wide boolean (ADR 0029),
and the Session bridge, which folded a WebCodecs-decodability probe into a
temporary preview-path override living beside — not inside — the persisted
route.

Widening native decode into a full second engine (a hardware lane and a
software lane) standing beside WebCodecs multiplies this question: a source's
decoder is now chosen from a settings tier plus two kinds of machine
knowledge — a capability probe cached per machine, and the runtime presence
of an optional native component. Naming where each of those facts lives, and
confirming none of them leak into the project file, is this ADR's first
decision.

The native runtime is also new supply-chain surface: it links `ffmpeg-next`
and therefore real shared libraries (avcodec, avformat, swscale) that the
existing addon has never required. Whether linking them is safe to make
unconditional, and what license line the linkage draws, are the second and
third decisions.

## Decision

### The decode engine is a session overlay over three independent layers of truth

- **Disk — `DecodeRoute`.** Unchanged by this design: still the persisted
  record of which derivatives exist for a source, still decided once by
  `decide()`. Nothing about engine selection reads or writes this enum
  differently than before.
- **Machine — the capability cache.** Whether this machine's decoders can
  open a given format/lane is a fact about the machine, cached and
  invalidated on driver or component change, keyed by format class rather
  than by project or source. It is not part of any project file and does
  not travel with a project between machines.
- **Session — the resolution.** A pure function, `resolveEngineTier`, takes
  the decode-engine setting (`auto` / `native` / `webcodecs`), the
  capability cache's verdicts, and the read-only `DecodeRoute`, and returns
  one of four tiers: native-hardware, WebCodecs-original, native-software,
  or proxy. Nothing it resolves is written back to either of the other two
  layers — reopening a project, or moving it to another machine, re-runs
  the resolution from nothing.

No engine state — setting, capability verdict, or resolved tier — is ever
persisted into a media item or into `DecodeRoute`. Capability is a machine
property; the project only ever records which derivatives exist, never which
decoder should read them.

### The native runtime is a conditionally-first-class split addon

Native decode — its hardware and software lanes, and their `ffmpeg-next`
linkage — lives in its own addon, `@weftcut/native-decode`, separate from the
core addon. The isolation is structural, not a packaging nicety: a missing
`avcodec` entry in a single addon's import table fails that addon's
`require()` outright. If native decode lived inside the core addon, a
missing DLL on one machine would take jobs, export, and the MCP surface down
with it, none of which touch `ffmpeg-next` at all.

Main loads the component lazily, once, in a try/catch around
`require('@weftcut/native-decode')`. Failure is not an error state — it is
the ordinary "this machine doesn't have it yet" case. The native tiers drop
out of `auto`'s resolution order, the decode-engine setting's native option
is grayed out with the failure reason, and the rest of the application stays
fully functional. This level-0 gate is what the rest of the native-decode
surface is built on. The component is bundled with the Windows installer
today; its absence elsewhere is a packaging state, not a defect.

### The addon split is not the license boundary

In-process decode links an LGPL ffmpeg build — banner-gated at fetch, build,
and package time so a GPL build can never enter the shipped binary — because
LGPL decoders already cover every format this engine targets (ProRes,
DNxHD/HR, MPEG-2, VC-1, dav1d) with no need for GPL-only encoders. The
sidecar CLI used for export and batch jobs remains a GPL ffmpeg build,
isolated behind a pipe.

Splitting native decode into its own addon changes nothing about that line.
Under the FSF's plugin doctrine, a plugin that is dynamically loaded and
calls into a library's functions forms one combined work with it at runtime,
regardless of the process or module boundary between them — a separate
`.node` file is not a separate legal work. The boundary that matters is which
*build* of ffmpeg a component links: LGPL in-process, GPL only in the
sidecar behind its pipe. The addon split is a supply-chain and
failure-isolation decision; it does no licensing work by itself.

## Considered options

- **Persist the resolved engine tier onto the media item or `DecodeRoute`**
  (e.g. "last known good decoder"). Rejected: reintroduces exactly the bug
  the overlay exists to avoid — a project would carry a stale, machine-bound
  promise that either does nothing useful (faster machine, re-resolves
  higher anyway) or actively lies (slower machine, promised tier not
  actually available).
- **Fold native decode into the core addon behind a compile-time feature.**
  Rejected: a compile-time flag bakes a yes/no decision into one binary at
  build time, but the real requirement is a single shipped binary that
  behaves correctly whether or not the DLLs exist on *this* machine (missing
  redistributables, a stripped-down install). Only a runtime gate can
  represent "present at build time, absent at run time."
- **Treat the addon split itself as the licensing separation and skip
  banner-gating the fetch/build/package steps.** Rejected: the plugin
  doctrine means the split buys nothing licensing-wise on its own; the
  actual constraint is on which ffmpeg build gets linked, and that has to be
  asserted independently of how many addons it's linked into.

## Consequences

- Engine resolution is safe to reason about locally: given the same three
  inputs it always returns the same tier, with no hidden mutable state to
  audit.
- A project file never encodes which machine most recently played it
  fastest; opening the same project on a weaker machine degrades gracefully
  through the same four tiers instead of inheriting a stale "this machine
  could do it" fact.
- The core addon keeps its existing feature set and never links
  `ffmpeg-next`; the standard build needs no `FFMPEG_DIR` or libclang. The
  native-decode component is a second build product with its own DLL
  bundling, and its absence is a first-class, user-visible state rather than
  a startup crash.
- The LGPL/GPL split is unaffected by how many addons ffmpeg is linked into;
  any future native-decode consumer must link the same LGPL build, not a
  convenient GPL one, or the boundary this ADR names moves with it.

## References

- ADR 0021 — color converges at ingest; the working space is the output
  space (the chokepoint every decode lane, native or WebCodecs, still feeds
  into unchanged).
- ADR 0028 — Decode Route persisted as a folded enum (the disk layer this
  overlay reads and never writes).
- ADR 0029 — native software decode ships bytes, not a shared texture (the
  transport and single-color-model precedent the native software lane still
  follows; its toggle is replaced by the decode-engine setting's `auto`).
- [`CONTEXT.md`](../../CONTEXT.md) — Decode engine, Capability cache, Decode
  Route, Session bridge.
- [`docs/preview.md`](../preview.md#decode-engine) — the resolution flow and
  tier order as consumed by preview.
