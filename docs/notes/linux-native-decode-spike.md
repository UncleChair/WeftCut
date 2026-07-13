# Linux native-decode (Standard engine) — enablement spike

Point-in-time verification log. **This is a spike, not the Linux compatibility
plan** — that plan has not officially started, and decode-side changes are still
in flight. The purpose here is to record, before the facts go stale, exactly
what it takes to bring the Standard engine's **software lane** up on Linux, what
the real blocker is, and what still remains. The `preview_gpu` (D3D11) hardware
lane is out of scope — it stays Windows-only.

## Environment measured on

- **OS**: Linux Mint 22.3 (Ubuntu 24.04 base), kernel 6.17, x86_64
- **Electron**: 42.4.1 (Chromium bundled)
- **Node**: v22.23.1 · **Rust**: rustc/cargo 1.96.1 · **libclang**: 18
- **Toolchain linker**: GNU `ld`/collect2 13.3.0
- **`ffmpeg-next`/`ffmpeg-sys-next`**: 8.1.0
- **ffmpeg build**: BtbN `ffmpeg-n8.1-latest-linux64-lgpl-shared-8.1` (LGPL,
  shared; `libavcodec.so.62` / `libavutil.so.60`), banner-gated LGPL-clean
- **Date**: 2026-07-13

Re-verify when the Electron major (hence bundled Chromium/ffmpeg) changes, or on
a distro/glibc/binutils with materially different dynamic-linker behavior.

## Verdict

The Standard engine's software lane **works on Linux** and passes the project's
own ProRes conformance e2e (`preview-sw-conformance.spec.ts`, P1 + P2 SSIM
0.996). Getting there needed two things: a per-OS LGPL-ffmpeg supply chain
(previously Windows-only), and — the real blocker — a **load-time fix for a
symbol collision with Electron's bundled Chromium ffmpeg**. The code was already
cross-platform (`preview_sw/` carries no `cfg(windows)`); nothing about the
decoder itself needed changing.

## The headline finding: Chromium libffmpeg symbol interposition

After the supply chain was in place and the addon built + loaded, every file
open through the SW lane failed inside Electron with libavformat's
**`Protocol not found`** — while the *same* addon opening the *same* file
succeeded under plain `node` and in the crate's own `cargo test`.

Cause: Electron bundles Chromium's `libffmpeg.so`, a **minimal ffmpeg build that
exports ~843 global `av*` FUNC symbols** (`avformat_open_input`, `avcodec_*`, …)
and has **no `file` protocol**. Under ELF's default global symbol scope, those
symbols **interpose** our addon's own full LGPL `libavformat`, so
`avformat_open_input` runs *Chromium's* implementation, which cannot open a
plain path → `Protocol not found`. Windows PE (and macOS Mach-O two-level
namespaces) resolve symbols per-module, so the collision never happens there —
**this is the actual reason the component was Windows-only**, not merely the
DLL supply chain.

