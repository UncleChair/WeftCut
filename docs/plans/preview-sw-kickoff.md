# preview-sw Phase 2 **Plan B** — playback-resolution throttle + Full/½/¼/Auto UI

**Single source of record.** This note is the design of record for the one
unshipped piece of the native software-decode work: the playback-resolution
throttle and its UI. The originating design spec
(`docs/superpowers/specs/2026-07-05-ffmpeg-sw-decode-blindspot-design.md`) has
been **consolidated and deleted** — everything else it specified either shipped
or was superseded by the dual-engine decode/export architecture. Read those
evergreen homes for context, this note for what remains:
`docs/preview.md` §Decode engine, `docs/render.md` §Export source resolution,
`docs/export-ipc-transport.md`, and ADRs 0029/0030/0032/0033. **Delete this note
once Plan B ships.**

## Status — Plan A SHIPPED, Plan B is all that's left
Phase 2 was split in two. **Plan A is done and on `main`:** the whole
WebCodecs-blind family (ProRes / DNxHD·DNxHR / MPEG-2 / VC-1 / WMV3) routes to
native SW preview, plus per-family threading (`thread_count` = cores; FRAME|SLICE,
slice-only for intra ProRes/DNxHD), robust long-GOP seek, and the
audio-clock-locked frame-drop floor. See commits `afa9b73b`, `467742e6`,
`5b9dcb3f`, `d4c53d4f`. Decoder lives at
`apps/desktop/native/decode/src/preview_sw/decoder.rs`.

The dual-engine architecture Plan B was sequenced behind (engine overlay,
export-side decode, preview/export session split) has since **shipped** — see
`docs/roadmap.md` §Decode engine. So **Plan B is now unblocked.**

**Plan B has NOT shipped:** the playback-resolution throttle and its
Premiere-style Full / ½ / ¼ / Auto UI. It is Standard-engine playback UX layered
on top of the shipped engine overlay — not part of the raw decode path.

## What Plan B is — design of record
The native path's degrade stack has three levers, all applied **inside** the
native path — proxy is never an automatic fallback
(`feedback_native_nle_conventions`):

1. always-on per-family threading — **shipped (Plan A)**;
2. **playback-resolution throttle — this plan**;
3. audio-clock-locked frame-drop floor — **shipped (Plan A)**.

The throttle is a user-facing playback-resolution control:

- **Levels:** a Premiere-style **Full / ½ / ¼** dropdown, plus an **Auto** mode
  that drives the level off the observed frame-drop rate.
- **Mechanism:** at <Full, swscale downscales **on the decode thread**, shrinking
  the transfer payload **quadratically** (½ ⇒ ¼ bytes, ¼ ⇒ 1/16 bytes). This is
  the direct mitigation of the IPC transport's only weakness — payload size.
- **Full resolution is always restored on pause/scrub** — the throttle is a
  playback-only concession; a paused or scrubbed frame is always full quality.
- **Trap (do not forget):** the throttle does **not** cut decode cost.
  ProRes/DNxHD have no low-res decode ladder, so throttling means
  decode-full-then-swscale-down — it saves IPC + GPU upload + composite, not the
  decode itself. Decode-boundness is treated only by threads (lever 1) and
  frame-drop (lever 3).

## Design forks to resolve first
Real forks worth grilling before writing the plan — start with
**superpowers:brainstorming**:
- **Auto behavior:** how the level ramps up and down, and the hysteresis needed
  to avoid oscillating between levels on a marginal source.
- **Scope of the setting:** is the level a per-project preference or an app-wide
  `AppSettings` setting?

## Code seams
- **Throttle (new):** swscale downscale in `preview_sw` (decode full, scale to
  ½/¼) driven by a per-session resolution level; plumb the level through napi +
  ipc. The renderer transport already reconstructs whatever frame size arrives,
  so **no renderer decode change is needed**. Restore full res on pause/scrub.
- **UI:** a playback-resolution dropdown (Full/½/¼/Auto) — new `AppSettings` or
  per-project pref + a control near the preview.
- **Auto mode:** wire the level to the observed frame-drop rate — the frame-drop
  floor already exists (Plan A), so reuse its signal rather than adding a counter.

## Validation
- Extend `apps/desktop/e2e/electron/preview-sw-conformance.spec.ts` to cover each
  throttle level: per-level SSIM (a downscaled frame still matches an ffmpeg
  reference within tolerance) plus a payload-size assertion (½/¼ actually shrink
  the transfer quadratically).
- Extend the decode-bench matrix with a per-level arm (informative, not a CI gate).

## Recommended flow
**superpowers:brainstorming** (the design forks above) →
**superpowers:writing-plans** → subagent-driven-development. Confirm the current
engine-overlay state in `docs/preview.md` §Decode engine first, since Plan B
lands on top of it.

## Gotchas still live
- **Single color model:** derive the frame's `VideoColorSpace` from the MAPPED
  `sourceColor` (`ffprobeColorToWebCodecs`), NEVER cast raw ffmpeg `.name()` tag
  strings — a downscaled frame is still a native NV12 frame carrying a stamped
  color space, and invalid wide-gamut/HDR enums will throw (see ADR 0032 /
  `nv12Frame.ts`).
- **Never auto-swap** a software clip to a proxy (`ActiveClip.isSoftware` guard,
  `feedback_native_nle_conventions`) — the throttle degrades *within* the native
  path.
- **CI feature union:** `preview-sw` stays OUT of the default CI feature union;
  Rust tests need `--features jobs,export,mcp,cloud,preview-sw`; `napi:build`
  passes ONE union `--features` flag and needs the app closed (`.node` lock;
  `.node` + `index.d.ts` are gitignored).
