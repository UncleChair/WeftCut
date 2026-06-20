# Parallel development with worktrees

WeftCut is often driven from several sessions at once (you plus one or more
agents). Sharing a single checkout means every session fights over the same
working tree, the same branch, and the same `node_modules` / Rust `target/`.
A small pool of **persistent git worktrees** removes that friction: each
session gets its own working tree and branch, and dependencies are installed
once per worktree and reused forever.

## Why worktrees (and what they do *not* share)

A worktree shares the repository's `.git` but has its own working directory.
Tracked files come from the branch it has checked out; **untracked build
artifacts do not carry over**:

| Asset | Size here | Shared across worktrees? |
| --- | --- | --- |
| `node_modules` (root + `apps/desktop`) | ~0.45 GB | No — installed per worktree |
| `apps/desktop/native/target/` | very large (10s–100s of GB) | No — built per worktree |

The npm side is cheap: a fresh worktree's `npm install` re-links from the warm
npm cache (no network re-download). The Rust side is the real cost — the first
`npm run dev` (or `napi build`) in a new worktree cold-compiles the whole
dependency tree. Because these worktrees are **persistent** (created once,
reused for many features), that cold compile is paid once and then the
`target/` stays warm.

> Do **not** point worktrees at one shared `CARGO_TARGET_DIR`. On Windows the
> `@weftcut/core` `.node` addon can't be relinked while another instance has it
> loaded, and branches with differing Rust churn the shared fingerprint cache.
> Separate per-worktree `target/` is correct for concurrent live dev.

## The pool

Two persistent sibling worktrees live next to the primary checkout:

```
learning/
  videtor/        <- primary checkout (instance 0)
  videtor-wt1/    <- worktree (instance 1)
  videtor-wt2/    <- worktree (instance 2)
```

Each worktree is just a **workspace**, not tied to one feature. Start each
task with its own branch inside whichever worktree is free:

```powershell
cd ..\videtor-wt1
git switch -c feat/my-small-feature main
# ...work, commit, push...
```

Git forbids checking out the same branch in two worktrees, which naturally
enforces "one branch per worktree" — no accidental overlap.

## Keeping worktrees in sync

All worktrees share one object store, so **`git fetch` from any one of them
updates `origin/*` for all of them** — syncing is O(1), not O(N). The working
rules:

- **Branch is short-lived, worktree is permanent.** Start each task from fresh
  main (`git switch -c feat/x origin/main`), and **rebase** the feature branch
  onto `origin/main` before integrating rather than merging main into it — small
  branches stay linear and merge clean.
- **Integrate via push + PR (or fast-forward to main), then delete the branch.**
  Don't let a worktree squat on a months-old branch.
- **`git stash` is global** (`refs/stash` is shared across worktrees) — don't use
  it to isolate per-worktree work; commit instead.
- `git worktree prune` clears admin metadata after a worktree dir is deleted by
  hand.
- **After fast-forwarding / rebasing a worktree to new main, reconcile its
  deps.** `git` only updates tracked files; `node_modules` is untracked and
  per-worktree, so if the pulled commits changed `package.json` /
  `package-lock.json` the worktree is now running against stale dependencies.
  Run `npm install` in it (warm cache makes it a quick delta). Easy to forget
  because the working tree looks clean.

A 30-second health check across the pool — fetches once, then prints each
worktree's branch, ahead/behind vs `origin/main`, and dirty state:

```powershell
pwsh scripts/worktree-sync.ps1
```

## Running concurrent dev instances

The renderer's Vite server hardcodes port 1420 (`strictPort: true` in
`apps/desktop/electron.vite.config.ts`), so two plain `npm run dev` runs collide
on that port. Electron has no app-identifier singleton, so the **only** thing two
instances fight over is the Vite port and the shared `userData` directory.

To run a second instance from another worktree, give it a distinct Vite port and
its own `userData` dir:

1. **Port** — change the renderer's `server.port` in the second worktree's
   `apps/desktop/electron.vite.config.ts` to a free port (e.g. `1430`). It's a
   tracked file, but the edit lives only in that worktree's branch; don't commit
   it. `strictPort` then keeps the collision loud if you forget.
