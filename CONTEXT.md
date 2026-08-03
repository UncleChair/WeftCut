# WeftCut

WeftCut is an Electron + napi-rs desktop video editor. This file is the
project's glossary — the canonical word for each domain concept. It holds no
implementation detail; the shape of the data lives in [`docs/data-model.md`](docs/data-model.md)
and the decisions in [`docs/adr/`](docs/adr/).

## Decode routing

**Decode Route**:
The per-source decision of where preview and where export each read their
pixels from — one of Bypass, DirectExport, or Proxied. Distinct from a
source's *readiness* (whether the file the route names has been generated yet).
_Avoid_: proxy plan, proxy mode, routing flags

**Bypass**:
A Decode Route where preview and export both read the original source directly;
no proxy is ever made.
_Avoid_: direct, no-proxy, direct-both

**DirectExport**:
A Decode Route where export reads the original source and preview reads a quick
proxy.
_Avoid_: original-export, direct-export-quick-preview

**Proxied**:
A Decode Route where preview reads a quick proxy and export reads an export
master.
_Avoid_: full-proxy, transcoded

**Quick proxy**:
A small, short-GOP scrub copy of a source, used only as a preview source —
never an export source.
_Avoid_: preview proxy, scrub proxy, proxy (unqualified)

**Export master**:
A source-resolution copy of a source that WebCodecs can decode, used only as an
export source — never a preview source.
_Avoid_: full proxy, proxy (unqualified)

**Session bridge**:
Formerly: machine-specific, non-persisted knowledge that this machine can
decode a source's original, letting preview read the original before any
proxy lands. That behavior is now the ordinary outcome of the [Decode
engine](#decode-routing) resolving the Lite engine on an original whenever
WebCodecs can decode it. The term names only the residual WebCodecs-original
probe memo the resolver still consults, on its way to full retirement.
_Avoid_: decode memo, probe cache

**Decode engine**:
The runtime overlay that resolves, per source and per session, an **engine**
(Standard or Lite) and a **source** (original or proxy) — from the
decode-engine setting, the [Capability cache](#decode-routing), and the
source's read-only Decode Route. Hardware-vs-software is private to the
Standard engine, never part of the resolution. Preview re-resolves every
session; export resolves once at export start into a frozen per-media
routing table (`resolveExportDecodeRouting`, ADR 0033) and never mid-run.
What persists is only the user's *intent* (the app-level preview setting;
the per-project export `decodeEngine`), never a resolution.
_Avoid_: decode route (that's the persisted disk truth), tier, preset

**Standard engine**:
The FFmpeg decode engine (setting value `ffmpeg`) — decodes any original
in-process, privately choosing a hardware (d3d11va shared-texture) or software
(NV12-over-IPC) lane. Needs the optional native-decode component.
_Avoid_: native engine, ffmpeg lane

**Lite engine**:
The WebCodecs decode engine (setting value `webcodecs`) — the compatibility
floor, always present, decodes whatever the browser's WebCodecs can open.
_Avoid_: webcodecs lane, browser decoder

**Automatic**:
The default decode-engine setting (`auto`): resolves to the Standard engine
when its component is loaded and hasn't failed for the source, otherwise the
Lite engine. Not itself an engine — a resolution rule.
_Avoid_: auto engine

**Unsupported**:
The Decode engine resolution state when the chosen engine cannot decode the
chosen source (the Lite engine on an original WebCodecs can't open, or a
pinned Standard engine with no component). Surfaced as a placeholder card with
a Switch-to-Standard action — never a silent proxy swap.
_Avoid_: unplayable, black frame, fallback

**Capability cache**:
Machine-level probe verdicts — can this machine's decoders open a given
format/lane — keyed by format class, persisted by main and invalidated when
the component's ffmpeg changes. A property of the machine, never of a
project.
_Avoid_: session bridge, decode memo

## Transitions

**Transition direction**:
The **motion** direction of a Wipe or Slide, never the reveal side (industry
convention): `Wipe left` = the reveal boundary sweeps right-to-left across
the frame; `Slide left` = the incoming layer enters from the right edge
moving left. Agents consume the enum directly, so this reading is the wire
contract's meaning (ADR 0035).
_Avoid_: reveal side, wipe from, source edge

**Start-at-cut**:
The alignment of every transition: the window occupies the incoming layer's
first `duration` microseconds, and only the outgoing layer extends forward —
pulling its tail source handle — to open the authorized overlap. The cut
instant is the window's start, not its midpoint (ADR 0035); center-at-cut and
end-at-cut are future additive parameters.
_Avoid_: centered transition, symmetric overlap, cut-straddling window

## Transform

**Linked scale**:
A layer state (`Transform.scale_linked`, default on) in which the two scale
tracks are structural twins and every editing surface shows and writes them as
one "Scale". Not a keyframe mode — `Animated` stays Static/Keyframed; linking
is editor behavior plus a self-healing flag: any write that diverges the pair
clears it in the same commit, and re-linking snaps `scale_y` to a copy of
`scale_x`.
_Avoid_: uniform-scale mode, scale lock, third keyframe mode