This is a known, wontfix Electron issue: **[electron/electron#31397]** — same
symptom (an ffmpeg binding that works in Node but throws `Protocol not found`
in Electron), closed *"not planned"*. The workaround must live in the app.

### Fix: load the addon with `RTLD_DEEPBIND`

Deep binding makes the addon resolve its `av*` symbols from **its own
dependency tree first** (the co-located `$ORIGIN` LGPL build) ahead of the
global scope. `main/native-decode.ts` wraps `process.dlopen` for the one
synchronous `require` of the `.node` (napi's generated `index.js` loads it with
a plain `require`), OR-ing in the documented max-isolation combo
**`RTLD_NOW | RTLD_LOCAL | RTLD_DEEPBIND`**. Linux-only.

Why not the alternatives:

- **`-Wl,-z,deepbind` at link time** — GNU `ld` 13.3.0 emits
  `warning: -z deepbind ignored`, and there is **no `DF_1` dynamic flag** for
  deepbind, so it cannot be baked into the `.node`. Must be a `dlopen`-time flag.
- **`LD_LIBRARY_PATH` to prefer our libs** — does not solve a *symbol*-level
  collision (the sonames differ: Chromium `libffmpeg.so` vs our
  `libavformat.so.62`), and it is process-global, so it would also perturb
  Chromium's own media stack (which the Lite/WebCodecs engine depends on).
- **`dlmopen` (separate link-map namespace)** — the "maximum isolation" option,
  but Node does not expose it; it would need a native trampoline. `RTLD_DEEPBIND`
  via `process.dlopen` is the pragmatic, community-standard path.

**Caveat** (per `dlopen(3)`): `RTLD_DEEPBIND` misbehaves when a library and the
main program define the same symbol and the library expects the program's copy
(e.g. `malloc`). Safe here — the addon's only cross-boundary symbols are
`napi_*`, which aren't in libav\*, so deep binding falls through to the global
scope and resolves them from the Node executable (verified: `versionInfo`,
`previewSwOpen`, and the e2e all work).

## Supply-chain mechanics that mattered (Linux ≠ Windows)

- **Runtime lib resolution is `$ORIGIN`, not a PATH prepend.** Windows resolves
  `*.dll` lazily via a PATH prepend at dlopen; Linux resolves an addon's
  `DT_NEEDED` at load time from the ELF rpath. So the `.so` ship **beside the
  `.node`** and the addon carries an rpath — no runtime env mutation
  (`resolveDllDir` correctly returns `null` off Windows).
- **It must be `DT_RPATH`, not the modern `DT_RUNPATH` default.** The BtbN `.so`
  carry no rpath of their own, and `RUNPATH` is consulted **only** for an
  object's direct `NEEDED` — not for transitive deps
  (`libavcodec→libswresample`, `libavdevice→libavfilter`). An ancestor's
  `DT_RPATH` **is** searched across the whole dependency subtree, so the addon
  links with `-Wl,--disable-new-dtags -Wl,-rpath,$ORIGIN`.
- **Preserve the SONAME symlink chain as relative.** Node `cpSync` rewrites
  relative symlinks (`libavcodec.so → .so.62`) into absolute paths under the
  temp extract dir, which then vanishes → dangling links. Fetch copies with
  `verbatimSymlinks: true`; the build re-anchors each co-located link to its
  target's basename.
- **libclang is a build prereq** on Linux (`ffmpeg-sys-next`'s bindgen);
  `apt install libclang-dev`.

## Changes made in this spike (branch `spike/linux-standard-decode`)

- `apps/desktop/scripts/fetch-ffmpeg-lgpl.mjs` — per-OS LGPL fetch (Linux
  BtbN `linux64-lgpl-shared`); banner gate runs under `LD_LIBRARY_PATH`;
  `verbatimSymlinks` on copy.
- `apps/desktop/scripts/napi-build-decode.mjs` — per-OS `FFMPEG_DIR`; Linux
  `DT_RPATH $ORIGIN` via `--disable-new-dtags`; co-locate `*.so*` next to the
  built `.node`.
- `apps/desktop/src/main/native-decode.ts` — Linux `RTLD_DEEPBIND` load
  (the symbol-interposition fix).
- `apps/desktop/native/decode/.gitignore` — ignore co-located `*.so*` (build
  artifact).

## What was verified

- **Build**: addon compiles; `readelf` confirms `RPATH: [$ORIGIN]`; `ldd`
  resolves the full graph (incl. transitive `libswresample`/`libavfilter`).
- **Load**: `require` succeeds under plain node; `versionInfo` returns
  `avcodec=62 avutil=60`; both `previewSwOpen`/`previewGpuOpen` present
  (`previewGpuOpen` throws on Linux by design).
- **App**: built Electron main loads the component (no "component unavailable").
- **Decoder unit**: crate `cargo test` 7/7, incl.
  `decodes_first_prores_frame_to_nv12`.
- **End-to-end**: `preview-sw-conformance.spec.ts` P1 (Compositor acquires the
  `FfmpegSource` SW lane for a NativeSw-routed ProRes clip, seeked frame decoded
  + sprite-bound) and P2 (rendered preview vs ffmpeg reference, **SSIM 0.996** ≥
  0.98 floor). P3 (4K memory ratchet) skipped — no 4K fixture generated locally.
- **Loader unit test** (`native-decode.test.ts`) 3/3 and workspace `typecheck`
  stay green.

The ProRes conformance fixture (`test_1080p_30fps_prores.mov`) is git-ignored
media; regenerate via `e2e/fixtures/generate-fixtures.mjs` (needs a `drawtext`-
capable ffmpeg) or an equivalent `testsrc2` clip.

## What this spike did NOT do (defer to the real Linux plan)

- **Packaging** — `electron-builder.yml` still bundles the LGPL runtime only
  under `win:`. Linux needs `native-decode/*.so*` in the `files` glob +
  `asarUnpack` (so `$ORIGIN` resolves in the packaged app exactly as in dev),
  plus the LICENSE/manifest carried for LGPL §6. The deepbind loader already
  covers both dev and packaged.
- **Lane advertisement** — `version_info`/a new `capabilities` should report the
  available lanes so `FfmpegSource` skips the (currently throwing, then
  caught → software) GPU probe on Linux.
- **ADR 0030** — record the symbol-interposition finding, the `RTLD_DEEPBIND`
  decision, and its caveat.
- **macOS** — no BtbN LGPL-shared build exists; supply chain still unsettled.
  Mach-O two-level namespaces mean the symbol collision would not occur, but the
  library sourcing does not yet have a home.

[electron/electron#31397]: https://github.com/electron/electron/issues/31397
