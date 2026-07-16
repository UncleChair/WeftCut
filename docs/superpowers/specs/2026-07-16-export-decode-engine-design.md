# Export-side decode engine — spec

**Status:** implemented + merged to local main (tickets 01–08, unpushed; durable record = ADR 0033 + the evergreen rewrites in render.md / export-ipc-transport.md / preview.md / roadmap.md)
**Scope:** route export decode through the decode-engine overlay (ADR 0030) so
blind-spot and user-pinned sources export from ORIGINALS via the native
component instead of the lossy full-proxy.

## Problem Statement

Export today is honest for only part of the pipeline. The encode side already
offers a user-selectable engine (`encoderEngine`) with capability gating — CRF,
intermediates, and 10-bit output are native-only and the dialog says so. The
decode side has no such choice: WebCodecs-decodable sources DirectExport from
originals, but WebCodecs-blind formats (ProRes, DNxHD/HR, MPEG-2, VC-1) are
silently decoded from the lossy full-proxy. For the footage where fidelity
matters most — a ProRes master exported to ProRes HQ — the settings panel
promises 10-bit quality that an 8-bit lossy proxy generation has already
destroyed, and the user is never told. Those sources also cannot export until
a minutes-long proxy transcode finishes, even though a native decoder that
reads the original directly ships with the app on Windows.

## Solution

