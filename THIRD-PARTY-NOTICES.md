# Third-party notices

WeftCut's own source code is licensed under the [MIT License](LICENSE).
Packaged distributions (installers) additionally bundle the third-party
components below, each under its own license. None of them changes the license
of WeftCut's own code — see [docs/licensing.md](docs/licensing.md) for how the
boundaries work.

## FFmpeg — LGPL shared libraries (in-process decode)

The `@weftcut/native-decode` addon dynamically links FFmpeg shared libraries
(`libavcodec`, `libavformat`, `libavutil`, `libswscale`, `libswresample`,
`libavfilter`, `libavdevice`) built **without** `--enable-gpl` or
`--enable-nonfree`. These libraries are licensed under the
**GNU Lesser General Public License v2.1 or later**.

- License text ships in the app package at `resources/native-decode/LICENSE.txt`.
- The exact build (asset name, download URL, SHA-256, full `configuration:`
  banner) is recorded in `resources/native-decode/manifest.json`.
- Source code: <https://ffmpeg.org/download.html> /
  <https://git.ffmpeg.org/ffmpeg.git> (the manifest identifies the exact
  version). Windows/Linux binaries come from
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (`-lgpl-shared`
  assets); macOS libraries are built from the pinned FFmpeg release tarball.
- LGPL §6: the libraries are shipped as separate, user-replaceable files
  (DLLs / `.so` / `.dylib`) resolved by the dynamic linker — you may replace
  them with your own compatible FFmpeg build.

## FFmpeg — GPL command-line binaries (encode/transcode sidecar)

WeftCut bundles stock `ffmpeg` and `ffprobe` command-line binaries and runs
them strictly as **separate subprocesses** (proxy transcodes, audio conform,
export encode/mux). These builds enable GPL components (x264, x265, …) and are
licensed under the **GNU General Public License version 3**.

- License text ships in the app package at `resources/ffmpeg/LICENSE.txt`.
- The exact build (version string, full `configuration:` banner, download URL)
  is recorded in `resources/ffmpeg/manifest.json`, and
  `resources/ffmpeg/SOURCE-OFFER.txt` states where to obtain the complete
  corresponding source code.
- Binary providers: [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) (Windows),
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (Linux),
  [martin-riedl.de](https://ffmpeg.martin-riedl.de/) (macOS).

## libva (Linux only)

Linux packages bundle `libva.so.2` and `libva-drm.so.2` (VA-API dispatcher)
beside the native-decode addon so VA-API copy-back works on distributions that
ship an older libva. libva is licensed under the **MIT (Expat) License**; its
notice ships at `resources/native-decode/LIBVA-LICENSE.txt`.
Source: <https://github.com/intel/libva>.

## Electron / Chromium

The application shell is [Electron](https://www.electronjs.org/) (MIT), which
embeds Chromium and Node.js. Their license texts are included by the packager
at the application root (`LICENSE.electron.txt`, `LICENSES.chromium.html`).

## Inter font

The built-in "lower-third" Motif bundles the Inter typeface
(© The Inter Project Authors, <https://github.com/rsms/inter>) under the
**SIL Open Font License 1.1** — see
`apps/desktop/src/shared/motifs/builtin/lower-third/assets/LICENSE`.

## npm and Rust dependencies

Bundled JavaScript/TypeScript dependencies (npm) and statically linked Rust
crates (Cargo) are used under their respective licenses (MIT, Apache-2.0,
BSD, ISC, …) as declared in each package's manifest. The full dependency set
is enumerated by `package-lock.json` and `apps/desktop/native/Cargo.lock` in
the source repository.
