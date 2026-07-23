// electron-builder afterPack hook: re-assert the licensing compliance of BOTH
// packaged ffmpeg lanes (docs/licensing.md) from the manifests that shipped
// with the app, so a regression in fetching/staging can never produce a
// distributable that violates its own third-party licenses.
//
//   1. LGPL lane — @weftcut/native-decode's in-process ffmpeg runtime: banner
//      must be LGPL-clean (no --enable-gpl/--enable-nonfree, shared build),
//      closing the LGPL §6 "GPL builds can never ship by accident" gate at
//      package time (docs/adr/0030; issue #5 §Packaging).
//   2. GPL sidecar lane — the bundled ffmpeg/ffprobe CLI binaries: banner must
//      be redistributable (no --enable-nonfree) and the GPLv3 compliance
//      materials (LICENSE.txt + SOURCE-OFFER.txt + manifest.json) must have
//      been carried into resources/ffmpeg/.
//
// The fetch/build steps already gate the banners (fetch-ffmpeg.mjs,
// fetch-ffmpeg-lgpl.mjs, napi-build-decode.mjs), but that is at supply time.
// This runs at pack time, against the files actually copied into the
// distributable, so a runtime swapped out from under the packager still cannot
// slip a non-compliant build into a shipped artifact.
//
// The LGPL shared objects themselves ride co-located beside the .node in
// app.asar.unpacked/ (electron-builder.yml files + asarUnpack); only the
// license text + manifest land in resources/native-decode/ (extraResources),
// which is the platform-uniform path this hook reads via getResourcesDir().
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertLgplBanner } from './fetch-ffmpeg-lgpl.mjs'
import { assertSidecarBanner } from './fetch-ffmpeg.mjs'

// Platforms that ship the co-located/PATH-loaded LGPL ffmpeg runtime for the
// native-decode component.
const LGPL_PLATFORMS = new Set(['darwin', 'linux', 'win32'])

/** LGPL lane: the native-decode runtime's §6 gate. */
function checkNativeDecodeLgpl(context, resourcesDir) {
  const platform = context.electronPlatformName
  if (!LGPL_PLATFORMS.has(platform)) {
    console.log(`  • afterPack(licensing): ${platform} ships no native-decode LGPL runtime; skipping re-check.`)
    return
  }

  // extraResources lands the manifest at <resources>/native-decode/manifest.json
  // on every OS.
  const manifestPath = join(resourcesDir, 'native-decode', 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `afterPack(licensing): packaged manifest missing at ${manifestPath} — the ` +
        'native-decode LGPL runtime was not carried into the package (files/' +
        'extraResources regression). Refusing to ship an unverifiable runtime.',
    )
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // Throws on --enable-gpl / --enable-nonfree / non-shared — a GPL build never ships.
  assertLgplBanner(manifest.configuration)
  console.log(
    `  • afterPack(licensing): ${platform} native-decode runtime banner clean ` +
      `(${manifest.asset}); §6 gate held.`,
  )

  // Linux also bundles libva (>= 2.21) beside the addon for VAAPI copy-back
  // (issue #5 Block C). It's MIT (Expat) — no LGPL §6 obligation — but assert
  // both that the manifest records the bundle and that its notice shipped, so a
  // regression that silently drops the VAAPI runtime is caught before release.
  if (platform === 'linux') {
    if (!manifest.libva) {
      throw new Error(
        'afterPack(licensing): manifest records no bundled libva — the VAAPI ' +
          'copy-back runtime was not carried (fetch-ffmpeg-lgpl regression).',
      )
    }
    const libvaNotice = join(resourcesDir, 'native-decode', 'LIBVA-LICENSE.txt')
    if (!existsSync(libvaNotice)) {
      throw new Error(
        `afterPack(licensing): bundled libva notice missing at ${libvaNotice} — MIT ` +
          'attribution not carried (extraResources regression).',
      )
    }
    console.log(
      `  • afterPack(licensing): linux bundled libva ${manifest.libva.version} present; MIT notice shipped.`,
    )
  }
}

/** GPL sidecar lane: the bundled ffmpeg/ffprobe CLI binaries' GPLv3 materials. */
function checkSidecarGpl(context, resourcesDir) {
  const platform = context.electronPlatformName
  const dir = join(resourcesDir, 'ffmpeg')

  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `afterPack(licensing): sidecar manifest missing at ${manifestPath} — ` +
        'fetch-ffmpeg.mjs did not stage compliance materials (or extraResources ' +
        'regressed). Refusing to ship GPL binaries without provenance.',
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // Throws on --enable-nonfree — a non-redistributable build never ships.
  assertSidecarBanner(manifest.configuration)

  for (const file of ['LICENSE.txt', 'SOURCE-OFFER.txt']) {
    if (!existsSync(join(dir, file))) {
      throw new Error(
        `afterPack(licensing): sidecar ${file} missing in ${dir} — GPLv3 ` +
          'compliance materials not carried (extraResources regression).',
      )
    }
  }
  console.log(
    `  • afterPack(licensing): ${platform} ffmpeg sidecar banner redistributable ` +
      `(${manifest.version?.slice(0, 60) ?? 'unknown version'}); GPLv3 text + source offer shipped.`,
  )
}

export default function afterPack(context) {
  // extraResources land under <resources>/ on every OS; getResourcesDir handles
  // the per-OS layout (macOS nests it under <App>.app/Contents/Resources).
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
  checkNativeDecodeLgpl(context, resourcesDir)
  checkSidecarGpl(context, resourcesDir)
}
