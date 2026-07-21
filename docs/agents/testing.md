# Testing

Where WeftCut's tests live, why they're split the way they are, and how to run
each layer. There is **no single `tests/` directory** — that's deliberate (see
[Why not one directory](#why-not-one-directory)). Tests are grouped by *runner*,
not scattered by neglect.

## The layers

| Layer | Location | Runner | Command (cwd) |
|---|---|---|---|
| **Unit (TS)** | colocated next to source: `apps/desktop/src/{renderer,main,shared}/**/*.{test,spec}.{ts,tsx}` | Vitest | `npm test` (repo root) · `npm run test:watch` (`apps/desktop`) |
| **Rust** | `native/**` — inline `#[cfg(test)]` + `native/tests/` | cargo | see [Rust](#rust) (repo root) |
| **E2E** | `apps/desktop/e2e/electron/*.spec.ts` | Playwright driving the **real Electron app** | `npm run e2e` (repo root or `apps/desktop`) |
| **Mutation / PBT** | mutates `src/main/state/**` (config: `apps/desktop/stryker.config.json`) | StrykerJS (Vitest runner) | `npm run pbt:stryker` (`apps/desktop`) |

The `apps/desktop` unit script excludes `**/*.browser.test.ts`; there are none
today — it's a standing guard for a pattern that would need a browser runner.

### Rust

Three crates under `apps/desktop/native/` (workspace root `weftcut`, members
`eval` + `decode`). Run from **`apps/desktop`** — both CI and the commands below
resolve `native/Cargo.toml` and `resources/` relative to it, not the repo root.
The `test-noop` feature stubs the `napi_*` / ThreadsafeFunction symbols a
standalone `cargo test` can't link:

```bash
cargo test -p weftcut-eval --manifest-path native/Cargo.toml           # eval crate (pure)
cargo test --manifest-path native/Cargo.toml --lib --features test-noop # root napi crate
# decode crate — the repo's only ffmpeg-next consumer: needs FFMPEG_DIR to build
# AND the bundled libav*.so on the loader path at run (its cargo-test binary has
# no RPATH, unlike the .node addon, so LD_LIBRARY_PATH is required — omit it and
# the binary links but fails at startup with `libavcodec.so.62: cannot open …`).
FFMPEG_DIR="$PWD/resources/ffmpeg-lgpl/linux" \
  LD_LIBRARY_PATH="$PWD/resources/ffmpeg-lgpl/linux/lib" \
  cargo test --manifest-path native/decode/Cargo.toml --features test-noop
```

(Windows/macOS swap the `ffmpeg-lgpl/<os>` dir + loader var — DLLs already on
`PATH` on Windows, `DYLD_FALLBACK_LIBRARY_PATH` on macOS; see `electron-ci.yml`.)

## Why not one directory

- **Unit tests are colocated on purpose.** They sit beside the module (short
  relative imports, move/delete together, coverage gaps visible at a glance).
  `apps/desktop/vitest.config.ts` pins `include` to the three `src/` roots.
- **E2E can't run under Vitest.** The specs boot a real Electron app via
  Playwright; `vitest.config.ts` explicitly keeps Vitest from scooping up
  `e2e/**/*.spec.ts` (they fail under it). Different runner, different process
  model.
- **Rust tests belong to their crates** — cargo owns discovery.

So "all tests in one folder" has no clean endpoint here; the boundaries are the
three runners.

## Fixtures — two trees, on purpose

- **`apps/desktop/fixtures/`** — small, **committed** inputs for the Vitest unit
  tests. `media/` holds tiny clips (e.g. the `tiny.mp4`/`tiny.mkv` container
  parity pair); `mcp/` holds `rust-catalog-snapshot.json`. See
  `apps/desktop/fixtures/README.md`.
- **`apps/desktop/e2e/fixtures/`** — real-codec media for the conformance
  harness, **generated** by `generate-fixtures.mjs` (needs ffmpeg). The `media/`
  and `decode-bench/` subtrees are gitignored and rebuilt on checkout; point
  elsewhere with `WEFTCUT_TEST_MEDIA`.

Keep them separate: unit fixtures stay tiny and committed, e2e fixtures are
large and generated. Merging them would recouple the two and bloat the repo.

## Generated output (gitignored — not clutter to tidy, not committable)

These appear in a working tree but are never tracked; they're rebuilt locally or
in CI: `determinism-artifacts/`, `test-results/`, `playwright-report/`,
`apps/desktop/e2e/fixtures/media/`, `apps/desktop/e2e/fixtures/decode-bench/`,
`reports/`, `.stryker-tmp/`.

## Deeper docs

- `apps/desktop/e2e/README.md` — authoring/running the E2E suite, the isolation
  model, and known flakes.
- `docs/conformance.md` — the Rust `media_conformance` analyzer behind the
  export/color/audio gates.
- `docs/decode-bench.md` — the decode-strategy benchmark.
