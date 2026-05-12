# Setup

Prerequisites for building Videtor on each supported OS, and the first-run flow.

## Windows 11

1. **Rust** (stable, MSVC toolchain):
   ```powershell
   winget install -e --id Rustlang.Rustup
   # New shell, then:
   rustup default stable-x86_64-pc-windows-msvc
   ```
2. **Visual Studio 2022 Build Tools** (provides the MSVC linker + Windows SDK that Rust links against):
   ```powershell
   winget install -e --id Microsoft.VisualStudio.2022.BuildTools `
     --override "--passive --add Microsoft.VisualStudio.Workload.VCTools `
                 --add Microsoft.VisualStudio.Component.Windows11SDK.22621"
   ```
   ~6 GB. Required once.
3. **WebView2 Runtime** — preinstalled on Windows 11; nothing to do.
4. **Node 20+** — `winget install -e --id OpenJS.NodeJS.LTS`.
5. **libmpv** — needed once you start working on `src/mpv/`. `libmpv2` is now an **optional Cargo feature** (`mpv`); the regular `cargo build` skips it entirely. To enable preview work:
   1. Download a libmpv "dev" build for Windows: <https://github.com/shinchiro/mpv-winbuild-cmake/releases> → `mpv-dev-x86_64-*.7z` (contains `libmpv-2.dll`, `libmpv-2.lib`, headers).
   2. **Runtime DLL**: drop `libmpv-2.dll` somewhere on `PATH`. Convention for Videtor dev: `apps/desktop/src-tauri/target/debug/libmpv-2.dll` so `cargo run` finds it via the binary's directory.
   3. **Link-time import lib**: rename `libmpv-2.lib` → `mpv.lib` and put it in a directory on `%LIB%`, or set `set RUSTFLAGS=-L C:\path\to\libmpv\lib` before `cargo build`. Convention: keep all libmpv files under `C:\dev\libmpv\` and add that path to both `%PATH%` and `%LIB%` in your shell profile.
   4. Build / run with the feature on:
      ```powershell
      $env:Path = "C:\dev\libmpv;$env:Path"
      $env:LIB  = "C:\dev\libmpv;$env:LIB"
      npm run dev -- --features mpv     # tauri dev forwards extra args to cargo
      # or for tests:
      cargo test --features mpv
      ```
   5. **Bundling for distribution**: `apps/desktop/src-tauri/tauri.windows.conf.json` declares a `bundle.resources` mapping that ships `vendor/libmpv/libmpv-2.dll` → next to `videtor.exe` in the .msi / .nsis installer. Make sure `vendor/libmpv/libmpv-2.dll` exists before `npm run tauri:build`. Note: the vendored full-codec dev DLL is ~118 MB and inflates the installer accordingly; swap to a slim libmpv variant if size matters.

Then from the repo root:
```powershell
pwsh scripts/init-dev.ps1   # checks toolchain, generates placeholder icon
npm install
npm run dev                 # builds Rust + launches Vite + opens Tauri window
```

## macOS

1. **Xcode Command Line Tools**: `xcode-select --install`.
2. **Rust**: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.
3. **Node 20+**: `brew install node`.
4. **libmpv**: `brew install mpv` (the formula installs both binary and dylib).
5. `bash scripts/init-dev.sh && npm install && npm run dev`.

## Linux

1. **Rust**: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.
2. **System libs** (Debian/Ubuntu — adjust for your distro):
   ```sh
   sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev \
                    build-essential curl wget file libxdo-dev \
                    libssl-dev libayatana-appindicator3-dev \
                    librsvg2-dev libmpv-dev mpv
   ```
3. **Node 20+** via your distro or nvm.
4. `bash scripts/init-dev.sh && npm install && npm run dev`.

## First-run flow

`scripts/init-dev.{ps1,sh}` is idempotent and:

1. Reports which prerequisites are missing.
2. Generates `apps/desktop/src-tauri/icons/icon.png` (placeholder) so the Tauri config validates without you running `tauri icon` first.

Once running, the dev shell shows a window with a `#video-surface` placeholder div and `core: ok` in the header — confirming React ↔ Rust IPC works. Phase 0 work begins from there.

