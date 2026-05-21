# Setup

Prerequisites for building WeftCut on each supported OS, and the
first-run flow.

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
   ~6 GB. Required once.
3. **WebView2 Runtime** — preinstalled on Windows 11; nothing to do.
4. **Node 20+** — `winget install -e --id OpenJS.NodeJS.LTS`.

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
4. `bash scripts/init-dev.sh && npm install && npm run dev`.

## Linux

1. **Rust**: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`.
2. **System libs** (Debian/Ubuntu — adjust for your distro):
   ```sh
   sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev \
                    build-essential curl wget file libxdo-dev \
                    libssl-dev libayatana-appindicator3-dev \
                    librsvg2-dev
   ```
3. **Node 20+** via your distro or nvm.
4. `bash scripts/init-dev.sh && npm install && npm run dev`.

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

The PixiJS renderer pulls `pixi.js`, `mp4box`, and `libass-wasm`
(JASSUB) from npm. These install automatically via `npm install`; no
separate native step. WebCodecs APIs are available in the WebView2 /
WKWebView / WebKitGTK runtimes that Tauri uses on each platform.

## First-run flow

`scripts/init-dev.{ps1,sh}` is idempotent and:

1. Reports which prerequisites are missing.
2. Generates `apps/desktop/src-tauri/icons/icon.png` (placeholder) so
   the Tauri config validates without you running `tauri icon` first.

## Bundling for distribution

```sh
npm run tauri icon path/to/source-1024.png --workspace apps/desktop
# restore the multi-format icon array in tauri.conf.json
npm run build
```

The build carries no native side-dependencies beyond ffmpeg (auto-
downloaded by `ffmpeg-sidecar` on first run of the bundled binary).
