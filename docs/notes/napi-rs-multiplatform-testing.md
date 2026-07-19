# NAPI-RS multi-platform testing and production symbol loading

Verified 2026-07-19 on the WeftCut workspace and generalized to all three
desktop targets. This note records why a native crate's Rust test binary behaves
differently from the addon Electron loads, the `test-noop` test pattern (with the
per-crate nuance both WeftCut addons hit), the production `dyn-symbols` policy,
and the per-OS build/runtime specifics — including the macOS decode wiring,
which landed 2026-07-19 (SW lanes; checklist below).

## Two execution modes (the root cause)

A Rust test target is a **standalone executable**; a `.node` file is **loaded
inside a Node/Electron host**. Direct N-API calls in the addon expect the host to
supply the `napi_*` symbols. Electron provides them for the production addon; a
standalone test binary has no provider. How each OS reacts to the unresolved
symbols differs — these are host/linker differences, not different behavior in
the crate:

| OS | Standalone test binary, no fix | Production `.node` |
|----|--------------------------------|--------------------|
| Linux | **Rejected at load/startup** — the loader resolves imports eagerly | Electron supplies `napi_*` |
| macOS | Historically linked with `-undefined dynamic_lookup` (defer resolution) | two-level namespace; Electron supplies `napi_*` |
| Windows | Linked against napi's **import library** | Electron supplies `napi_*` |

Linux is the strict one, which is why the gap surfaced there first.

## The layered testing pattern

1. Keep domain logic independent of NAPI-RS types and test it with ordinary Rust
   tests (WeftCut: the `weftcut-eval` leaf).
2. For addon-crate unit tests that still compile `#[napi]` exports, enable a
   **test-only `test-noop` feature** and run `cargo test --features test-noop` on
   all three OSes.
3. Build the real `.node` and exercise it through the Electron E2E suite — the
   layer that validates JS conversions, exceptions, promises, references, garbage
   collection, and environment lifecycle.

`noop` is a test **compilation** mode, not a production feature and not a fake
JavaScript engine. `dyn-symbols` is a production **symbol-resolution** policy.
Neither replaces the Rust tests or the host integration tests.

## test-noop: per-crate configuration (IMPORTANT)

The two noop features are separable, and WeftCut's two addons need different
subsets:

- **`@weftcut/core`** → `test-noop = ["napi/noop", "napi-derive/noop"]` (both).
  The exported wrappers vanish under `napi-derive/noop`, producing expected
  `dead_code` warnings. The crate still compiles because nothing depends on the
  derived `ToNapiValue`/`FromNapiValue` impls at compile time.
- **`@weftcut/native-decode`** → `test-noop = ["napi/noop"]` (**only**).
  It must **not** add `napi-derive/noop`: decode holds
  `ThreadsafeFunction<ExportSwMsg>` and `ThreadsafeFunction<String>` in non-test
  code. `napi-derive/noop` deletes the derived `ToNapiValue` impl for the
  `#[napi(object)] ExportSwMsg`, which the `ThreadsafeFunction` generic bound
  requires — 33 compile errors. `napi/noop` alone stubs the runtime `napi_*`
  symbols (fixing the linker) while keeping napi-derive active so the derives
  survive.

**Rule of thumb for a new addon crate:** start with `["napi/noop"]`. Add
`napi-derive/noop` only if the crate still compiles — i.e. only if no custom
`#[napi(object)]`/`#[napi]` type is used at compile time as a generic argument or
return type that needs its derived `To`/`FromNapiValue` impl. The
`ThreadsafeFunction<CustomType>` shape is the usual tripwire.

## dyn-symbols: production symbol-resolution policy

`dyn-symbols` is a **NAPI-RS v3 default**. Both WeftCut addons had switched it off
(`default-features = false` without re-adding it, 2026-06-17) and have now
restored it. With it, the addon resolves the host's `napi_*` entry points via
**dynamic lookup at load time** instead of baking them in as hard import records.
It is not a runtime polyfill: the host must still provide every API the addon
calls. Verify a `dyn-symbols` change by building the real addon, loading it in
Node/Electron, and passing the E2E matrix — never by Rust tests alone. Never
enable `noop` in a production build.

## Building & testing the decode component, per OS

`@weftcut/native-decode` is the repo's **only `ffmpeg-next` consumer**
(`@weftcut/core` must never link libav). It needs `FFMPEG_DIR` + libclang to
build and the bundled libav* on the loader path at run. HW-preview lanes are
per-OS; the **SW lanes (`preview_sw` / `export_sw`) build on every platform**.

