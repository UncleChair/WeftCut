# preview-sw Phase 2 **Plan B** — playback-resolution throttle + Full/½/¼/Auto UI (handoff)

**Read first:** the design spec `docs/superpowers/specs/2026-07-05-ffmpeg-sw-decode-blindspot-design.md`
(§4.2 + §11 are the design of record for what remains), plus the evergreen homes of the
consolidated dual-engine work: `docs/preview.md` §Decode engine and
`docs/adr/0030-decode-engine-overlay-and-native-component.md`.
This note is a working handoff, not evergreen docs — delete it once Plan B ships.

## Status — Plan A SHIPPED, Plan B is all that's left
Phase 2 was split in two. **Plan A is done and on `main`:** the whole WebCodecs-blind family
(ProRes / DNxHD·DNxHR / MPEG-2 / VC-1 / WMV3) routes to native SW preview, plus per-family
threading (`thread_count` = cores; FRAME|SLICE, slice-only for intra ProRes/DNxHD), robust
long-GOP seek, and the audio-clock-locked frame-drop floor. See commits `afa9b73b`,
`467742e6`, `5b9dcb3f`, `d4c53d4f`. Decoder now lives at
`apps/desktop/native/decode/src/preview_sw/decoder.rs` (moved during the decode-engine collapse).

**Plan B (this handoff) has NOT shipped:** the §4.2 **playback-resolution throttle** and its
**Premiere-style Full / ½ / ¼ / Auto UI**. It is re-sequenced (2026-07-09) to land AFTER the
dual-engine architecture's **Phase D** — it is Standard-engine UX and sits on top of the engine
resolution module, not part of the raw decode path.

## What Plan B is (spec §4.2)
A user-facing playback-resolution control. At <Full, swscale downscales **on the decode thread**,
shrinking the transfer payload quadratically (½ ⇒ ¼ bytes, ¼ ⇒ 1/16) — the direct mitigation of
the IPC-transport cost. An `Auto` mode drives the level off the observed frame-drop rate. **Full
resolution is always restored on pause/scrub.** (Note the spec's trap §1.2.3: this throttles
downstream + IPC cost, it does NOT cut ProRes/DNxHD decode cost — those have no low-res decode.)

## Code seams for Plan B
- **Throttle (new):** swscale downscale in `preview_sw` (decode full, scale to ½/¼) driven by a
  per-session resolution level; plumb the level through napi + ipc; the renderer `SwSourceHandle`
  already reconstructs whatever frame size arrives, so no renderer decode change is needed. Restore
  full res on pause/scrub.
- **UI:** a playback-resolution dropdown (Full/½/¼/Auto) — new `AppSettings` or per-project pref +
  a control near the preview.
- **Auto mode:** wire the level to the observed frame-drop rate (frame-drop floor already exists in
  Plan A — reuse its signal rather than adding a new counter).
- **Validation:** extend the decode-bench matrix + `preview-sw-conformance.spec.ts` to cover each
  throttle level (per-level SSIM / payload-size assertion).

## Recommended first step
Start with **superpowers:brainstorming** (the Auto behavior + the Full/½/¼ UX is a real design fork
worth grilling — how Auto ramps, hysteresis, whether the level is a project pref or an app setting),
then **superpowers:writing-plans**, then subagent-driven-development. Confirm the current dual-engine
Phase D state in `docs/preview.md` first, since Plan B lands on top of it.

## Gotchas still live for Plan B
- Single color model: derive `VideoColorSpace` from the MAPPED `sourceColor`
  (`ffprobeColorToWebCodecs`), NEVER cast raw ffmpeg `.name()` tag strings — a downscaled frame is
  still a `new VideoFrame` and will throw on invalid wide-gamut/HDR enums.
- Compositor must NEVER auto-swap a software clip to a proxy (`ActiveClip.isSoftware` guard) —
  `feedback_native_nle_conventions`. The throttle degrades *within* the native path.
- `preview-sw` stays OUT of the CI feature union; Rust tests need
  `--features jobs,export,mcp,cloud,preview-sw`; napi:build passes ONE union `--features` flag and
  needs the app closed (`.node` lock; `.node` + `index.d.ts` are gitignored).
