// electron-builder afterPack hook: re-assert LGPL-cleanliness of the packaged
// @weftcut/native-decode ffmpeg runtime from the manifest that shipped with the
// app, closing the LGPL §6 "GPL builds can never ship by accident" gate at
// package time (docs/adr/0030; issue #5 §Packaging).
//
// The fetch/build steps already gate the banner (fetch-ffmpeg-lgpl.mjs +
// napi-build-decode.mjs), but that is at supply time. This runs at pack time,
// against the manifest.json actually copied into the distributable, so a
// runtime swapped out from under the packager still cannot slip a GPL/nonfree
// build into a shipped artifact.
//
// The shared objects themselves ride co-located beside the .node in
// app.asar.unpacked/ (electron-builder.yml files + asarUnpack); only the
// license text + manifest land in resources/native-decode/ (extraResources),
// which is the platform-uniform path this hook reads via getResourcesDir().
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertLgplBanner } from './fetch-ffmpeg-lgpl.mjs'

// Platforms that ship the co-located/PATH-loaded LGPL ffmpeg runtime for the
// native-decode component.
const LGPL_PLATFORMS = new Set(['darwin', 'linux', 'win32'])

export default function afterPack(context) {
  const platform = context.electronPlatformName
  if (!LGPL_PLATFORMS.has(platform)) {
    console.log(`  • afterPack(lgpl): ${platform} ships no native-decode LGPL runtime; skipping re-check.`)
    return
  }

  // extraResources lands the manifest at <resources>/native-decode/manifest.json
  // on every OS; getResourcesDir handles the per-OS layout (macOS nests it
  // under <App>.app/Contents/Resources).
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
  const manifestPath = join(resourcesDir, 'native-decode', 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `afterPack(lgpl): packaged manifest missing at ${manifestPath} — the ` +
        'native-decode LGPL runtime was not carried into the package (files/' +
        'extraResources regression). Refusing to ship an unverifiable runtime.',
    )
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // Throws on --enable-gpl / --enable-nonfree / non-shared — a GPL build never ships.
  assertLgplBanner(manifest.configuration)
  console.log(
    `  • afterPack(lgpl): ${platform} native-decode runtime banner clean ` +
      `(${manifest.asset}); §6 gate held.`,
  )

  // Linux also bundles libva (>= 2.21) beside the addon for VAAPI copy-back
  // (issue #5 Block C). It's MIT (Expat) — no LGPL §6 obligation — but assert
  // both that the manifest records the bundle and that its notice shipped, so a
  // regression that silently drops the VAAPI runtime is caught before release.
  if (platform === 'linux') {
    if (!manifest.libva) {
      throw new Error(
        'afterPack(lgpl): manifest records no bundled libva — the VAAPI ' +
          'copy-back runtime was not carried (fetch-ffmpeg-lgpl regression).',
      )
    }
    const libvaNotice = join(resourcesDir, 'native-decode', 'LIBVA-LICENSE.txt')
    if (!existsSync(libvaNotice)) {
      throw new Error(
        `afterPack(lgpl): bundled libva notice missing at ${libvaNotice} — MIT ` +
          'attribution not carried (extraResources regression).',
      )
    }
    console.log(
      `  • afterPack(lgpl): linux bundled libva ${manifest.libva.version} present; MIT notice shipped.`,
    )
  }
}