| | Windows | Linux | macOS |
|--|---------|-------|-------|
| HW lane | `d3d11va` (`#[cfg(windows)]`) | VAAPI copy-back (`#[cfg(target_os="linux")]`) | **none yet** — VideoToolbox = future (the staged ffmpeg has VT compiled in; the crate has no `cfg(macos)` lane) |
| `FFMPEG_DIR` | `resources/ffmpeg-lgpl/win` | `resources/ffmpeg-lgpl/linux` | `resources/ffmpeg-lgpl/mac` (built from source) |
| libclang | `C:\Program Files\LLVM\bin` (wrapper hard-sets) | `apt libclang-dev`; clang-sys auto-discovers | Xcode CLT; auto via `xcrun` (verified — no `LIBCLANG_PATH`) |
| runtime lib resolution | DLLs prepended to PATH | `DT_RPATH=$ORIGIN` baked (`--disable-new-dtags`) + `.so` co-located | `@loader_path` install names (rewritten at fetch) + `.dylib` co-located |
| test env | `FFMPEG_DIR` + `LIBCLANG_PATH`, DLLs on PATH | `FFMPEG_DIR` + `LD_LIBRARY_PATH=…/lib` | `FFMPEG_DIR` + `DYLD_FALLBACK_LIBRARY_PATH=…/lib` |

CI currently guards the decode build/test steps with `runner.os != 'macOS'`.

## macOS decode: checklist for the darwin device

The macOS scope is the **SW lanes only** (`preview_sw` / `export_sw` compile
everywhere); the HW VideoToolbox backend is a separate, larger effort — decode
still has no `cfg(target_os = "macos")` code. Items 1–5 and 8 **landed
2026-07-19** (verified on macOS 26.5.2 arm64); 6–7 remain:

1. **LGPL-shared ffmpeg asset — DONE, built from source.** No prebuilt
   LGPL-shared macOS ffmpeg exists: BtbN publishes Windows/Linux only;
   evermeet.cx / osxexperts.net / ffmpeg.martin-riedl.de are static AND GPL
   (x264/x265); Homebrew's bottle is shared but `--enable-gpl`. So
   `fetch-ffmpeg-lgpl.mjs` (`BUILDS.mac`) builds FFmpeg n8.1 from the pinned,
   sha256-verified release tarball (`ffmpeg.org/releases/ffmpeg-8.1.tar.xz`),
   configured `--enable-shared --disable-static --disable-debug --disable-doc
   --disable-ffplay` — LGPL-clean by construction, with `assertLgplBanner`
   re-verifying the banner captured from the freshly built exe. Single-arch:
   an x64 asset needs the same recipe run on an Intel host (no universal build).
2. **OS_KEY maps — DONE.** `darwin: 'mac'` in both `fetch-ffmpeg-lgpl.mjs`
   (`OS_KEY`, `BUILDS`) and `napi-build-decode.mjs` (`osKey`).
