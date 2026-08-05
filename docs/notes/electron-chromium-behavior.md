# Electron/Chromium engine behavior — verified verdicts

Measured 2026-06-19 on Electron 42.4.1 / Chromium 148.0.7778.265 (Windows 11, RTX 3050) via a standalone probe harness (Electron plus a bare probe page, no app build). This was the "Phase 0" of the post-Tauri→Electron cleanup: every WebView2-era browser-behavior verdict that could have changed with the engine swap was re-tested empirically before being carried forward. Two of the three high-risk verdicts flipped.

Re-verify on the next Chromium major bump, or on hardware that breaks an entry's stated assumption.

## Pointer Lock works (WebView2 verdict overturned)

`element.requestPointerLock()` locks fine on a visible, focused window. A *hidden* window forces `pointerlockerror` — that is a probe-harness artifact, not an engine limit.

History: in the Tauri WebView2/Edge webview, pointer lock never engaged, so the Base UI `NumberField.ScrubArea` drag-to-scrub gesture (which needs pointer lock for unbounded relative cursor movement) could only move the cursor right — the value only ever increased. The ScrubArea grip was removed (`a1142fce`) and `AppNumberField` fell back to typing + arrow keys + hover-revealed steppers.

Implication: drag-to-scrub on numeric fields is unblocked on Electron and can be re-introduced as a feature; the stepper/typing path remains the no-pointer-lock fallback.

## A canceled `pointerdown` cancels the focus move

`preventDefault()` on `pointerdown` suppresses the compatibility `mousedown`, and it is
`mousedown`'s default action — not `pointerdown`'s — that moves focus. So a handler that
cancels `pointerdown` to suppress native drag or text selection also, silently, leaves focus
exactly where it was. Verified in the app rather than the probe harness:
`e2e/electron/focus-regions.spec.ts` dispatches a cancelable `pointerdown` at a listener
that cancels it and asserts the focus outcome.

Implication: focus release cannot be left to the browser anywhere a drag gesture lives, and
it cannot be fixed inside the gesture handlers either — every one of them needs its
`preventDefault()`. The only phase that runs ahead of all of them is **capture at `window`**;
React attaches at the root container, a descendant of window, so even React's capture
handlers are later. That is the premise of ADR 0041's focus regions.

## Inline foreignObject raster does NOT taint the canvas (WebView2 verdict overturned)

An inline `<foreignObject>` SVG rasterized via `<img>` → canvas reads back cleanly: `getImageData` and `toDataURL` both succeed, no `SecurityError`.

History: WebView2 flagged EVERY foreignObject raster as cross-origin-tainted — even fully inline, script-free, system-font, same-origin content (`blob:` and `data:` URLs alike) — blocking `getImageData`, `convertToBlob`, WebGL `texImage2D`, and WebGPU `copyExternalImageToTexture` (the path PixiJS v8 uses for texture upload). That taint is what forced the pure-SVG template raster path and is the premise of ADR 0015 ("templates rasterize from plain SVG to dodge the taint", since superseded by the Motifs rebuild). On the pinned Electron Chromium that premise no longer holds for inline content; the successor Motifs CDP-capture design stands on its own merits (untrusted-JS sandbox, uniform authoring), not on the taint.

⚠ Caveat: only the INLINE case was re-probed. The classic Chromium taint trigger is an embedded external resource or web font inside the foreignObject; re-confirm that case before fully retiring the constraint for arbitrary HTML/CSS content.

## `prefer-hardware` encode hint is MANDATORY, not a preference (confirmed on Electron)

Chromium treats `VideoEncoder` `hardwareAcceleration: "prefer-hardware"` as a hard requirement, not a hint: a codec with no hardware encoder on the box is rejected outright instead of falling back to the software encoder that works.

Probe matrix (AV1 on a GPU without hardware AV1 encode, RTX 3050):

- `isConfigSupported({codec: "av01.0.13M.08", …})`: no hint → true; `prefer-hardware` → **false**; `prefer-software` → true.
- Real one-frame encode: `prefer-hardware` → "Encoder creation error"; hint omitted or `prefer-software` → OK. Sustained 15-frame software AV1 encode: 0 errors, 71 ms @ 720p (libaom, near-realtime).
- HEVC fails ALL variants — Chromium ships no software HEVC encoder (patent-encumbered). HEVC genuinely needs the ffmpeg exit.

