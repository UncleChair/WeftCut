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
proxy lands. That behavior is now subsumed by the [Decode engine](#decode-routing)'s
`webcodecs-original` tier, which resolves to the original whenever WebCodecs
can decode it, proxy or no proxy. The term now names only the residual
probe-memo plumbing behind that tier, on its way to full retirement in a
later phase.
_Avoid_: decode memo, probe cache

**Decode engine**:
The runtime overlay that resolves a per-source decode tier — `native-hw`,
`webcodecs-original`, `native-sw`, or `proxy` — from the decode-engine
setting, the [Capability cache](#decode-routing), and the source's read-only
Decode Route. Re-resolved every session; never itself persisted into the
project.
_Avoid_: decode route (that's the persisted disk truth), preset

**Capability cache**:
Machine-level probe verdicts — can this machine's decoders open a given
format/lane — keyed by format class, persisted by main and invalidated when
the component's ffmpeg changes. A property of the machine, never of a
project.
_Avoid_: session bridge, decode memo
