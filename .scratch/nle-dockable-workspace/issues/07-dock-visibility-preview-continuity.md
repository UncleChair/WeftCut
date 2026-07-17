# 07 — Preserve Preview and Timeline continuity across Dock visibility

**What to build:** Keep open Panel state and expensive playback resources alive while tabs are hidden or Panels move, but gate unnecessary work by Dock visibility and destroy resources only when a Panel is actually closed.

**Blocked by:** 04 — Introduce the Dock Tree and built-in Editing layout.

**Status:** completed

- [x] Preview retains Playback Engine and Compositor identity across tab switches, moves, resizes, header transitions, and maximize/restore.
- [x] Hidden Preview suppresses painting and other unnecessary visible-only work without stopping clock or audio ownership.
- [x] Timeline and Preview respond to Dock resize through their existing size seams.
- [x] Closing a Panel destroys its UI/resource instance and reopening creates a new one.
- [x] The existing real Master meter sample is published through a renderer store instead of requiring consumers to reach into the Compositor.
- [x] Lifecycle and integration tests use stable resource probes and visibility events under React StrictMode.

## Validation

- Dockview visibility stays behind the WeftCut Panel runtime contract and uses only public `api.isVisible` / `api.onDidVisibilityChange`; the StrictMode fake contract proves one live subscription and an unchanged Preview resource token through hidden/visible transitions.
- Hidden Preview removes only Pixi's low-priority render callback and gates Compositor visual/decode/prewarm work after its audio pass. The Playback Engine remains on the live ticker, so clock anchors, audio scheduling, auto-pause, and playhead publication continue.
- The production Electron resource probe proved a real center-drop move/header transition and tab switch keep the same Playback Engine/Compositor generation. While hidden, `presentedCompositeCount` stopped while `ownerCompositeCount` and `positionUs` advanced with `playing: true`; reactivation resumed presentation with the same generation.
- The production Electron close/reopen test proved close clears the live resource probe and reopen creates a different generation. Existing Dockview `renderer: "always"`, public resize seams (`ResizeObserver` in Timeline and the fill-sized Preview surface), and maximize/restore adapter paths remain intact.
- The existing `AudioGraph.meterSnapshot()` owner now publishes its real RMS/peak sample to `masterMeterStore` before the existing MCP report; silence is normalized and owner disposal clears stale readings. Future Role Mixer code can subscribe without reaching into Compositor.
- Focused Vitest: 4 files, 11 tests passed (Dock Workspace StrictMode/visibility, Pixi presentation gate, Master meter store, and AudioGraph).
- Renderer Vitest: 269 files passed, 1 skipped; 2,144 tests passed, 19 skipped.
- Renderer TypeScript: `npx tsc -b apps/desktop/tsconfig.web.json --pretty false` passed.
- E2E build: `VITE_WEFTCUT_E2E=1 npx electron-vite build` passed.
- Electron acceptance: the existing Editing-layout smoke passed; after correcting test-only setup (creating actual Preview content and dropping from the six-dot handle onto the Preview content center), both new lifecycle tests passed (2/2).
- `npx react-doctor@latest --verbose --scope changed` was attempted once; the package runner produced no output and was terminated after roughly 40 seconds, so no score was available.
