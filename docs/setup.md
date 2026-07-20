# Setup

Prerequisites for building WeftCut on each supported OS, and the
first-run flow.

WeftCut is an Electron app: it bundles its own Chromium on every OS, so
there is **no per-OS webview runtime to install** (no WebView2 on
Windows, no WKWebView on macOS, no WebKitGTK on Linux). The only native
build dependency is the Rust toolchain, used to compile the `@weftcut/core`
napi addon under `apps/desktop/native/`.

The repo root contains `rust-toolchain.toml`, which tells `rustup` to use
stable Rust and install the `wasm32-unknown-unknown` target used by
`npm run build:wasm`. If your first build still reports a missing wasm
target, run this once from inside the repo:

```sh
rustup target add wasm32-unknown-unknown
```

## Windows 11

1. **Rust** (stable, MSVC toolchain):
   ```powershell
   winget install -e --id Rustlang.Rustup
   # New shell, then:
   rustup default stable-x86_64-pc-windows-msvc
   ```
2. **Visual Studio 2022 Build Tools** (provides the MSVC linker +
   Windows SDK that Rust links against):
   ```powershell
   winget install -e --id Microsoft.VisualStudio.2022.BuildTools `
     --override "--passive --add Microsoft.VisualStudio.Workload.VCTools `
                 --add Microsoft.VisualStudio.Component.Windows11SDK.22621"
   ```
   ~6 GB. Required once. The first `napi build` (`cargo`) fails without it.
3. **Node 22+** — `winget install -e --id OpenJS.NodeJS.LTS`.

Then from the repo root:
```powershell
npm install     # JS deps only
npm run bootstrap # fetch ffmpeg + compile the Rust napi addons (one-time)
npm run dev     # build eval wasm → Vite (renderer) → Electron window
```

`npm install` installs JS dependencies but does **not** build the native
addons. `npm run bootstrap` fetches ffmpeg and compiles the two napi addons
(`@weftcut/core`, `@weftcut/native-decode`); `npm run dev` then builds the
eval wasm, starts Vite, and launches the Electron window.

## macOS

1. **Xcode Command Line Tools**: `xcode-select --install`.
2. **Rust**:
   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
3. **Node 22+**: `brew install node`.
4. `npm install && npm run bootstrap && npm run dev`.

## Linux

1. **Rust**:
   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```
2. **Build essentials** for the napi addon (Debian/Ubuntu — adjust for
   your distro):
   ```sh
   sudo apt install build-essential curl wget file libssl-dev
   ```
   Electron supplies its own Chromium, so the old WebKitGTK / libsoup /
   appindicator system libraries are **no longer required**.
3. **Node 22+** via your distro or nvm.
4. `npm install && npm run bootstrap && npm run dev`.

## ffmpeg

WeftCut will auto-download ffmpeg via `ffmpeg-sidecar` on first run,
but the downloader uses `ureq` without SOCKS support. If you're behind
an `ALL_PROXY=socks5h://...` proxy (China / GFW workarounds, corporate
VPNs), the download will fail with `Connection refused`. Workarounds:

- **Recommended:** install ffmpeg natively. Bootstrap then takes the
  "already installed" path:
  - Windows: `winget install -e --id Gyan.FFmpeg`
  - macOS:   `brew install ffmpeg`
  - Linux:   `sudo apt install ffmpeg`
- Or temporarily clear `ALL_PROXY`/`HTTP_PROXY` in the shell that
  launches `npm run dev` if you have direct internet access.

## Webview-side dependencies

The PixiJS renderer pulls `pixi.js`, `@pixi/react`, and `mediabunny`
from npm. These install automatically via `npm install`; no separate native step. The WebCodecs
APIs the renderer relies on ship with Electron's bundled Chromium, so
they are available identically on every platform — there is no per-OS
webview runtime to provision.

## First-run flow

After cloning, run `npm install` (JS deps) then `npm run bootstrap` once.
`bootstrap` fetches ffmpeg (both the runtime static build and the LGPL dev
libs) and compiles the two Rust napi addons the renderer/main import
(`@weftcut/core`, `@weftcut/native-decode`) — `npm install` alone does **not**
build them, so `npm run dev` on a fresh clone fails without this step. Re-run
`bootstrap` only after touching the Rust sources under `native/`; cargo's
incremental build makes repeat runs cheap. The app icon is committed at
`apps/desktop/build/icon.png` (generated from the canonical SVG — see below)
and electron-builder consumes it directly when packaging.

## Icons & bundling for distribution

The packaging command is `package` in `apps/desktop`:

```sh
npm run package --workspace apps/desktop
```

This runs `napi build` (release addon), `electron-vite build`, then
`electron-builder` to produce installers (NSIS on Windows, AppImage +
deb on Linux, dmg on macOS) under `apps/desktop/release/`.

The canonical brand icon is the vector at
`apps/desktop/src/renderer/public/icons/icon.svg` — it also serves as the
in-app favicon and the startup-screen mark. electron-builder can't ingest
an SVG, so a 1024×1024 raster master is committed at
`apps/desktop/build/icon.png`, produced by:

```sh
npm run gen:icons --workspace apps/desktop
```

That script rasterizes the SVG through Electron's Chromium 2D canvas (no
ImageMagick/rsvg/sharp on the toolchain). electron-builder then derives the
multi-resolution Windows `.ico`, the macOS `.icns`, and the Linux png set
from the single master. After any palette tweak to the SVG, re-run
`gen:icons` and commit the regenerated `icon.png`.

The build carries no native side-dependencies beyond ffmpeg (auto-
downloaded by `ffmpeg-sidecar` on first run of the bundled binary, or
picked up from PATH when installed manually). On Windows the NSIS
installer needs no extra optional Windows features.
