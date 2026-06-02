# Remove the Playwright-era Fixture System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fully remove the Playwright-based browser-fixture system (render layer + Rust analysis bin/commands + sample fixtures + tooling), keeping commit `86abfe9`'s non-Playwright fixes, so the new WebDriver harness (Plan 2/3) starts from a clean base.

**Architecture:** Pure deletion + dependency/script pruning across three surfaces — frontend (vitest browser config, fixture-runner TS, deps, scripts), Rust (`fixture_compare` bin, `fixtures.rs` module, two Tauri commands + their registration), and assets/tooling (sample fixtures, `check-fixtures.mjs`). After each surface, the existing gates (`tsc -b --force`, `npm test`, `vite build`, `cargo build`) must stay green. The two pure primitives in `fixtures.rs` (`extract_frame_from_file`, `compare_ssim_pngs`) are NOT preserved here — Plan 2 re-creates them in the new `media_conformance` bin.

**Tech Stack:** TypeScript/Vite/Vitest, Rust/Cargo/Tauri 2, npm workspaces.

**Branch:** `test/media-conformance-e2e` (already created, on top of `86abfe9`).

**Pre-removal baseline (verify before starting):** `npm test` = 251 passing / 25 files; `tsc -b --force` exit 0; `vite build` exit 0. Record the exact `npm test` number — it will drop by however many cases live in `runFixture.test.ts`.

---

### Task 1: Remove the frontend Playwright + fixture-runner layer

**Files:**
- Delete: `apps/desktop/vitest.browser.config.ts`
- Delete: `apps/desktop/src/render/fixtures/001_color.browser.test.ts`
- Delete: `apps/desktop/src/render/fixtures/devHooks.ts`
- Delete: `apps/desktop/src/render/fixtures/runFixture.ts`
- Delete: `apps/desktop/src/render/fixtures/runFixture.test.ts`
- Modify: `apps/desktop/src/render/PixiPreview.tsx` (remove the `devHooks` import, line 37)
- Modify: `apps/desktop/package.json` (remove 3 scripts + 3 devDeps)

- [ ] **Step 1: Confirm `devHooks` has exactly one consumer**

Run: `rg -n "devHooks|fixtures/runFixture" apps/desktop/src --glob '!**/fixtures/**'`
Expected: a single hit — `apps/desktop/src/render/PixiPreview.tsx:37:import "./fixtures/devHooks";`
(If anything else appears, stop and reassess — those consumers need handling first.)

- [ ] **Step 2: Remove the `devHooks` side-effect import from PixiPreview**

In `apps/desktop/src/render/PixiPreview.tsx`, delete this line (≈ line 37):

```ts
import "./fixtures/devHooks";
```

- [ ] **Step 3: Delete the four fixture-runner / browser-test files (git rm)**

Run:
```bash
git rm apps/desktop/vitest.browser.config.ts \
  apps/desktop/src/render/fixtures/001_color.browser.test.ts \
  apps/desktop/src/render/fixtures/devHooks.ts \
  apps/desktop/src/render/fixtures/runFixture.ts \
  apps/desktop/src/render/fixtures/runFixture.test.ts
```
Expected: 5 files staged for deletion; `apps/desktop/src/render/fixtures/` is now empty/gone.

- [ ] **Step 4: Remove the 3 fixture scripts + 3 Playwright devDeps from `apps/desktop/package.json`**

Delete these three lines from `"scripts"`:
```json
    "fixtures:render": "vitest run --config vitest.browser.config.ts",
    "fixtures:compare": "cargo run --manifest-path src-tauri/Cargo.toml --bin fixture_compare --quiet --",
    "fixtures:check": "node tools/check-fixtures.mjs"
```
(Leave `"test"`, `"test:watch"`, `"typecheck"`, `"build"`, etc. The `"build"` line preceding `"fixtures:render"` must keep its trailing comma valid — after removal the last script before these is `"test:watch"`; ensure no dangling comma.)

Delete these three lines from `"devDependencies"`:
```json
    "@vitest/browser": "^4.1.7",
    "@vitest/browser-playwright": "^4.1.7",
    "playwright": "^1.49.0",
```
(KEEP `vitest`, `@vitejs/plugin-react`, `esbuild`, `typescript`, `vite`, `@tauri-apps/cli`, `@types/*` — all still used.)

