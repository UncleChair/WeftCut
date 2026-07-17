# 03 — Replace the inline HUD with an on-demand Dev Performance Monitor

**What to build:** Remove the small Preview performance overlay and expose the existing detailed Performance Monitor only through a Dev-only dropdown that opens or focuses one independent Electron window, while all telemetry work sleeps when that window is closed.

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] Preview no longer renders inline performance chrome or supports its former visibility/position interaction.
- [x] A development-only menu action opens or focuses the existing singleton Performance Monitor window.
- [x] Production builds do not render the Dev menu or Performance Monitor entry.
- [x] Closing the independent window stops animation frames, compositor polling, system-metrics polling, snapshot broadcasts, and reset listeners.
- [x] Unit and Electron tests cover singleton reuse, window lifecycle, absence of inline HUD, and idle telemetry.
