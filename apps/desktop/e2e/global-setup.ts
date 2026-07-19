import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureFixtures } from './fixtures/generate-fixtures.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/// Generate any missing fixture media before the suite boots. ensureFixtures
/// skips files that already exist (fast no-op on a warm checkout) and throws
/// if a generation fails (e.g. ffmpeg missing) — failing the run loudly here
/// instead of the old per-spec silent skips. WEFTCUT_TEST_MEDIA redirects the
/// media dir, same as the specs' own fallback.
export default async function globalSetup(): Promise<void> {
  const mediaDir = process.env.WEFTCUT_TEST_MEDIA || path.resolve(__dirname, 'fixtures', 'media')
  await ensureFixtures(mediaDir)
}