- [ ] **Step 5: Reinstall to prune the removed deps from the lockfile**

Run: `npm install` (from repo root — it's a workspace)
Expected: completes exit 0; `package-lock.json` updated (playwright + @vitest/browser* gone).

- [ ] **Step 6: Verify the frontend gates stay green**

Run:
```bash
cd apps/desktop && npx tsc -b --force
```
Expected: exit 0, no output (no dangling `devHooks`/`runFixture` references).

Run: `npm --prefix apps/desktop test`
Expected: all passing, file count = 24 (was 25 — `runFixture.test.ts` removed), test count < 251. Record the new number.

Run: `npm --prefix apps/desktop run build`
Expected: `✓ built` exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(test): remove Playwright fixture render layer + runner"
```

---

### Task 2: Remove the Rust fixture analysis (bin + module + commands)

**Files:**
- Delete: `apps/desktop/src-tauri/src/bin/fixture_compare.rs`
- Delete: `apps/desktop/src-tauri/src/fixtures.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (remove `pub mod fixtures;` + 2 command registrations)
- Modify: `apps/desktop/src-tauri/src/commands.rs` (remove 2 commands)

- [ ] **Step 1: Confirm the two commands' only frontend caller is already gone**

Run: `rg -n "extract_video_frame|compare_fixture_frame" apps/desktop/src`
Expected: NO hits (the only callers were in the now-deleted `runFixture.ts`). If any remain, handle them before proceeding.

- [ ] **Step 2: Delete the Rust bin + module (git rm)**

Run:
```bash
git rm apps/desktop/src-tauri/src/bin/fixture_compare.rs \
  apps/desktop/src-tauri/src/fixtures.rs
```
(No `Cargo.toml` `[[bin]]` edit needed — `fixture_compare` was auto-discovered from `src/bin/`.)

- [ ] **Step 3: Remove `pub mod fixtures;` from `lib.rs`**

In `apps/desktop/src-tauri/src/lib.rs`, delete the line (≈ line 18):
```rust
pub mod fixtures;
```

- [ ] **Step 4: Remove the two command registrations from `lib.rs`**

In `apps/desktop/src-tauri/src/lib.rs`, inside the `invoke_handler` list (≈ lines 132-133), delete:
```rust
            commands::extract_video_frame,
            commands::compare_fixture_frame,
```

- [ ] **Step 5: Remove the two command functions from `commands.rs`**

In `apps/desktop/src-tauri/src/commands.rs`, delete the contiguous block — the doc comment starting `/// ... P10a fixture-runner support ...` through the closing `}` of `compare_fixture_frame` (≈ lines 2237-2279) — i.e. both of these functions and their doc comments, stopping BEFORE `#[tauri::command]\npub async fn project_redo`:

```rust
#[tauri::command]
pub async fn extract_video_frame(
    mp4_bytes: Vec<u8>,
    t_us: i64,
) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || {
        crate::fixtures::extract_frame_from_bytes(&mp4_bytes, t_us)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| format!("extract join: {e}"))?
}
```
…and…
```rust
#[tauri::command]
pub async fn compare_fixture_frame(
    actual_png_bytes: Vec<u8>,
    expected_png_path: String,
) -> Result<f64, String> {
    let expected_bytes = tokio::fs::read(&expected_png_path)
        .await
        .map_err(|e| format!("read expected png {expected_png_path}: {e}"))?;
    tokio::task::spawn_blocking(move || {
        crate::fixtures::compare_ssim_pngs(&actual_png_bytes, &expected_bytes)
            .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| format!("ssim join: {e}"))?
}
```

- [ ] **Step 6: Verify the Rust crate builds (this catches dangling refs + unused-dep lints)**

Run: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: exit 0. (Plain warnings are fine; `image`/`image-compare`/`tempfile` may become unused — that does NOT fail a default build. If the build *errors* on an unused-crate-dependencies deny, remove `image` + `image-compare` from `Cargo.toml` `[dependencies]` and re-run; do NOT remove `tempfile` without `rg -n "tempfile|TempFile|NamedTempFile" apps/desktop/src-tauri/src` confirming no other user.)

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: passes (the deleted `fixtures.rs` had no `#[test]`s, so no Rust tests are lost).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(test): remove fixture_compare bin + fixtures module + Tauri commands"
```

---

### Task 3: Remove sample fixtures + tooling; keep media; final verify

**Files:**
- Delete: `apps/desktop/fixtures/001_color/` (dir)
- Delete: `apps/desktop/fixtures/002_color_stack/` (dir)
- Delete: `apps/desktop/tools/check-fixtures.mjs`
- Modify: `apps/desktop/fixtures/README.md` (now describes only `media/`)
- KEEP: `apps/desktop/fixtures/media/` (`tiny.mp4`, `tiny.mkv`, `README.md`) — used by the kept unit test `src/render/decoder/mediaInput.test.ts`.

- [ ] **Step 1: Confirm `tiny.mp4`/`tiny.mkv` are still referenced (must NOT delete media/)**

Run: `rg -n "tiny\.(mp4|mkv)|fixtures/media" apps/desktop/src`
Expected: hits in `apps/desktop/src/render/decoder/mediaInput.test.ts` (the container-parity test). Confirms `media/` stays.

- [ ] **Step 2: Delete the two sample fixtures + the check tool (git rm)**

Run:
```bash
git rm -r apps/desktop/fixtures/001_color apps/desktop/fixtures/002_color_stack
git rm apps/desktop/tools/check-fixtures.mjs
```
Expected: dirs + file staged for deletion. `apps/desktop/fixtures/` now holds only `media/` + `README.md`.

- [ ] **Step 3: Rewrite `apps/desktop/fixtures/README.md` to describe only the media clips**

Replace the file contents with:
```markdown
# Test media

Small media clips used by unit tests. `media/tiny.mp4` + `media/tiny.mkv` are
the same H.264 stream in two containers (used by
`src/render/decoder/mediaInput.test.ts` to prove MP4/Matroska reading parity).

Larger real-codec clips for the media-conformance E2E harness live OUTSIDE the
repo (see `docs/superpowers/specs/2026-06-02-media-conformance-e2e-harness-design.md`,
pointed at via `WEFTCUT_TEST_MEDIA`).
```

- [ ] **Step 4: Remove the local build artifact (untracked — no git)**

Run: `rm -rf apps/desktop/build/fixtures`
Expected: gone (it was the throwaway render output; not tracked).

- [ ] **Step 5: Full-gate verify (all four gates green together)**

```bash
cd apps/desktop && npx tsc -b --force
```
Expected: exit 0.

Run: `npm --prefix apps/desktop test`
Expected: all passing (same reduced count as Task 1 Step 6).

Run: `npm --prefix apps/desktop run build`
Expected: `✓ built` exit 0.

Run: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(test): remove sample fixtures + check-fixtures tool (keep media/)"
```

---

## Self-Review

**Spec coverage** (Cleanup section of the spec): Playwright render layer ✓ (Task 1); `fixture_compare` bin + `fixtures.rs` + devtools commands ✓ (Task 2); `fixtures:*` scripts ✓ (Task 1); sample fixtures ✓ (Task 3); "keep 86abfe9's non-Playwright fixes" ✓ (untouched — typecheck/vite-target/Compositor fix are in unrelated files); "keep media/" ✓ (Task 3 explicitly). Primitive salvage (`extract_frame_from_file`, `compare_ssim_pngs`) is intentionally deferred to Plan 2, noted in the header.

**Placeholder scan:** none — every deletion has an exact path; every edit shows the exact lines; the one conditional (unused-dep deny) has an explicit fallback command.

**Type/name consistency:** command names (`extract_video_frame`, `compare_fixture_frame`), module (`fixtures`), bin (`fixture_compare`), file paths, and script keys all match what the read-backs in this session confirmed.

## Follow-on plans (separate, not in this plan)

- **Plan 2 — `media_conformance` analyzer bin:** frame-ID reader (crop + consola glyph-match) + frame-alignment + app-only SSIM/PSNR vs decoded source; testable against an existing export.
- **Plan 3 — WebDriver E2E producer:** wdio + tauri-driver + msedgedriver auto-fetch + the `window.__weftcutTest` programmatic hook.