Rules:

- Never force `prefer-hardware` when probing or encoding a codec that may lack a hardware encoder — omit the hint so Chromium picks hardware-if-present-else-software. (H.264 keeps `prefer-hardware` for its proven fast path.)
- Never trust `isConfigSupported` alone, in either direction: it lies *negative* under `prefer-hardware` (this entry) and lies *positive* for some decodes (Hi10P). Confirm with a real `encode()`/`decode()` plus `flush()`.

History: first hit on WebView2/Edge, but it is Chromium-wide, not Edge-specific. WeftCut's `smokeEncode` and `App.buildConfig` used to force the hint, producing a false "this machine cannot encode AV1"; fixed by omitting it for non-H.264 codecs.

## EyeDropper API: sampling is screen-wide, the WIDGET is window-hosted

Observed 2026-07-11 in the real app (not the probe harness), corroborated by
upstream electron#27980 / #44916 / #44917. `new EyeDropper().open()` correctly
samples pixels from ANY window on ANY display — the returned `sRGBHex` is
accurate for foreign-window content. But Chromium hosts the dropper's UI
widget inside the Electron window with no system-wide mouse capture, so:

- the magnifier clips at the app window's edge (invisible while hovering
  foreign windows, though picking there still works);
- the pick click lands on and ACTIVATES the clicked foreign window (focus
  steal) — in Chrome the same click does not transfer focus.

Blockbench (Chrome's own EyeDropper showcase app) abandoned the native API in
its Electron build over this same defect. Mitigation in WeftCut:
`colorpick/screenPick.ts` snaps focus back via `window:focus` after every
pick. Full fix = replace `screenPick.ts` with a desktopCapturer-based
full-screen overlay (per-display always-on-top windows + own magnifier),
which also gains hover events for screen picks.

## Buffer-defined `VideoFrame` conversion ignores the stamped `colorSpace` (always BT.601)

Observed 2026-07-16 in the real app (the export ProRes fidelity gate), Electron 42 / Chromium 148. When a `VideoFrame` is constructed **from an ArrayBuffer** (`new VideoFrame(data, { format: "NV12", colorSpace: … })`), Chromium's software RGB conversion (`drawImage`, `createImageBitmap`) applies BT.601 coefficients regardless of the stamped BT.709 `colorSpace`. **Decoder-produced** frames are unaffected — their conversion honors the tagged space.

Caught by the saturated-chart SSIM gate: the native-decode lane's HD frames converted visibly wrong (chart SSIM 0.616 vs the proxy path's 0.892) while natural-content SSIM barely moved — chroma-coefficient error hides in low-saturation material, so gates on natural clips are blind to it.

Rule: never hand a buffer-defined YUV frame to the browser for color conversion. CPU planes from the native decode lanes (export relay AND the SW preview transport) carry their own kinds (`NativeNv12Frame` / `TenBitFrame`) and convert in owned shaders (`Nv12Ingest` / `TenBitIngest`, matrix selected from the stamped `colorSpace` via `coefForMatrix`). Policy: ADR 0032. Third member of the platform color-gap family, alongside `VideoEncoder` ignoring `colorSpace` (below) and WebGPU `copyExternalImageToTexture` converting as BT.709/limited regardless of tags (ADR 0021's offender list).

## macOS menu accelerators do NOT preempt the renderer — `preventDefault()` wins

Measured 2026-07-30 on Electron 42.4.1, macOS (Darwin 25.5.0, Apple silicon) — a different
platform and date from this file's header. Standalone probe: a bare window with a focused,
text-selected `<input>`, a **page-world** `keydown` recorder, and a **real** `Cmd+C`
delivered through AppKit via `osascript … keystroke "c" using command down`.
`webContents.sendInputEvent` cannot probe this — it injects past AppKit, so menu key
equivalents never run and every variant looks identical.

| Application menu installed | native copy happened | renderer saw the keydown |
| --- | --- | --- |
| `[appMenu, editMenu]` roles, default accelerators | yes | yes |
| …same, but the renderer calls `preventDefault()` | **no** | yes |
| Edit items as roles with `accelerator: ''` | no | yes |
| Edit items as roles with `registerAccelerator: false` | yes | yes |
| `[appMenu]` only — menu exists, no Edit menu | no | yes |
| `setApplicationMenu(null)` — no menu at all | **yes** | yes |

**Custom items behave exactly like roles here** (re-probed the same way when the menu was
built): a `{ label, accelerator: 'CommandOrControl+S', click }` item did **not** fire when
the renderer called `preventDefault()` on Cmd+S, and an otherwise identical item on a chord
the renderer let through **did** fire. So a menu of the app's own commands cannot
double-dispatch against `useShortcuts`, and the rule below is about the menu, not about
roles specifically.

The renderer observed the chord in **every** configuration, including the ones where the
native role also fired. The `preventDefault()` verdict was re-run 4× alternating
(prevent → no copy, pass → copy) with no flake, and holds for a **destructive** role too:
against `role: 'close'` (Cmd+W), `preventDefault()` left the window open, and without it
the window closed.

Rules:

- **The renderer is upstream of the application menu on macOS.** `useShortcuts` can own any
  chord by calling `preventDefault()`; the matching menu role then does not fire. So a full,
  standard, discoverable menu **with real accelerators** can coexist with renderer
  ownership — no display-only menu items, and no renderer reimplementation of text-field
  clipboard/undo. Focus-aware dispatch falls out for free: don't prevent when a text input
  has focus and the native role serves it.
- **Never try to strip an accelerator off a role item.** `accelerator: ''` silently kills the
  role's native behavior; `registerAccelerator: false` is ignored on macOS (the accelerator
  still fires). Either include the role normally or omit the item.
