# S2 State-Core Acceptance Notes

## Tests

**`cargo test --lib` (napi cdylib build):** 334 passed; 0 failed.

Tests span the full `state/` actor (mutations, undo/redo, frame-alignment, checkpoint,
history lock, serialization), `io/` round-trips, `view_state`, `recents`,
`workspace`, and the `napi_backend` integration layer (project_summary, add_track
event emission, persistence round-trip, app_settings emit).

**Playwright S2 smoke (`e2e:electron`):** 1 passed (553 ms). The boot+add_track
test (`e2e/electron/s2-smoke.spec.ts`) launches the built Electron app, reads the
baseline track count from `project_summary`, calls `add_track`, and asserts
`track_count` grew by exactly 1.

## Parity Evidence

Three-point equivalence proof that the napi addon carries the same project-summary
semantics as the Tauri build:

1. **Code-path identity.** `build_project_summary` and all response structs were
   moved byte-identically from the old Tauri `commands.rs` into
   `src/commands/mod.rs` during Task 3 (commit `c1807d34`). The function was not
   reimplemented — git history confirms the same code is in both contexts.

2. **Unit-test parity.** The 334 passing `cargo test --lib` tests exercise the
   identical `state/` actor, history, and serialization logic that ran under the
   Tauri build. The Tauri runtime was never part of this logic; stripping it
   changes only the IPC transport, not the project model.

3. **Live persistence round-trip.** The `save_as_then_open_round_trips_and_logs`
   test (napi_backend.rs line 444) creates a real `.vproj` on disk via
   `project_save_as`, opens it in a fresh `Backend` instance via `project_open`,
   and asserts `track_count` is identical before and after serialization. This test
   passes in the 334-test run above.

   The Playwright smoke additionally verifies the bridge end-to-end: the built
   Electron app (`out/main/index.js` + napi addon) accepts `invoke('add_track')`
   and reflects the mutation in `invoke('project_summary')` — the same
   `window.api.invoke` surface the UI uses.

## What Works After S2

- **Project lifecycle:** `project_new_workspace`, `project_open`, `project_save`,
  `project_save_as`, `project_summary`.
- **All mutations:** add/delete/move/trim/split/duplicate layers, add tracks,
  text/color/subtitles/motif layers, markers, groups, composition patch,
  role gain/flags, track flags, separate audio.
- **Undo/redo:** `project_undo`, `project_redo`, `project_restore_checkpoint`,
  checkpoint list, history lock/unlock.
- **Settings/prefs:** `app_settings_get/set`, `export_settings_get/set`,
  `recents_*`, `keybindings_*`, `agent_session_get/end`.
- **Logs:** `log_list`, `log_clear`, `log_emit`, `log_dir_path`.
- **Live UI via event bridge:** `project:changed`, `app_settings:changed`,
  `agent_session:changed`, `log:entry` events flow through the napi TSFN bridge
  to the Electron preload's `contextBridge`, reaching the React UI without polling.

## Gated OFF (return "unavailable: ... S3/S4/S5")

Any command not listed above falls through the `dispatch` match to:

```
Err("unavailable: '{cmd}' is wired in a later stage (S3/S4/S5)")
```

Gated subsystems include: jobs/import/proxy/thumbnails/waveform, export (video
encode/WS videosink), cloud/keys (transcription/TTS/keyring), MCP server, motif
capture, media_drop (drag-drop), sysmon.

## Known S2 Deviations / Follow-ups for S3+

- **`audio` + `ffmpeg` modules** gated behind `any(jobs, export)` — both off in S2;
  re-enable when S3 wires jobs.
- **`motifs::catalog` inline mod** kept ungated (pure serde data, no capture dep)
  so the state actor can clamp Motif-layer content windows without the full
  `motifs` feature.
- **`io::probe` + `ffmpeg`** gated behind `jobs`; not reachable until S3.
- **`jobs::enqueue_for_media` fan-out** dropped from `project_open` (was in old
  Tauri `project_open` command); must be re-wired in S3 when jobs go live.
- **`path:join` / `path:tempDir` shims** resolve `undefined` — no main-process
  handler is installed yet; affects any UI code that calls `join()`/`tempDir()`.
  Fix in S3 main wiring.
- **`tauri-window onResized` no-op** — the maximize glyph in `WindowControls.tsx`
  won't track native window resize events until the IPC bridge handles
  `window:onResized`. Not a functional regression for S2.
- **`log:entry` EventSink path** lacks a dedicated S2 Playwright test; coverage
  comes from `add_track_then_summary_grows_and_emits` (T6) which installs a bus
  in the Rust test only.
- **`add_track_then_summary_grows_and_emits`** uses a fixed 50 ms sleep for the
  broadcast bridge task; can flake under high parallel load — harden with a poll
  loop in a later cleanup.
- **`use chrono::Utc` in `history.rs`** produces an unused-import warning in
  release builds; benign, suppress or remove in S3 cleanup.
- **Gated command bodies recoverable** from git at
  `4a0dda90:apps/desktop/src-tauri/src/commands.rs` (the pre-split legacy file).