3. **rpath analog — DONE, and nothing had to be baked.** FFmpeg's dylibs carry
   `<prefix>/lib/libfoo.NN.dylib` install names; `rewriteMacInstallNames`
   (fetch-ffmpeg-lgpl.mjs) rewrites the id + every libav\* cross-reference to
   `@loader_path/libfoo.NN.dylib` via `install_name_tool`, so the `.node`
   records those names at link time and dyld resolves them from the `.node`'s
   own directory at dlopen — no `RUSTFLAGS` rpath needed. (Names come from
   `otool -L`, never guessed: the cross-references name the MAJOR-versioned
   symlink while the real file is `libfoo.NN.x.y.dylib`, so a `-change` keyed
   on the real file's name silently no-ops — the bug the first draft shipped.)
4. **dylib co-location — DONE.** The Linux copy loop in napi-build-decode.mjs
   now covers darwin (`*.dylib`), preserving the
   `libfoo.dylib → libfoo.NN.dylib → libfoo.NN.x.y.dylib` chain.
5. **libclang — DONE, zero config.** clang-sys finds the Xcode CLT libclang
   via `xcrun`; no `LIBCLANG_PATH` needed.
6. **CI — TODO.** Flip the four decode steps from `runner.os != 'macOS'` to
   include `macos-latest`, and add a macOS branch to the Rust tests step. For
   the `cargo test` binary use `DYLD_FALLBACK_LIBRARY_PATH=…/lib` (SIP strips
   `DYLD_*` only for system/protected binaries, not user test binaries — the
   test binary records `@loader_path/...` NEEDEDs that don't resolve from
   target/debug/deps, and dyld's fallback dirs supply the leaf names). The
   packaged `.node` relies on the `@loader_path` names + co-located dylibs, so
   it needs no env.
7. **Packaging — TODO.** Ship the `.dylib` beside the unpacked `.node` in
   `electron-builder.yml`, mirroring the Linux `.so` packaging.
8. **Symbol collision — DONE (smoke).** macOS's two-level namespaces avoid the
   Linux flat-namespace Chromium-collision class; verified the addon dlopens
   cleanly in plain Node — `require` returns the 3 exports and
   `capabilities()` → `[ 'software' ]` (probes below).

## Local probes (verified on Linux + macOS, 2026-07-19)

- Core, links + runs standalone:
  ```sh
  cargo test --manifest-path native/Cargo.toml --lib \
    --features jobs,export,mcp,cloud,test-noop encoder_registry::tests
  ```
  → 9 passed, 0 failed (expected `dead_code` warnings from `napi-derive/noop`).
- Decode, full suite:
  ```sh
  FFMPEG_DIR="$PWD/resources/ffmpeg-lgpl/linux" \
  LD_LIBRARY_PATH="$PWD/resources/ffmpeg-lgpl/linux/lib" \
  cargo test --manifest-path native/decode/Cargo.toml --features test-noop
  ```
  → 26 passed (real ProRes decode, VAAPI probe rejection, `export_sw` GOP ranges).
- Decode build with clang auto-discovery (`LIBCLANG_PATH` unset):
  `npm run napi:build:decode` → clang-sys finds libclang, bakes `$ORIGIN`,
  co-locates 25 `.so`; the `.node` loads via `$ORIGIN` with 3 exports.
- Both addons build with `dyn-symbols` and load in Node with an export surface
  identical to the shipping `.node`.
- macOS (26.5.2 arm64), decode full suite:
  ```sh
  FFMPEG_DIR="$PWD/resources/ffmpeg-lgpl/mac" \
  DYLD_FALLBACK_LIBRARY_PATH="$PWD/resources/ffmpeg-lgpl/mac/lib" \
  cargo test --manifest-path native/decode/Cargo.toml --features test-noop
  ```
  → 28 passed, 0 failed (real ProRes decode, `export_sw` GOP ranges, credit
  window).
- macOS decode addon build: `npm run napi:build:decode` → clang-sys finds
  libclang via `xcrun` (no `LIBCLANG_PATH`), co-locates 21 `.dylib` entries;
  `otool -L index.darwin-arm64.node` shows all 7 libav\* NEEDED as
  `@loader_path/...`, no build-tree paths.
- macOS plain-Node load: `require('./native/decode')` → exports
  `capabilities`, `versionInfo`, `NativeDecode`; `capabilities()` →
  `[ 'software' ]`, `versionInfo()` → `avcodec=4070500` (= 62.28.100) — proof
  the `@loader_path` wiring resolves the co-located dylibs with no env.
- macOS integration suite: `npx vitest run
  src/main/export-decode-native.integration.test.ts` → 17 passed.

## Upstream and community evidence

- The [NAPI-RS testing guide](https://napi.rs/docs/more/testing-debugging)
  defines the two test boundaries, recommends both Rust and JavaScript
  integration tests, gives the two-feature `test-noop` configuration, and says to
  exercise the generated loader rather than requiring a build artifact directly
  from `target/debug`.
- The [NAPI-RS Cargo feature reference](https://napi.rs/docs/concepts/cargo-features)
  lists `dyn-symbols` as a default feature, says to disable it only when direct
  symbol linking is deliberate and tested, and warns that dynamic lookup is not a
  runtime polyfill — the host must still provide every API that is called.
- [ast-grep's NAPI crate](https://github.com/ast-grep/ast-grep/blob/main/crates/napi/Cargo.toml)
  depends on separate core/config/language crates and defines a
  `napi-noop-in-unit-test` feature specifically to prevent undefined `napi_*`
  symbols in Cargo tests.
- [Rolldown's testing guide](https://rolldown.rs/development-guide/testing)
  maintains distinct Rust and Node.js suites; its Node suite validates the public
  package API — the same core-versus-binding boundary at a larger project scale.
- The [official NAPI-RS package template](https://github.com/napi-rs/package-template)
  keeps NAPI-RS defaults and tests built addons under real Node versions and an
  OS/target matrix.

## Status

- **Done** (branch `fix/native-linux-rust-tests`): `@weftcut/core` `test-noop` +
  Rust tests on all three OSes (macOS `dynamic_lookup` hack removed); core +
  decode `dyn-symbols` restored; decode built and tested on the Linux CI leg.
- **Done** (2026-07-19, macOS 26.5.2 arm64): macOS decode SW vertical —
  from-source LGPL FFmpeg 8.1 staged (`resources/ffmpeg-lgpl/mac`,
  sha256-pinned tarball), darwin branches in `fetch-ffmpeg-lgpl.mjs` +
  `napi-build-decode.mjs`, `@loader_path` install-name rewrite at stage time,
  addon built and loading self-contained in plain Node, 28 Rust + 17
  integration tests passing, darwin admitted to the three gated test files
  (napi integration + both export e2e gates).
- **TODO**: macOS decode CI leg (checklist item 6) and electron-builder
  packaging (item 7) — tracked separately. Longer term, keep the exported NAPI
  layer thin and continue moving NAPI-free logic behind narrow Rust interfaces
  (as with `weftcut-eval`), splitting at useful seams rather than wholesale.
