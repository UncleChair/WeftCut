# 15 — Add Role Gain audition and the real Master meter

**What to build:** Make Role Gain gestures audibly preview through a renderer-local override, commit once when confirmed, cancel cleanly with Escape, and display the real Master RMS/Peak signal without inventing per-Role buses or meters.

**Blocked by:** 07 — Preserve Preview and Timeline continuity across Dock visibility; 14 — Deliver the responsive Role Mixer controls.

**Status:** ready-for-agent

- [ ] Fader movement updates preview audio immediately through a renderer-local Role override.
- [ ] Release or confirmation records exactly one final Role gain command.
- [ ] Escape restores the original sound and value without a history entry.
- [ ] Role Mixer subscribes to the shared real Master RMS/Peak store and performs no direct Compositor polling.
- [ ] No per-Role meter, real bus, Role pan, or Role Effect semantics are introduced.
- [ ] Override, audio fold, component, one-commit, cancellation, and real Electron playback tests cover the flow.