- Electron's **default** menu binds `Cmd+R`/`Shift+Cmd+R` (reload) and `Alt+Cmd+I`
  (DevTools) in **production** too, plus `Cmd+W` → Close Window and `Cmd+Z` →
  `webContents.undo()` (DOM text undo, never project history). An app that keeps the default
  menu ships all four. `role: 'viewMenu'` re-adds reload + DevTools, so build View by hand.
- `role: 'appMenu'` contains no Settings/Preferences slot — `Cmd+,` must be a custom item.

⚠ Caveat: the last table row is the odd one — *no* menu yields a working native Cmd+C, yet a
menu **without** a copy role does not. Treat that asymmetry as an Electron 42 implementation
detail rather than a contract, and ship the standard Edit menu instead of relying on it.

History: the intuitive model — "macOS menu accelerators are resolved by the browser process
through the AppKit main-menu responder chain and preempt the renderer's keydown listener" —
is what ADR 0031 was first written around, and it is **false** on Electron 42. A design
derived from it (Cmd+Z/C/V as display-only items plus a renderer clipboard/undo
reimplementation) is dead work; the table above is what replaced it. The same ADR's claim
that `setApplicationMenu(null)` "breaks Cmd+C/V in the app's text inputs" is likewise false,
though the near-miss variant (a menu lacking the copy role) does break it.

### Manual check: the renderer still owns the shared chords

The one thing here that cannot be a CI gate — `webContents.sendInputEvent` injects past
AppKit, so menu key equivalents never run and an injected-key test passes whatever the menu
does. Real keys need `osascript`, which needs Accessibility permission for the runner. Run
this by hand after touching the menu template, `useShortcuts`, or the Electron major;
`e2e/electron/menu.spec.ts` covers everything else (menu shape, the projection, dispatch).

With a project open, on macOS:

1. **`Cmd+Z`** in the timeline → the app's undo runs (a timeline edit reverts), not the Edit
   menu's DOM undo. In a text field (a layer name) → the opposite: the typing is undone and
   project history is untouched. Both directions are unit-tested in `useShortcuts.test.tsx`;
   the in-app half was found broken once, when `undo`/`redo` lacked `fireWhenEditing: false`.
2. **`Cmd+W`** → "Save and Close" — back to the startup screen, window still open.
3. **`Cmd+C` / `Cmd+V`** in a text field → native clipboard; in the timeline → the app's
   copy/paste.
4. **`Cmd+,`** on the startup screen and in the editor → Settings opens.

## Not re-probed (kept as known Blink behavior)

These WebCodecs behaviors live in the same Blink core WebView2 used, so they were carried forward without re-probing: Hi10P software-decodes but needs `flush()`; a lone IDR frame parks in the decoder's reorder buffer until `flush()`; held `VideoFrame`s pin the ~13-slot hardware decoder pool (ADR 0004); `VideoEncoder` ignores `VideoFrame.colorSpace` and tags color by resolution.
