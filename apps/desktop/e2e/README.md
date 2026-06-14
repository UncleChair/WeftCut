# WeftCut E2E suite — authoring & maintenance guide

These tests drive the **real app in the real WebView2** (via `tauri-driver` +
`msedgedriver`), exercising the actual Pixi/WebCodecs + Rust ffmpeg pipeline the
product ships on. They are the engine-fidelity gates.

This file explains **how the suite is organized and where a new test belongs**.
For the analyzer binary (`media_conformance`), fixture generation, and per-gate
details, see [`../../../docs/conformance.md`](../../../docs/conformance.md).

## Why these exist (and why not Playwright)

WebView2 ≠ headless Chromium: codec support, decode/encode quirks, and the GPU
path differ. A Playwright/Chromium pass would give false confidence about real
codec behavior. So these specs run **inside the shipping shell**: create a
project, import/place real media, export through the real pipeline, and verify
the file on disk. They are separate from the colocated renderer **unit** tests
(`apps/desktop/src/**/*.test.ts`, vitest), which mock the browser surface and
cover pure logic — put fast, logic-only checks there, not here.

## How it's categorized — five suites

Specs live under `specs/<suite>/` and run independently. The suites double as a
**speed gradient** (smoke is instant; export/audio/motif are heavy — real
encodes + analysis), so day-to-day you run only the area you're touching:

```
npm run e2e            # everything
npm run e2e:smoke      # boots as real WebView2 + Tauri bridge
npm run e2e:ui         # interaction / feature / preview-render
npm run e2e:export     # export pipeline: codecs, containers, ranges, alignment
npm run e2e:audio      # audio faithfulness: conformance, formats, envelopes
npm run e2e:motif      # motif capture / state / export / disk pre-bake
```

| Suite | Scope | Files |
|---|---|---|
| `smoke` | App boots; bridge present | `launch` |
| `ui` | UI/feature flows, preview render | `layers` (add color/text + still-image/gif), `keyframe_authoring` |
| `export` | Export pipeline correctness | `conformance`, `color_conformance`, `export_10bit`, `export_range_audio`, `export_overlap_same_source`, `export_eos_tail`, `export_content_modes` |
| `audio` | Audio export faithfulness | `audio` (conformance + format matrix + envelope) |
| `motif` | Motif system | `capture`, `state` (staleness + bake-status + file-watch), `export`, `prebake` |

The `e2e:*` scripts go through `scripts/run-suite.mjs`, which spawns the wdio bin
directly with `--suite`. **Don't** try `npm test -- --suite x` or
`npx wdio … --suite x` on Windows — PowerShell/npm swallow the bare `--` and you
silently run *everything*. To run a single file: `node
node_modules/@wdio/cli/bin/wdio.js run wdio.conf.mjs --spec specs/<suite>/<file>.e2e.js`.

## Where to put a new test

1. **Pick the suite by domain** (the table above). App-boot → `smoke`; a
   timeline/inspector/preview interaction → `ui`; anything about codecs /
   containers / export ranges / frame alignment → `export`; audio fidelity →
   `audio`; motif rendering, bake, or staleness → `motif`.

2. **Pick the file — the "balanced merge" rule.** One spec file = one app
   session (wdio runs each file in its own session), and many real exports in a
   single session turn one wedged export into a cascade that's hard to pinpoint.
   So:
   - **Cheap / low-wedge-risk** checks (preview render, layer placement, UI
     state, capture, motif state) → **add to the existing suite file** (e.g. a
     new still-format check joins `ui/layers.e2e.js`; a new capture assertion
     joins `motif/capture.e2e.js`).
   - **Export-heavy / deadlock-prone** checks → **their own file under
     `export/`** (kept 1:1). Isolation keeps a hang from taking siblings down and
     makes the failing case obvious. This is why the `export/` specs are not
     merged even though they share a domain.
   - If a merged file starts going flaky from session pressure, split the
     riskiest `describe` back into its own file (still in the same suite dir).