2. **State** — pass Electron's built-in `--user-data-dir` switch so the instance
   gets its own `userData` (electron-vite forwards extra args after `--` to the
   Electron binary):

   ```powershell
   # in the second worktree, after bumping server.port to 1430
   npm run dev -- --user-data-dir="$env:APPDATA\dev.weftcut.desktop.wt1"
   ```

Isolating `userData` keeps each instance's `mcp_auth.json`, `cloud_keys.json`,
settings, recents and the user-Motif store from racing the other's — they share
nothing. The primary worktree runs the normal way with `npm run dev` on 1420.

> The MCP and events ports auto-pick a free socket at startup, and with isolated
> `userData` each instance writes its own `mcp_auth.json`. Query `get_mcp_info`
> (or read that file) per instance to connect an external agent.

## Stopping dev & freeing stuck ports

Stop a dev session with **Ctrl-C in its terminal**, not by closing the app
window. On Windows, closing the window only exits the Electron app — the Vite
dev-server child is frequently orphaned and keeps holding its strict port, so
the next launch fails with a port collision. (Dev-only: a packaged build has no
Vite and binds no port, so it never hits this.)

When a port is stuck, free it:

```powershell
pwsh scripts/dev-clean-ports.ps1               # frees 1420/1430/1440 (+5173)
pwsh scripts/dev-clean-ports.ps1 -Ports 1430   # just one
```

It kills only Node/Vite listeners (plus their npm parent); a non-Vite process
on a port is reported and left alone. (If you moved a second instance off 1430
onto another port, pass it explicitly with `-Ports`.)

## Adding / removing a worktree

```powershell
# add a third
git worktree add ..\videtor-wt3 -b wt3 main
cd ..\videtor-wt3 ; npm install

# remove one (must be clean)
git worktree remove ..\videtor-wt3
```

## Disk & target hygiene

`target/` is per-worktree and unbounded — left alone it dominates the disk. A
one-time measurement of the primary found a ~356 GB `target/`, of which
~194 GB was `debug/deps` (almost all dependency `.pdb` debug info) and ~146 GB
was `debug/incremental`. Two levers stop it growing back, ordered by payoff:

1. **Dependencies carry no debug info** — already set in
   `apps/desktop/native/Cargo.toml`:

   ```toml
   [profile.dev.package."*"]
   debug = false
   ```

   This strips the dependency `.pdb` that dominated `target/debug` while keeping
   our own crates fully debuggable. Biggest single win.

2. **Share compile work across worktrees with `sccache`** — a per-user compiler
   cache keyed by source+flags hash. Each worktree keeps its **own** `target/`
   (so no shared-target relink lock), but identical dependency crates are
   compiled once and reused everywhere, and the cache is LRU-bounded (unlike
   `target/`). Set in your shell profile:

   ```powershell
   cargo install sccache            # or: winget install sccache
   $env:RUSTC_WRAPPER   = "sccache"
   $env:CARGO_INCREMENTAL = "0"     # sccache can't cache incremental builds;
                                    # turning it off maximizes cross-worktree hits
   $env:SCCACHE_CACHE_SIZE = "40G"
   ```

   The trade is per-crate incremental rebuilds for shared dependency caching —
   worth it here, where the dependency tree (napi, ffmpeg-next, …) dwarfs our
   own crates.

3. **Periodic GC with `cargo-sweep`** — cargo never collects stale fingerprints
   or old-toolchain artifacts; sweep does, keeping `target/` bounded as a
   backstop:

   ```powershell
   cargo install cargo-sweep
   cargo sweep --time 15            # drop artifacts untouched for 15 days
   cargo sweep --installed          # drop artifacts from removed toolchains
   ```

To reclaim a bloated existing `target/`, run `cargo clean` from
`apps/desktop/native` while no dev instance is running (a live instance keeps the
`@weftcut/core` `.node` addon loaded, so that file survives until it stops).
Don't build `--release` in a dev worktree unless you're testing release;
designate one worktree as the "Rust-heavy" one and keep the rest lean. Two
worktrees is usually enough for you plus one agent.