## ffmpeg

Videtor will auto-download ffmpeg via `ffmpeg-sidecar` on first run, but the downloader uses `ureq` without SOCKS support. If you're behind an `ALL_PROXY=socks5h://...` proxy (China / GFW workarounds, corporate VPNs), the download will fail with `Connection refused`. Workarounds:

- **Recommended:** install ffmpeg natively. Bootstrap then takes the "already installed" path:
  - Windows: `winget install -e --id Gyan.FFmpeg`
  - macOS:   `brew install ffmpeg`
  - Linux:   `sudo apt install ffmpeg`
- Or temporarily clear `ALL_PROXY`/`HTTP_PROXY` in the shell that launches `npm run dev` if you have direct internet access.

## Cargo dependency versions

The versions in `apps/desktop/src-tauri/Cargo.toml` are best-effort as of scaffolding. If `cargo build` fails on dependency resolution — particularly for `libmpv2`, `wry`, `rmcp`, `ts-rs`, `ffmpeg-sidecar` — bump the major version to whatever crates.io currently shows and try again. The `rmcp` feature gate names (`server`, `transport-streamable-http-server`) are best-guess; check the [rust-sdk repo](https://github.com/modelcontextprotocol/rust-sdk) for the actual feature names.

## Phase 0 spike validation

The four risks the spike must validate (see [roadmap.md](roadmap.md)):

| Risk | Validates in |
|---|---|
| libmpv embed + surface sync to placeholder div | `src-tauri/src/mpv/` |
| Hidden `wry` webview snapshots a PNG on each OS | `src-tauri/src/raster/` |
| `ffmpeg-sidecar` auto-downloads + runs `ffmpeg -version` | `src-tauri/src/ffmpeg/` |
| `rmcp` server reachable from Claude Desktop's MCP config | `src-tauri/src/mcp/` |

If any of these don't work end-to-end on the host OS, document the swap (Electron, headless-Chromium fallback, native Cocoa/AppKit shim, etc.) and update [architecture.md](architecture.md) before Phase 1.

## Bundling for distribution

```sh
npm run tauri icon path/to/source-1024.png --workspace apps/desktop  # generate full icon set
# restore the multi-format icon array in tauri.conf.json
npm run build
```

### libmpv per-platform bundling

End users should not have to install libmpv themselves. The bundle config splits per platform via `tauri.<platform>.conf.json` overlay files (merged on top of `tauri.conf.json` at build time):

| Platform | Overlay file | Strategy | End-user impact |
|---|---|---|---|
| Windows | `tauri.windows.conf.json` | Bundles `vendor/libmpv/libmpv-2.dll` next to `videtor.exe` in the .msi / .nsis | Self-contained — installer carries the DLL |
| macOS | `tauri.macos.conf.json` | `bundle.macOS.frameworks` embeds the dylib into `Contents/Frameworks/`; tauri-bundler rewrites the install_name | Self-contained — but the build host needs `brew install mpv` so the dylib exists at `/opt/homebrew/opt/mpv/lib/libmpv.2.dylib` (Apple Silicon) or `/usr/local/opt/mpv/lib/libmpv.2.dylib` (Intel). Edit the path if your build host differs. |
| Linux (.deb / .rpm) | `tauri.linux.conf.json` | Declares `libmpv2` (Debian/Ubuntu) / `mpv-libs` (Fedora/RHEL) as a package-manager dependency | apt/dnf auto-installs libmpv when the user installs the package — not strictly "bundled" but no manual step |
| Linux (AppImage) | not wired yet | TBD — needs `linuxdeploy --plugin libmpv` or similar so the AppImage carries libmpv internally | If you target AppImage, plumb this before shipping |

Code signing (Win + macOS) and `tauri-plugin-updater` are Phase 7 — see [roadmap.md](roadmap.md).
