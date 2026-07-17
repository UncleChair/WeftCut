# 14 — Deliver the responsive Role Mixer controls

**What to build:** Present the four accepted Audio Roles as responsive channel strips or rows with complete project-wide gain and flag controls, preserving WeftCut's current recorded gain and unrecorded mute/solo semantics.

**Blocked by:** 02 — Extract five semantic tool Panel boundaries.

**Status:** ready-for-agent

- [ ] Dialogue, Music, SFX, and Voiceover are always the grouping axis; Tracks are never presented as mixer channels.
- [ ] Wide groups render channel strips and narrow groups render rows without losing controls.
- [ ] Every Role supports gain fader, numeric dB entry, mute, solo, and reset.
- [ ] Gain remains recorded; mute and solo retain their accepted unrecorded preference-shaped behaviour.
- [ ] Component and actor tests cover responsive presentation, reset, gain history, and mute/solo history preservation.
