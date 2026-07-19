# NAPI-RS Linux testing and production symbol loading

Verified 2026-07-19 on the WeftCut workspace. This note records why the native
crate's Rust test binary behaves differently from the addon loaded by Electron,
and the upstream/community pattern that fits those two execution modes.

## Verdict

The established pattern is layered, not a choice between `noop` and
`dyn-symbols`:

1. Keep domain logic independent of NAPI-RS types and test it with ordinary Rust
   tests.
2. When tests in the addon crate still compile `#[napi]` exports, enable an
   explicit test-only feature containing **both** noop features:

   ```toml
   [features]
   test-noop = ["napi/noop", "napi-derive/noop"]
   ```

   Run those tests with `cargo test --features test-noop`.
3. Build the real `.node` addon and test it through the same Node/Electron loader
   used by the application. This is the layer that validates JS conversions,
   exceptions, promises, references, garbage collection, and environment
   lifecycle.

`noop` is a test compilation mode, not a production feature and not a fake
JavaScript engine. `dyn-symbols` is a production symbol-resolution policy; it
does not replace either Rust tests or host integration tests.

## Why Linux exposed the failure

A Rust test target is a standalone executable, whereas a `.node` file is loaded
inside a Node-compatible host. Direct N-API calls in the addon expect the host to
supply `napi_*` symbols. The current WeftCut configuration disables NAPI-RS
default features, including `dyn-symbols`, so those calls remain direct imports.

Electron supplies the imports when it loads the production addon. A standalone
Linux test executable does not. Linux therefore rejects the unresolved symbols
when it links or starts the executable. The existing CI handles the other hosts
with platform-specific behavior: Windows has its import-library path, and macOS
adds `-undefined dynamic_lookup`. These are host/linker differences, not
different behavior in the encoder registry.

## Local probes

The official noop configuration linked and ran the registry tests on Linux:

```sh
cargo test --manifest-path apps/desktop/native/Cargo.toml --lib \
  --features export,napi/noop,napi-derive/noop encoder_registry::tests
```

Result: 9 passed, 0 failed.

The complete addon-crate suite also linked and started:

```sh
cargo test --quiet --manifest-path apps/desktop/native/Cargo.toml \
  --features jobs,export,mcp,cloud,napi/noop,napi-derive/noop
```

Result: 336 tests ran; 330 passed. The remaining six reached runtime and failed
only because this machine had no FFmpeg executable. There was no N-API symbol
failure. Enabling `napi-derive/noop` also makes exported wrappers disappear and
therefore produces many expected `dead_code` warnings in this currently broad
adapter crate.

Separately, the current production `.node` was confirmed loadable by Node and
Electron. Therefore the Linux Rust-test fix does not imply that production is
currently broken.

## Upstream and community evidence

- The [NAPI-RS testing guide](https://napi.rs/docs/more/testing-debugging)
  explicitly defines two test boundaries, recommends both Rust and JavaScript
  integration tests, gives the two-feature `test-noop` configuration above, and
  says to exercise the generated loader rather than requiring a build artifact
  directly from `target/debug`.
- The [NAPI-RS Cargo feature reference](https://napi.rs/docs/concepts/cargo-features)
  lists `dyn-symbols` as a default feature. It says to disable it only when direct
  symbol linking is deliberate and tested. It also warns that dynamic lookup is
  not a runtime polyfill: the host must still provide every API that is called.
- [ast-grep's NAPI crate](https://github.com/ast-grep/ast-grep/blob/main/crates/napi/Cargo.toml)
  depends on separate core/config/language crates and defines a feature named
  `napi-noop-in-unit-test` specifically to prevent undefined `napi_*` symbols in
  Cargo tests.
- [Rolldown's testing guide](https://rolldown.rs/development-guide/testing)
  maintains distinct Rust and Node.js suites; its Node suite validates the
  public package API. This is the same core-versus-binding boundary at a larger
  project scale.
- The [official NAPI-RS package template](https://github.com/napi-rs/package-template)
  keeps NAPI-RS defaults and tests built addons under real Node versions and an
  OS/target matrix.

## Recommendation for WeftCut

For the immediate CI/test repair:

- Add `test-noop = ["napi/noop", "napi-derive/noop"]` to the native crate.
- Add `test-noop` only to the Rust unit-test command and run that command on
  Linux as well as Windows/macOS.
- Remove the macOS `dynamic_lookup` test workaround after the noop path has been
  verified on all three runners.
- Keep the real addon build and Electron E2E suite. They already exercise
  `@weftcut/core` through the production loader and are the correct binding
  contract tests.

For production, never enable `noop`. Restoring `napi/dyn-symbols` would align the
addon with NAPI-RS v3 defaults and current upstream guidance, because the 2026-06-17
configuration disabled defaults without documenting direct symbol linking as an
intentional constraint. Treat that as a separate production change: build the
actual addon and pass the Electron smoke/E2E matrix before retaining it.

Longer term, continue moving NAPI-free logic behind narrow Rust interfaces (as
already done with `weftcut-eval`) and keep the exported NAPI layer thin. Do this
incrementally at useful seams; it is not necessary to split the whole native
crate merely to fix this linker failure.
