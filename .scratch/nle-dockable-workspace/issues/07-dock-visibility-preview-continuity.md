# 07 — Preserve Preview and Timeline continuity across Dock visibility

**What to build:** Keep open Panel state and expensive playback resources alive while tabs are hidden or Panels move, but gate unnecessary work by Dock visibility and destroy resources only when a Panel is actually closed.

**Blocked by:** 04 — Introduce the Dock Tree and built-in Editing layout.

**Status:** ready-for-agent

- [ ] Preview retains Playback Engine and Compositor identity across tab switches, moves, resizes, header transitions, and maximize/restore.
- [ ] Hidden Preview suppresses painting and other unnecessary visible-only work without stopping clock or audio ownership.
- [ ] Timeline and Preview respond to Dock resize through their existing size seams.
- [ ] Closing a Panel destroys its UI/resource instance and reopening creates a new one.
- [ ] The existing real Master meter sample is published through a renderer store instead of requiring consumers to reach into the Compositor.
- [ ] Lifecycle and integration tests use stable resource probes and visibility events under React StrictMode.