3. **Isolate every test.** Each `it` must create its own project
   (`newProject(...)`) — a merged file must not share mutable project state
   across tests.

## Shared helpers — use these, don't re-roll

`helpers/` centralizes everything that wraps wdio's global `browser`. From a
spec in `specs/<suite>/`, import as `../../helpers/<x>.mjs`.

- **`app.mjs`** — `waitForHook`, `invokeCmd` (Tauri command), `newProject({parentFolder,name,canvas})`, `summary`, `findLayer`, `findTrackOf`.
- **`preview.mjs`** — `seekUs`, `sampleAt(tUs,x,y)` (re-seeks then samples the live composite), `waitPreviewBridge`.
- **`export.mjs`** — `driveExport(args, { hook, timeout, label })`. Fires the
  export fire-and-forget and polls the mirrored state to settlement, logging
  frame/phase advances (a hang reports the exact stall frame). `hook` is
  `exportClip` (default), `exportTimeline`, or `exportMotifClip`. It returns
  `{ done, lastFrame, lastKind, lastDetail }` and **does not throw on export
  failure** — success-path callers check `r.done.ok`; error-path tests assert
  `r.done.ok === false`.
- **`media.mjs`** — `MEDIA_DIR` (respects `WEFTCUT_TEST_MEDIA`), `fixture(name)`, `tmpOut(name)`, `tmpProjectParent(name)`.

(`specs/helpers/userMotifFs.mjs` is a motif-specific filesystem helper, not part
of the shared set.)

The dev-only control surface the specs drive lives in
`apps/desktop/src/testhook/e2eHook.ts` (`window.__weftcutTest`), gated on
`VITE_WEFTCUT_E2E=1` and tree-shaken from production. Add a new hook there when a
spec needs to drive something the UI does but a spec can't reach directly.

## Conventions & gotchas (the load-bearing ones)

- **Close every running WeftCut before running.** The app is single-instance, so
  any open dev build or `tauri dev` — even from another checkout — holds the
  global lock; the harness's launched instance forwards-and-exits and wdio
  reports `session not created: Chrome instance exited` for *every* spec.

- **Drive like a user, then wait for the store to catch up.** The editor's
  guards and panels read the event-driven project store, which lags the actor by
  a tick after a mutation. Hooks that place-then-act wait for store sync
  (`waitForMediaInStore` / `waitForMediaExportReady`); don't assert immediately
  after a mutation, or you'll race the bridge.

- **A/B-roll hides overlay tracks until revealed.** A motif (or any role-null
  overlay) layer lands on a track that is collapsed by default — the timeline
  renders only role-stamped tracks plus the one *revealed* track. That layer's
  `LayerBlock`, and any per-layer chrome inside it (e.g. the bake-status dot),
  **do not mount until the track is revealed.** Call the `revealLayer` hook (the
  right-panel peek-click equivalent) before asserting on a layer's timeline DOM.
  Plain selection does not reveal.

- **Audio-only sources export in audio-only mode.** Use
  `settings: { includeVideo: false, includeAudio: true }` and a `.m4a` output. A
  *video* export of an audio-only project is correctly rejected ("no video
  material") — the export needs a visible layer.

- **Match the export hook to the scenario.** `exportClip` imports + places + exports one clip; `exportTimeline` exports the current timeline as-is (compose it first with `importAndPlaceMedia`/`placeMediaLayer`); `exportMotifClip` exports a motif-only timeline. Pass the matching `driveExport({ hook })`.

- **Reuse the build while iterating.** `WEFTCUT_E2E_NO_BUILD=1` skips the
  `tauri build` and reuses the existing debug binary (build once, then iterate
  fast). It errors out if the binary is missing — there is intentionally **no**
  auto-staleness detection (running a stale binary silently is worse than a
  loud miss). Rebuild (drop the env var) after touching Rust or `src/`.

- **Fixtures auto-generate** on prepare (needs `go` + `ffmpeg` on PATH); a fresh
  checkout materializes any missing clips. Point at an external fixture dir with
  `WEFTCUT_TEST_MEDIA`. See `docs/conformance.md`.
