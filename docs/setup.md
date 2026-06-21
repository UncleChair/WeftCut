# Setup

Prerequisites for building WeftCut on each supported OS, and the
first-run flow.

WeftCut is an Electron app: it bundles its own Chromium on every OS, so
there is **no per-OS webview runtime to install** (no WebView2 on
Windows, no WKWebView on macOS, no WebKitGTK on Linux). The only native
build dependency is the Rust toolchain, used to compile the `@weftcut/core`
napi addon under `apps/desktop/native/`.

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
3. **Node 20+** — `winget install -e --id OpenJS.NodeJS.LTS`.

Then from the repo root:
```powershell
npm install
npm run dev   # from repo root → apps/desktop electron-vite dev
```

`npm run dev` builds the napi addon as needed, starts Vite (renderer),
and launches the Electron window.

## macOS

1. **Xcode Command Line Tools**: `xcode-select --install`.
2. **Rust**: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.
3. **Node 20+**: `brew install node`.
4. `npm install && npm run dev`.

## Linux

1. **Rust**: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.
2. **Build essentials** for the napi addon (Debian/Ubuntu — adjust for
   your distro):
   ```sh
   sudo apt install build-essential curl wget file libssl-dev
   ```
   Electron supplies its own Chromium, so the old WebKitGTK / libsoup /
   appindicator system libraries are **no longer required**.
3. **Node 20+** via your distro or nvm.
4. `npm install && npm run dev`.

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

After cloning, `npm install` is the only bootstrap step. There are no
placeholder icons to generate: the app icon is committed at
`apps/desktop/build/icon-256.png` and electron-builder consumes it
directly when packaging (see below).

## Icons & bundling for distribution

The packaging command is `package` in `apps/desktop`:

```sh
npm run package --workspace apps/desktop
```

This runs `napi build` (release addon), `electron-vite build`, then
`electron-builder` to produce installers (NSIS on Windows, AppImage +
deb on Linux, dmg on macOS) under `apps/desktop/release/`.

The app icon lives at `apps/desktop/build/icon-256.png` — a 256×256
source. electron-builder generates the Windows `.ico` for NSIS from it
and uses the PNG directly on Linux; the filename is deliberately
non-magic so it is **not** fed to the macOS `.icns` generator (which
requires ≥512×512). To ship a full icon set, replace it with a ≥512
(ideally 1024×1024) master, add a `mac.icon` entry in
`apps/desktop/electron-builder.yml`, and let electron-builder regenerate
the per-platform variants.

The build carries no native side-dependencies beyond ffmpeg (auto-
downloaded by `ffmpeg-sidecar` on first run of the bundled binary, or
picked up from PATH when installed manually). On Windows the NSIS
installer needs no extra optional Windows features.