Give export decode the same engine model preview has (ADR 0030) and the encode
side already shipped: a per-project `decodeEngine` setting (`auto` / `ffmpeg` /
`webcodecs`) that stores the user's *intent*, re-resolves capability on every
machine, and never persists a resolution. Under `auto`, every source decodes
from its original by the best available path — in-worker WebCodecs where that
works (today's DirectExport, zero transport cost), the native component's
software lane where it doesn't. The export dialog states, before the export
starts, how many sources will read originals and how many will fall back to a
lossy proxy — and warns only when the answer is lossy. The native path ships
frames as format-tagged CPU bytes (NV12 for 8-bit composites, I420P10 for
10-bit) over the proven classic-IPC relay, driven through the existing
`ExportDecodeSession` contract so the export loop does not change.

## User Stories

1. As a video editor with ProRes footage, I want exports to decode my original
   files directly, so that the output carries no lossy proxy generation.
2. As a video editor, I want to export a blind-spot clip immediately after
   importing it, so that I don't wait minutes for a full-proxy transcode the
   export no longer needs.
3. As a video editor, I want a decode-engine choice (auto / standard / lite)
   in the export dialog, so that I control the same fidelity-versus-
   compatibility tradeoff I already control for preview and for encode.
4. As a video editor using `auto`, I want each source decoded by the best
   path available for it, so that I never pay IPC transport cost on sources
   WebCodecs already decodes in-worker from the original.
5. As a video editor pinning `ffmpeg`, I want every source decoded by the
   native engine, so that one decoder family produces the whole export.
6. As a video editor pinning `ffmpeg` together with software encode, I want a
   bit-reproducible export pipeline, so that re-runs and other machines can
   produce identical output.
7. As a video editor on a machine without the native component, I want the
   standard option grayed out with the reason shown, so that I understand what
   is missing rather than guessing.
8. As a video editor whose saved pin can't be honored on this machine, I want
   the setting to fall back to `auto` rather than fail or lie, so that stale
   project settings never break an export.
9. As a video editor exporting a 10-bit target, I want decode to preserve
   10-bit precision end to end, so that the 10-bit encode lane amplifies a
   full-precision signal, not an already-quantized one.
10. As a video editor exporting ProRes to ProRes HQ, I want no 8-bit choke
    point anywhere in the pipeline, so that the intermediate round-trip is as
    faithful as the format allows.
11. As a video editor, I want the export dialog to tell me how many sources
    will export from originals versus lossy proxies before I click export, so
    that quality surprises are impossible.
12. As a video editor who pinned `webcodecs`, I want a visible warning when
    blind-spot sources will export from a lossy proxy, so that the degradation
    is my informed choice.
13. As a video editor, I want a mid-export decoder failure to abort loudly
    with the failing source named, so that I never unknowingly ship a file
    whose second half silently switched to lower quality.
14. As a video editor, I want transient decoder hiccups absorbed by one
    in-place session rebuild, so that recoverable errors don't cost me a
    finished export.
15. As a collaborator opening the project on another machine, I want the
    engine intent to travel with the project while capability re-resolves
    locally, so that the project never carries a stale machine promise.
16. As a macOS/Linux user, I want native encode to keep working with
    WebCodecs decode, so that the decode component's absence on my platform
    never degrades the encode side.
17. As a video editor with overlapping clips of one source, I want native
    decode sessions grouped by phase exactly as the WebCodecs path groups
    them, so that same-source overlaps export correctly.
18. As a zh-CN user, I want the new control, status reasons, and warnings
    localized, so that the honesty surface reads natively.
19. As a maintainer, I want native decode to slot in behind the existing
    `ExportDecodeSession` contract, so that the export Worker's driving loop
    is untouched and its hard-won wedge fixes keep applying.
20. As a maintainer, I want the historical export wedge scenarios replayed
    against the native path as gates, so that the new Rust-side GOP/EOS logic
    cannot silently regress into the same deadlocks.
21. As a maintainer, I want in-flight frame memory bounded by explicit flow
    control, so that a 4K 10-bit export cannot balloon main-process memory no
    matter how far decode runs ahead of encode.

## Implementation Decisions

Eleven decisions were settled in an interview on 2026-07-16; they are recorded
here as the design of record.

1. **Scope is setting-driven, not fixed policy.** Export decode becomes
   user-selectable, mirroring preview's Standard/Lite model. What persists is
   the user's *intent* (a pin or `auto`); capability re-resolves per machine.
   This follows the `encoderEngine` precedent and does not violate ADR 0030,
   which forbids persisting *resolutions*, not intents.
2. **Independent axis, not a coupled switch.** `ExportSettings` gains
   `decodeEngine: "auto" | "ffmpeg" | "webcodecs"` alongside `encoderEngine`,
   with the same merge-time defense (an unsatisfiable pin falls back to
   `auto`). A single coupled export-engine switch was rejected: the two sides
   have different supply chains (GPL ffmpeg sidecar CLI ships on all
   platforms; the `@weftcut/native-decode` napi component is Windows-only
   today), and "WebCodecs decode + native encode" is a legitimate shipped
   combination a coupled switch would outlaw. Reusing the app-level preview
   decode setting was also rejected: preview's setting is a performance
   preference, export's is a fidelity promise; they must swing independently.
3. **Resolution semantics.** Under `auto`: decodable sources use in-worker
   WebCodecs on the original (today's DirectExport, zero transport);
   blind-spot sources use native decode on the original (new); sources
   neither path can open fall back to full-proxy. Under an `ffmpeg` pin:
   every source routes through native decode. Under a `webcodecs` pin:
   today's behavior exactly, with the lossy-proxy consequence surfaced in the
   dialog. A missing component degrades an `ffmpeg` pin to `auto` with the
   option grayed and the reason shown. v1 places no cap on concurrent native
   sessions; phase-group count is the natural bound, and any cap is deferred
   until profiling demands one.
4. **Bit depth.** The frame transport protocol carries a format tag from day
   one; v1 implements both NV12 (8-bit) and I420P10 (10-bit), selected by the
   export's composite bit depth. I420P10 frames construct the worker's
   ten-bit CPU-plane frame type directly, skipping the VideoFrame round-trip
   entirely — which also retires the previously reverted WebCodecs 10-bit
   direct-export attempt, since the native session has no VideoFrame pool and
   may flush freely. 4:2:2 chroma fidelity is an explicit v2 debt: swscale to
   I420P10 halves ProRes 422's vertical chroma before RGB conversion, same as
   preview eats today.
5. **Software lane only.** The export session always uses the Standard
   engine's software lane. Hardware decode would require a D3D11 readback
   surface that buys nothing for an encode-bound offline job, breaks
   bit-reproducibility across drivers, and forks the 10-bit path. The lane
   remains the engine's private concern (ADR 0030) — no setting exposes it.
   HW readback is documented as not-designed; revisit only if profiling shows
   decode-bound exports.
6. **A dedicated export decode API in the native component.** The
   `@weftcut/native-decode` addon gains an export session:
   open(path, outFormat) → session + metadata; decodeRange(a, b) performs
   GOP-aligned exact coverage of the presentation range and emits frames in
   presentation order; close() tears down. Flow control is a credit window
   (~4–8 frames in flight; the consumer returns a credit per consumed frame),
   which bounds in-flight memory to ~100–200 MB even at 4K 10-bit. Rust owns
   GOP walking, reorder, and EOS drain — the WebCodecs-specific complexity
   (no-mid-flush rule, floated EOS flush, stop-key overshoot, pool-slot
   deadlocks) does not carry over. Reusing the preview anchor/pump protocol
   was rejected as a contract mismatch (best-effort realtime vs.
   exactly-once); pull-per-frame was rejected for serializing decode behind
   encode.
7. **Frame route and worker seam.** Frames cross main → renderer via classic
   IPC and renderer → worker via postMessage transfer — the spike-cleared
   ~1 GB/s route, the mirror of the existing encode chunk channel. On the
   worker side a new native export source handle implements the existing
   `ExportDecodeSession` contract: decodeRange becomes an IPC command, frames
   arriving push into a substantially simpler ring, and waitForPts /
   evictBefore / the export main loop are unchanged.
8. **Resolution point.** Engine resolution for export runs once, at export
   start, on the renderer main thread, as a pure function over the decode
   setting, component presence, blind-spot/probe verdicts, and decode routes.
   It produces a per-media routing table (engine, target URL, transport
   format) that rides the existing init protocol into the Worker; the Worker
   stays policy-free. No mid-export re-resolution, ever. Native-routed
   blind-spot sources skip the pre-export full-proxy wait entirely; a
   `webcodecs` pin keeps today's wait-for-proxy behavior.
9. **Failure semantics.** A transient native-session error gets exactly one
   same-engine session rebuild (re-seek from the last range start; ring
   preserved), mirroring the WebCodecs handle's rebuild precedent. A second
   failure aborts the export loudly through the existing ring-failure path,
   naming the source and suggesting the `webcodecs` fallback for a re-run.
   Cross-engine or cross-source fallback mid-export is FORBIDDEN: a mid-video
   quality seam is worse than a failed export, and the proxy may not even
   exist now that the wait is skipped.
10. **UI surface.** One dropdown (auto / standard / lite) in the export
    dialog's engine section, adjacent to the encode engine control, grayed
    with a reason when the component is absent — preview's exact pattern.
    One routing-summary line computed from the routing-table function at
    dialog-open time ("N sources from originals, M from lossy proxy"),
    warning-styled only when M > 0. No per-clip engine override in v1; the
    routing table's shape leaves room for one later.
11. **Delivery: walking skeleton.** Phase 1 — thinnest end-to-end thread
    (Rust session + relay + worker handle, NV12 only, hardcoded routing, one
    test project), with the same-source-overlap and EOS wedge gates landing
    in the same phase. Phase 2 — the 10-bit lane and its ramp gate. Phase 3 —
    routing table, settings field, readiness integration, remaining gates.
    Phase 4 — UI, i18n, one ADR, evergreen-doc updates, and the v2 debt list.
    Scope stays frozen per phase; discoveries get parked, not chased.

## Testing Decisions

A good test here observes external behavior at an existing seam — the frames a
session delivers, the file an export writes, the resolution a pure function
returns — never the internals of the Rust session or the relay. Three seams,
no new ones:

- **`ExportDecodeSession` (the primary seam).** The wedge-scenario suite
  replays the historically bug-bearing export shapes against the native
  handle: same-source overlapping clips (phase groups), backward clip-reuse
  jumps, EOS tail frames past the video track's end, and a deliberately slow
  consumer stalling the credit window. Prior art: the existing export frame
  store and source handle test suites, which encode exactly these scenarios
  for the WebCodecs handle.
- **The routing-table resolver (pure function).** Unit tests enumerate the
  setting × component-presence × blind-spot × decode-route matrix, including
  pin-fallback and proxy-wait-skip outcomes. Prior art: the export readiness
  tests and the merge-settings defense tests.
- **The conformance harness (the highest seam).** Three end-to-end gates:
  a ProRes fixture (generated by the sidecar, color-tagged) exported through
  native decode with analyzer SSIM/color assertions; a differential assertion
  that the native-decode output is strictly closer to the source than the
  proxy-path output (analyzer output compared with sorted keys, not
  canonicalized — a normalizing twin gate is blind); and a 10-bit ramp
  fixture through the I420P10 transport verifying ramp steps survive into
  10-bit HEVC/AV1 output. Prior art: the media-conformance harness and the
  10-bit ramp probes. These are local-only and component-gated (skip when
  the native component is absent); CI runs the pure-function tests on all
  three platforms plus a smoke asserting the resolver degrades correctly on
  component-less platforms.

## Out of Scope

- **4:2:2 transport and compositing** — v1 accepts the 422→420 chroma cost
  (documented); the faithful ProRes-422-to-yuv422p10le ceiling needs a 422
  transport format plus composite-chokepoint support.
- **Hardware-lane readback** for export decode; not designed, profiling-gated.
- **Concurrent native-session caps** and any decode memory budget beyond the
  credit window.
- **Per-clip decode-engine overrides** in the export dialog.
- **A cross-machine bit-reproducibility gate** (the `ffmpeg` pin + software
  encode promise) — wanted, but needs two-machine baseline management; build
  it as a permanent harness once the path has settled.
- **Routing decodable sources through native for performance** (the re-seek
  redundancy motive) — `auto` deliberately keeps them in-worker; revisit with
  profiling.
- **The macOS/Linux native-component supply chain** — unchanged from the
  roadmap: on those platforms the standard option is unavailable, not broken.

## Further Notes

- The interview also confirmed the encode side needs no work: `encoderEngine`,
  its capability gating, and its merge-time defenses already implement the
  Lite/Standard model this spec extends to decode.
- An ADR consolidating the durable decisions (export decode joins the engine
  overlay; the export session API and credit transport; the
  no-mid-export-fallback rule) is a phase-4 deliverable; ADRs 0029/0030 are
  its direct ancestors and the transport findings live in the
  export-frame-transport spike record.
- The roadmap's "Export-side decode consumes the overlay" bullet and the
  preview/export docs get their evergreen rewrite in phase 4, per the
  documentation discipline.
