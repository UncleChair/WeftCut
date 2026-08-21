import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureFixtures } from './fixtures/generate-fixtures.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/// Bring the fixture media up to date with its recipes before the suite boots.
/// ensureFixtures compares each entry against its recorded recipe hash, so a
/// warm checkout is a sub-second no-op and an edited recipe regenerates only
/// what moved; a failed generation (ffmpeg missing, say) throws and fails the
/// run loudly here. electron-ci runs the same pass as its own cached step —
/// this stays the backstop that keeps a local run, a scoped dispatch and the
/// unsplit slice needing no special case.
/// WEFTCUT_TEST_MEDIA redirects the media dir, same as the specs' own fallback.
export default async function globalSetup(): Promise<void> {
  const mediaDir = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, 'fixtures', 'media')
  await ensureFixtures(mediaDir)
}
