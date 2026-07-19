# NAPI-RS multi-platform testing and production symbol loading

Verified 2026-07-19 on the WeftCut workspace and generalized to all three
desktop targets. This note records why a native crate's Rust test binary behaves
differently from the addon Electron loads, the `test-noop` test pattern (with the
per-crate nuance both WeftCut addons hit), the production `dyn-symbols` policy,
and the per-OS build/runtime specifics — including a macOS checklist, because the
`@weftcut/native-decode` darwin path is not yet wired.

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
| HW lane | `d3d11va` (`#[cfg(windows)]`) | VAAPI copy-back (`#[cfg(target_os="linux")]`) | **none yet** — VideoToolbox = future |
| `FFMPEG_DIR` | `resources/ffmpeg-lgpl/win` | `resources/ffmpeg-lgpl/linux` | *(no asset yet)* |
| libclang | `C:\Program Files\LLVM\bin` (wrapper hard-sets) | `apt libclang-dev`; clang-sys auto-discovers | Xcode toolchain; usually auto via `xcrun` |
| runtime lib resolution | DLLs prepended to PATH | `DT_RPATH=$ORIGIN` baked (`--disable-new-dtags`) + `.so` co-located | `@loader_path` (todo) |
| test env | `FFMPEG_DIR` + `LIBCLANG_PATH`, DLLs on PATH | `FFMPEG_DIR` + `LD_LIBRARY_PATH=…/lib` | todo |

CI currently guards the decode build/test steps with `runner.os != 'macOS'`.

## macOS decode: checklist for the darwin device

The realistic **initial** scope on macOS is the **SW lanes only** (`preview_sw` /
`export_sw` compile everywhere); the HW VideoToolbox backend is a separate,
larger effort — decode has no `cfg(target_os = "macos")` code today. Plumbing
needed:

1. **LGPL-shared ffmpeg asset.** BtbN publishes Windows/Linux only. Provide a
   macOS ffmpeg 8.1 *shared* build (arm64 + x64, or universal) built LGPL-clean
   (`--enable-shared`, no `--enable-gpl`/`--enable-nonfree`). `assertLgplBanner`
   in `fetch-ffmpeg-lgpl.mjs` rejects a GPL/nonfree banner, so the source must
   pass it.
2. **OS_KEY maps.** Add `darwin: 'mac'` to the `{ win32, linux }` maps in both
   `fetch-ffmpeg-lgpl.mjs` (`OS_KEY`, `BUILDS`) and `napi-build-decode.mjs`
   (`osKey`).
3. **rpath analog.** Linux bakes `$ORIGIN`; macOS uses `@loader_path`. Add a
   darwin branch in `napi-build-decode.mjs`:
   `RUSTFLAGS=-C link-arg=-Wl,-rpath,@loader_path`. Inspect the bundled dylibs'
   install names with `otool -L`; if they carry absolute paths, rewrite them to
   `@rpath/lib*.dylib` with `install_name_tool -id` / `-change`.
4. **dylib co-location.** Mirror the Linux `.so` copy loop for `.dylib`,
   preserving the SONAME symlink chain (`libX.dylib → libX.62.dylib`).
5. **libclang.** macOS libclang ships with the Xcode / Command Line Tools
   toolchain; clang-sys usually finds it via `xcrun`. If not, set `LIBCLANG_PATH`
   to `$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain/usr/lib` or the
   Homebrew `llvm` libdir.
6. **CI.** Flip the four decode steps from `runner.os != 'macOS'` to include
   `macos-latest`, and add a macOS branch to the Rust tests step. For the
   `cargo test` binary use `DYLD_FALLBACK_LIBRARY_PATH=…/lib` (SIP strips
   `DYLD_*` only for system/protected binaries, not user test binaries; the
   packaged `.node` relies on baked `@loader_path`, so it needs no env).
7. **Packaging.** Ship the `.dylib` beside the unpacked `.node` in
   `electron-builder.yml`, mirroring the Linux `.so` packaging.
8. **Symbol collision.** Linux needed `RTLD_DEEPBIND` to defeat the
   Chromium-vs-libffmpeg collision; macOS defaults to **two-level namespaces**, so
   a flat-namespace clash is unlikely — but still smoke-test that the addon
   dlopens cleanly (`otool -L` shows no stray undefined `napi_*`; a Node
   `process.dlopen` returns the exports).

## Local probes (verified on Linux, 2026-07-19)

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
- **TODO**: macOS decode (checklist above) — tracked separately, handled on a
  macOS device. Longer term, keep the exported NAPI layer thin and continue
  moving NAPI-free logic behind narrow Rust interfaces (as with `weftcut-eval`),
  splitting at useful seams rather than wholesale.
