# Licensing

WeftCut's own code — TypeScript, Rust, shaders, docs — is **MIT** (root
[`LICENSE`](../LICENSE)). Packaged installers additionally bundle third-party
binaries with their own licenses; [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)
enumerates them. This doc explains *why* the MIT license holds next to
GPL/LGPL FFmpeg components, and which build gates enforce it.

## The model: two FFmpeg lanes, two license boundaries

FFmpeg enters the product twice, and each lane sits behind a different
license boundary:

| Lane | What ships | License | Boundary that protects MIT |
|---|---|---|---|
| In-process decode | Shared libraries (`libav*`) dynamically linked by `@weftcut/native-decode` | LGPL 2.1+ | The libraries are an **LGPL-only build** — decode needs no GPL component |
| Encode/transcode sidecar | Stock `ffmpeg`/`ffprobe` CLI binaries | GPL v3 | **Process boundary** — subprocess + pipes is mere aggregation; GPL does not propagate across it |

Two rules keep the boundaries honest:

- **The addon split is NOT a license boundary.** A dynamically loaded,
  function-calling addon forms a combined work with its host (FSF plugin
  doctrine). `@weftcut/native-decode` may only ever link LGPL-clean builds;
  moving GPL code in-process would contaminate the app regardless of which
  addon carries it.
- **`@weftcut/core` never links libav.** The only `ffmpeg-next` consumer is
  the decode component crate; everything else talks to FFmpeg over the
  sidecar's CLI/stdio.

## LGPL lane (in-process decode)

Distribution runtime staged by `apps/desktop/scripts/fetch-ffmpeg-lgpl.mjs`:
BtbN `-lgpl-shared` builds on Windows/Linux; macOS builds from the pinned,
SHA-256-verified FFmpeg source tarball (no LGPL-shared mac prebuilt exists).

LGPL §6 obligations and how they're met:

- **Dynamic linking, separate files** — the DLLs/`.so`/`.dylib` ship as
  discrete, user-replaceable files beside the addon (PATH prepend on Windows,
  `$ORIGIN` RUNPATH on Linux, `@loader_path` on macOS).
- **License text** — `resources/native-decode/LICENSE.txt` in the package
  (FFmpeg's `COPYING.LGPLv2.1`).
- **Exact source pointer** — `resources/native-decode/manifest.json` records
  asset, URL, SHA-256, and the full `configuration:` banner.

`assertLgplBanner()` (rejects `--enable-gpl` / `--enable-nonfree`, requires
`--enable-shared`) gates at three points: fetch, addon build
(`napi-build-decode.mjs`), and pack (`after-pack-licensing.mjs`).

Linux additionally bundles libva (MIT) for VA-API copy-back; its notice ships
as `resources/native-decode/LIBVA-LICENSE.txt` and the pack gate asserts it.

## GPL lane (encode/transcode sidecar)

Binaries staged by `apps/desktop/scripts/fetch-ffmpeg.mjs` (gyan.dev on
Windows, BtbN GPL on Linux, martin-riedl.de on macOS) and only ever executed
as subprocesses. The GPL covers **those binaries**, not WeftCut — but
*distributing* them owes GPLv3 compliance for the binaries themselves:

- **License text** — `resources/ffmpeg/LICENSE.txt` in the package (from the
  repo-tracked `apps/desktop/resources/licenses/GPL-3.0.txt`).
- **Provenance** — `resources/ffmpeg/manifest.json` records the version
  string, full `configuration:` banner, and download URL, captured from the
  actual fetched binary.
- **Corresponding source** — `resources/ffmpeg/SOURCE-OFFER.txt` points at
  the exact upstream FFmpeg source and the builder's build scripts, plus a
  fallback offer via the project issue tracker.

`assertSidecarBanner()` rejects `--enable-nonfree` — nonfree builds (e.g.
with fdk-aac compiled in) are non-redistributable under **any** license and
must never ship. GPL flags are expected here: x264/x265 power the proxy and
export lanes.

## Pack-time enforcement

`apps/desktop/scripts/after-pack-licensing.mjs` (electron-builder `afterPack`)
re-reads both packaged manifests and re-asserts both banners plus the presence
of every compliance file **inside the built distributable** — so a runtime
swapped out from under the packager, or a staging regression, fails the build
instead of shipping.

## Supply-chain rules

- Gyan publishes **no LGPL builds** — a dev machine's `Gyan.FFmpeg.Shared`
  (`full_build-shared`) is GPL, dev-only, and must never be the distribution
  decode runtime.
- Any new binary source must pass the banner gates; prefer version-pinned
  URLs with SHA-256 over rolling "latest" endpoints.
- A zero-GPL-binaries edition remains possible later via download-on-first-use
  of the sidecar (Audacity precedent); the LGPL decode lane is unaffected.
