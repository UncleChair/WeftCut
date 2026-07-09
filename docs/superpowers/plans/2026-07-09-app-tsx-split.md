# App.tsx split — layout/state core + functional-block extraction

Goal: `apps/desktop/src/renderer/App.tsx` (2656 lines @ `105eda36`) keeps only
layout composition and cross-block coordination state. Everything else moves to
single-purpose files. **This is a pure structural refactor: ZERO behavior
change.** Code moves verbatim; only import paths, `export` keywords, and
parameter threading may differ from the original.

Reference file: `apps/desktop/src/renderer/App.tsx`. All line numbers below are
for the file as of commit `105eda36` (Task 1's base). Later tasks re-locate by
content, since earlier tasks shift lines.

## Global Constraints

These bind every task. Verbatim copies go to every reviewer.

1. **Zero behavior change.** Moved code is transplanted verbatim — no logic
   edits, no renaming of runtime identifiers, no "while I'm here" improvements,
   no dependency-array changes, no reordering of effects relative to each other
   within a moved cluster.
2. **Comments move WITH their code, verbatim** — including `///` doc comments,
   the long rationale blocks, and every
   `// eslint-disable-next-line react-hooks/exhaustive-deps` (those disables
   are intentional; see the adjacent comments). Dropping or rewording a comment
   is a defect (repo rubric: `docs/comment-style.md`).
3. **Playhead discipline (gated by memory-ratchet e2e):** playhead time must
   NEVER enter React state above a leaf component. `PlayheadTimecode`'s
   transient store subscription (direct textContent mutation) is preserved
   exactly. `paused` stays App-level React state (it flips per user action, not
   per frame) — do not "optimize" it into or out of stores.
4. **Ref clusters move together with their mirror effects.** `proxyStateRef` +
   its sync effect, `exportBusyRef` + its sync effect, `decodeProbeMemo`,
   `routeCorrected`, `sweepTick`, and the render-recreated `dialogDeps` object
   are deliberate stale-closure-proof structures. Splitting a ref from its
   wiring effect compiles fine and breaks silently.
5. **E2E hook contract intact:** the `VITE_WEFTCUT_E2E`-gated effects
   (`installExportHook(runExportWithSettings, setPendingRevealLayerId)` and the
   `__weftcutExportState` mirror) must keep working; the static
   `import.meta.env.VITE_WEFTCUT_E2E !== "1"` guards stay so tree-shaking still
   strips them from prod.
6. **Hooks order:** App has an early `return` for agent mode. Every hook call
   must remain above that conditional return, unconditionally invoked.
7. **Gates per task:** from `apps/desktop`: `npm run typecheck` (tsc -b) clean
   AND `npm test` (full vitest suite) green. No new tests are required — this
   plan adds no behavior; the existing suite + the final e2e phase are the net.
8. No new dependencies. New files follow existing naming/style conventions of
   sibling files. No formatters; touch only the files each task lists.
9. `data-drag-region` attributes and all `className` strings move verbatim
   (frameless-window dragging and CSS depend on them).

## File map (end state)

```
apps/desktop/src/renderer/
  App.tsx                       ← layout + coordination state only
  app/                          ← NEW directory
    ViewMenu.tsx                (Task 1)
    useExportFlow.ts            (Task 2)
    useImportReadiness.ts       (Task 3)
    useAppWiring.ts             (Task 4)
    AppMenuBar.tsx              (Task 5)
    PreviewSection.tsx          (Task 5)
  preview/PlayheadTimecode.tsx  (Task 1)
  panels/ExportPanel.tsx        (Task 1)
  panels/MediaPool.tsx          (Task 1)
```

## Task 1: Move the five bottom-of-file sibling components out

**Files:** create `preview/PlayheadTimecode.tsx`, `app/ViewMenu.tsx`,
`panels/ExportPanel.tsx`, `panels/MediaPool.tsx`; edit `App.tsx` only to delete
the moved code and fix imports.

Move, verbatim including all comments:

1. `PlayheadTimecode` (App.tsx:2120–2162, including its `///` doc comment) →
   `preview/PlayheadTimecode.tsx`, exported. Imports it needs:
   `formatTimecode` from `../frames`; `playheadTimeUs, usePlayheadStore` from
   `../state/playheadStore`; `useEffect, useRef` from react.
2. `ViewMenu` (App.tsx:2164–2216, including doc comment) → `app/ViewMenu.tsx`
   (new dir), exported. Needs: `Menu, MenuHeading, MenuItem, MenuSeparator`
   from `../menu/Menu`; `useTranslation`; `useDisplayMode,
   useMediaPoolDrawerOpen, toggleDisplayMode, setMediaPoolDrawerOpen` from
   `../settings/appSettingsStore`.
3. `ExportProgress`, `ExportComplete`, `ExportState` types + `ExportPanel`
   (App.tsx:2219–2373, all interface/type comments included) →
   `panels/ExportPanel.tsx`. Export ALL of: `ExportPanel`, `ExportState`,
   `ExportProgress`, `ExportComplete` (the types are consumed by App's export
   pipeline until Task 2 re-homes the consumer). Needs: `AppDialog` from
   `../components/AppDialog`; `Button` from `@/components/ui/button`;
   `useTranslation`.
4. `MediaDropZone` (2375–2432, doc comment included), `MediaPool` (2434–2636),
   `formatBytes` (2638–2655) → `panels/MediaPool.tsx`. Export `MediaDropZone`
   and `MediaPool`; keep `formatBytes` module-private. Needs: `useState,
   useRef`; `useTranslation`; `MediaThumbnail` from `./MediaThumbnail`;
   `mediaReadiness, type ProxyState` from `./mediaReadiness`;
   `MEDIA_DRAG_TYPE` from `../timeline/TrackLane`; `AppInput` from
   `../components/AppInput`; `formatTimecode` from `../frames`;
   `type MediaSummary` from `../ipc`.

Then in `App.tsx`: import the four modules from their new homes
(`ExportState` as a type import), and remove every import that became unused
(e.g. `MenuHeading`, `MediaThumbnail`, `mediaReadiness`, `AppInput`,
`MEDIA_DRAG_TYPE`, `usePlayheadStore`, `useDisplayMode` — verify by typecheck
rather than assuming this list is exact; keep anything still used).

**Verify:** `npm run typecheck` clean; `npm test` green; App.tsx contains no
component definitions other than `App` itself.

## Task 2: Extract the export pipeline into `app/useExportFlow.ts`

**Files:** create `app/useExportFlow.ts`; edit `App.tsx`.

Create a hook owning the entire export lifecycle. Move from App, verbatim:

- State/refs: `exportState`, `exportDialogOpen`, `closeConfirmOpen`,
  `exportBusyRef` — with their declaration comments (App.tsx:173–180).
- Effects (keep relative order): exportBusy mirror (358–363); the
  `onCloseRequested` close-guard listener (364–375); taskbar progress
  (376–404) AND its unmount-clear companion (405–413); the terminal-state
  native notification (414–450); the E2E `__weftcutExportState` mirror
  (1542–1549) — static env guard intact.
- Functions: `runExportWithSettings` (App.tsx:969–1531 — the ~550-line
  pipeline INCLUDING the three-stage doc comment block above it) and
  `openRenderPlayPopup` (1551–1576, doc comment included). Preserve the
  `useCallback` dependency arrays exactly (`[t]` for the export fn).

Hook signature (App threads these in because they still live in App until
Task 3):

```ts
export function useExportFlow(deps: {
  previewRef: React.RefObject<PreviewSurfaceHandle | null>;
  proxyStateRef: React.MutableRefObject<Map<string, ProxyState>>;
  decodeProbeMemo: React.MutableRefObject<Map<string, ProbeState>>;
}): {
  exportState: ExportState | null;
  setExportState: React.Dispatch<React.SetStateAction<ExportState | null>>;
  exportDialogOpen: boolean;
  setExportDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  closeConfirmOpen: boolean;
  setCloseConfirmOpen: React.Dispatch<React.SetStateAction<boolean>>;
  runExportWithSettings: (settings: ExportSettings, path: string,
    range?: { startUs: number; endUs: number }) => Promise<void>;
  openRenderPlayPopup: (path: string) => Promise<void>;
};
```

Raw state + setters are returned deliberately — reshaping the call sites
(e.g. wrapping `setExportState(null)` in a named closure) is out of scope.
`useTranslation` is called inside the hook. `ExportState` type imports from
`../panels/ExportPanel`. All ipc/bridge/render-module imports move with the
code (`resolveEncodePath`, `exportBakeMotifs`, `getMotif`, exportReadiness
helpers, exportSettings helpers, sink ipc fns, notification/fs/path/window
bridges, `hasVisibleContent`/`referencedVideoMediaIds`, `resolveDecode`,
`probeSourceDecodable`, `convertFileSrc`, `listen`, `useProjectStore`, …).
Remove each from App.tsx only if App no longer uses it (typecheck decides).

Stays in App: the `installExportHook` e2e effect (needs
`setPendingRevealLayerId`), all render sites (`ExportSettingsDialog`,
`ExportPanel`, close-confirm `AppDialog`), menu/shortcut wiring
(`setExportDialogOpen(true)`, disabled flags reading `exportState?.kind`).

**Verify:** `npm run typecheck` clean; `npm test` green.

## Task 3: Extract import/readiness machinery into `app/useImportReadiness.ts`

**Files:** create `app/useImportReadiness.ts`; edit `App.tsx`.

Move the whole import-pipeline cluster, verbatim with comments, keeping the
declaration order (as of `105eda36` numbering):

- `importQueue` state (225) + queue subscription effect (611–634 incl. seed).
- `importingMediaIds` memo (227–239).
- `proxyState` state + comment (240–250); media-job listener effect (636–702).
- `decodeProbeMemo` (251–255), `proxyStateRef` + mirror effect (256–260),
  `routeCorrected` (261–263), `sweepTick` (264–266),
  `previewDecodableMediaIds` memo (267–274) — eslint-disable comment intact.
- `notifiedImportIds` (275–276), `dialogBatch` (277–278).
- Import-time decodability sweep effect (704–769) — its `[summary]` dep now
  refers to the hook's `summary` parameter.
- Dialog-batch open effect (771–782); `dialogDeps` (784–790) — stays a plain
  render-recreated object, NOT memoized; `dialogItems` memo (792–805) —
  eslint-disable intact; `dialogHasAttention` (807); auto-close effect
  (809–824) — eslint-disable intact.
- `importPaths` (916–928), `importMediaFiles` (930–955), and the
  `media:external-drop` listener effect (957–967).

Hook signature:

```ts
export function useImportReadiness(deps: {
  summary: ProjectSummary | null;
  run: (action: () => Promise<unknown>) => Promise<void>;
  previewRef: React.RefObject<PreviewSurfaceHandle | null>;
}): {
  importingMediaIds: Set<string>;
  proxyState: Map<string, ProxyState>;
  proxyStateRef: React.MutableRefObject<Map<string, ProxyState>>;
  decodeProbeMemo: React.MutableRefObject<Map<string, ProbeState>>;
  previewDecodableMediaIds: Set<string>;
  dialogItems: ImportItem[];
  dialogHasAttention: boolean;
  clearDialogBatch: () => void;   // () => setDialogBatch([])
  importMediaFiles: () => Promise<void>;
  importPaths: (paths: string[]) => Promise<void>;
};
```

`useTranslation` inside the hook (for `importMediaFiles` dialog strings). In
App: call `useImportReadiness` BEFORE `useExportFlow` and thread
`proxyStateRef` + `decodeProbeMemo` from its return into `useExportFlow`'s
deps. Update the `ImportProxyDialog` render site (`items={dialogItems}`,
`onDismiss={clearDialogBatch}`), the Timeline/MediaPool prop feeds, and the
menu/shortcut `importMedia` wiring. Remove imports App no longer uses.

**Verify:** `npm run typecheck` clean; `npm test` green.

## Task 4: Gather backend wiring into `app/useAppWiring.ts`

**Files:** create `app/useAppWiring.ts`; edit `App.tsx`.

Move, verbatim with comments:

- `pong` state; `keybindings` state + comment (207–213); `agentSession` state
  + comment (214–220); `staleMotifs` state + §7-B comment + mount pull
  (279–293).
- The mount effect calling `ping`/`refresh`/`keybindingsGet`/`agentSessionGet`
  (485–495) — `refresh` becomes a hook parameter; effect dep `[refresh]`
  unchanged.
- `agent_session:changed` subscription (497–518).
- `exitAgentMode` callback (540–546).
- Stream wiring effects: `wireLogStream` (548–566), `wireProjectStore`
  (568–587), `wireAppSettingsStream` (589–609).
- `project:changed` → refresh subscription (826–847).
- Window-title binding + unmount reset (520–538) → a SEPARATE exported hook in
  the same file: `useWindowTitle(projectName: string | null | undefined)`,
  calling `useTranslation` internally; effect deps stay
  `[projectName, i18n.resolvedLanguage, t]` (adjusted only for the renamed
  parameter).

Signatures:

```ts
export function useAppWiring(deps: { refresh: () => Promise<void> }): {
  pong: string;
  keybindings: KeybindingsMap;
  setKeybindings: React.Dispatch<React.SetStateAction<KeybindingsMap>>;
  agentSession: AgentSession | null;
  exitAgentMode: () => Promise<void>;
  staleMotifs: MotifStaleEntry[];
  setStaleMotifs: React.Dispatch<React.SetStateAction<MotifStaleEntry[]>>;
};
export function useWindowTitle(projectName: string | null | undefined): void;
```

Stays in App: the playhead-reset mount effect (295–300 — session semantics,
one line), all R.7 reveal/selection effects, `refresh`/`run`/save handlers.
App calls `useWindowTitle(summary?.name)`.

**Verify:** `npm run typecheck` clean; `npm test` green.

## Task 5: Extract header and preview JSX blocks

**Files:** create `app/AppMenuBar.tsx`, `app/PreviewSection.tsx`; edit
`App.tsx`.

**AppMenuBar** — the whole `<header className="app-header">` element
(App.tsx:1728–1863 @ `105eda36`, including the frameless-window comment and
every `data-drag-region`). Moves: the header JSX, `cycleLocale` + its
`LOCALE_LABELS`/`SUPPORTED_LOCALES` usage (these only touch i18n — the hook
call lives in the component), the `ViewMenu` usage (import from `./ViewMenu`),
`WindowControls`, `GlobeIcon`. Menu item bodies become props — App keeps the
async closures (they touch `run`, `playheadTimeUs`, `setPendingRevealLayerId`,
`refresh`) and passes them down:

```ts
interface AppMenuBarProps {
  busy: boolean;
  pong: string;
  canUndo: boolean;            // !!summary?.history.can_undo
  canRedo: boolean;            // !!summary?.history.can_redo
  canBlade: boolean;           // !!summary && summary.layer_count > 0
  exportLocked: boolean;       // busy || exportState.kind is starting|progress
  onImportMedia: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onSaveAndClose: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleBladeMode: () => void;
  onAddColorLayer: () => void;
  onAddTextLayer: () => void;
  onOpenMotifPicker: () => void;
  onOpenExport: () => void;
  onOpenConnect: () => void;
  onOpenSettings: () => void;
}
```

Inside the component the original `disabled={busy}` /
`disabled={busy || !summary?.history.can_undo}` expressions are rewritten as
`disabled={busy}` / `disabled={busy || !canUndo}` etc. — the ONLY permitted
rewrite, a pure renaming of the same boolean data.

**PreviewSection** — the `<section className="preview">` element
(App.tsx:1866–1944). Owns `tcEditUs` state locally (its comment at 203–206
moves along). Computes `fpsLabel` internally (move 1693–1701). Imports
`setPlayheadTimeUs, playheadTimeUs` from `../state/playheadStore` directly,
`PlayheadTimecode` from `../preview/PlayheadTimecode`, `AppTimecodeField`,
`PreviewSurface` type + component, transport icons, `formatTimecode` from
`../frames`.

```ts
interface PreviewSectionProps {
  previewRef: React.RefObject<PreviewSurfaceHandle | null>;
  summary: ProjectSummary | null;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onSeek: (tUs: number) => void;          // App's seekTo
  onTogglePlay: () => void;
  previewDecodableOf: (id: string) => boolean;
}
```

`paused` stays App state (AgentMode also writes it via `onPausedChange`).
After this task App.tsx renders: `<AppMenuBar …/>`, `<main>` with
`<PreviewSection …/>` + timeline section + media-pool section + properties
section, the modal zoo, `<StatusBar/>` — plus the agent-mode early return.

**Verify:** `npm run typecheck` clean; `npm test` green. Sanity: App.tsx
should now be roughly 700–900 lines, all layout/coordination.

## Verification phase (controller-run, after all 5 tasks)

1. `npm run typecheck` + `npm test` (full suite) from `apps/desktop`.
2. Instrumented build: `VITE_WEFTCUT_E2E=1 npm run build` (stale `out/` mimics
   real bugs), then `npm run e2e:electron`. Preconditions: NO WeftCut instance
   running (single-instance lock); external fixtures at `WEFTCUT_TEST_MEDIA`.
3. Any failure → dispatch a fable fix subagent with the failing spec + output.
4. Final whole-branch review (fable) over `merge-base(main, HEAD)..HEAD`.
5. On approval: FF-merge to local main, delete branch, NO push (user pushes).
