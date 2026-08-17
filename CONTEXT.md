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

## Track placement

**Track**:
The kind-agnostic container a layer sits in — the data object (`Project.tracks`,
ordered bottom-of-z-stack first). Not something the user provisions: tracks
appear and disappear around where media is placed (ADR 0042), so there is no
add, remove or reorder surface for one.
_Avoid_: channel, layer container, timeline row (that is the lane)

**Lane**:
A track's rendered row in the timeline — the presentation, not the object
(`TrackLane.tsx`, `laneEls`). Say lane when the subject is the row on screen and
track when it is the thing holding layers. Unrelated to a decode engine's
hardware / software lane, which is a decode path.
_Avoid_: lane as a synonym for track in data-model or command prose

**Reserved skeleton**:
The role-stamped tracks a blank project ships with — A roll, B roll, and the
audio-role tracks derived from them. Non-removable, never swept by cleanup, and
the reason "no tracks exist" is never a case the UI handles. Carrying a `role`
is exactly what makes a track part of it.
_Avoid_: default tracks, system tracks, fixed tracks

**Transient**:
The `Track.transient` flag, read as *not part of the reserved skeleton* —
stamped on every track whose `role` is `None`, including one an agent creates
deliberately. The name predates the meaning and reads like "temporary", which it
is not: the flag says a track is eligible for cleanup, not that it is doomed.
The invariant is `transient == (role is None)` at every creation site.
_Avoid_: temporary track, scratch track, auto track

**Derived name**:
The name a track is shown under when it stores none (`label === null`, blank
counting as absent) — from its `role` for the reserved skeleton, otherwise a
positional number that renumbers as tracks come and go. Computed at display time
in the renderer, never stored, because only the renderer can localize it.
`trackName.ts` is the single answer for every surface.
_Avoid_: auto label, placeholder name, default label

**Cleanup**:
The one rule that removes a track: *a track disappears when its last layer
leaves it* — `transient && !locked`, applied to the track an edit just emptied,
never as a project-wide sweep. A track that was born empty was never emptied, so
one an agent creates on purpose survives.
_Avoid_: prune (that is the function), auto-delete, garbage collection

**Drop strip**:
The permanently reserved row above the topmost lane that turns a drag into a new
track. Its space is held even when idle so a drag never reflows the timeline, and
it shows itself only while a drag is live so it never reads as an empty lane to
manage.
_Avoid_: add-track row, new-track button, ghost lane, phantom track

**Raise**:
Moving a clip onto a fresh track at the top of the z-stack —
`move_layers_to_new_track`, reachable by dragging into the drop strip or by the
*Move to a new track* command. The spawn-at-top gesture, and only that —
anchored reordering is *Restack*. Each raise empties its source track, which
cleanup then removes. One history entry, so one undo restores clip and track
together.
_Avoid_: add track and move, promote, bring to front, reorder tracks, restack

**Restack**:
Anchored z-reorder of one visual layer — `restack_layer(layer, above|below
anchor)`, the verb behind the Nearby panel's stack ordering and the MCP command
of the same name. Operates on the layer, not its container: a sole occupant
carries its whole track, a layer sharing its track splits onto a fresh one, and
a role-stamped source never moves. Anchors are layers, never indices; audio
neither moves nor anchors. The op's exact contract lives in data-model.md.
_Avoid_: raise (that is spawn-at-top), reorder tracks, move above/below

**Spawn**:
The placement verdict meaning *no track can take this, so make one* — the fourth
`PlacementValidity`, alongside valid, collision and locked. Ranked below
collision, so a selection that would overlap itself on the one new track still
refuses.
_Avoid_: auto-create, insert track, overflow

## Motifs

**Motif**:
A parameterized, time-varying overlay authored as a real web page — a manifest
island plus `index.html`, served over the `motif:` scheme and captured frame by
frame while the harness owns the clock (ADR 0017). Built-in, user-authored and
agent-authored Motifs are the same kind of document on the same render path;
placed, one is a `Motif` layer whose props are its entire instance state.
_Avoid_: template (that was the SVG predecessor), overlay, animation preset

**Props schema (data plane)**:
A Motif's `props_schema` — the four typed variants (string, color, number, enum)
its parameters may take. It is the *data* contract and nothing else: validation,
defaults, lenient migration, persistence, undo and agent drafting all read it,
and it carries no presentation — no label, order, grouping or widget hint.
Frozen: a control the vocabulary lacks comes from a params page, never from a
fifth variant (ADR 0045).
_Avoid_: prop types, control schema, param spec (that is one entry in it)

**Params page (UI plane)**:
The optional `params.html` a Motif ships beside its `index.html` to own its whole
props section of the property panel — labels, order, grouping, conditional rows.
The file's presence is the only enablement; there is no manifest field. It runs
in a sandboxed, offline `motif:` frame on an opaque origin and speaks five
postMessage verbs with the host (init, propsChanged, preview, commit, resize):
preview overlays the canvas only, and one commit is one undo entry however many
keys it carries (ADR 0045).
_Avoid_: params UI, custom panel, plugin UI, settings page

**Fallback form**:
The props form the host generates from a `props_schema` when the Motif ships no
params page — one row per prop in the manifest's key order, bare keys title-cased and
deliberately unlocalized, one key committed per gesture. The default path rather
than a degraded one: an agent draft or a plain Motif stays editable with zero
author effort, and the form is frozen at the four variants alongside the schema.
_Avoid_: generated panel, default form, auto form, generic props form
