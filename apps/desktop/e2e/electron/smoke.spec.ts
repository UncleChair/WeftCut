import { test, expect } from '@playwright/test'
import { invokeCmd, launchApp } from './helpers/driver'

interface SmokeSummary {
  track_count: number
  tracks: Array<{ id: string; label: string | null }>
}

/// `rename_track` rather than `add_track`: the point of this test is that a
/// state-mutating command round-trips through the bridge, and it should be a
/// command a human can also reach — `add_track` has no human entry point at all
/// now that tracks are a by-product of placement (ADR 0042), so a smoke test
/// built on it would keep passing while every route a user actually has is
/// broken. Renaming is reachable by double-clicking a track header, and its
/// null-clearing half round-trips the derived-name model in the same gesture.
test('boots, creates a project, rename_track round-trips through the bridge', async () => {
  // Launch the built app through the shared driver (isolated throwaway
  // userData; launchApp awaits firstWindow + domcontentloaded).
  const { app, page } = await launchApp()

  // The blank project boots with the reserved A/B-roll skeleton; read the count
  // rather than hardcoding it, so changing the skeleton does not fail here.
  const summary0 = await invokeCmd<SmokeSummary>(page, 'project_summary')
  expect(typeof summary0.track_count).toBe('number')
  expect(summary0.track_count).toBeGreaterThan(0)
  const target = summary0.tracks[0]!
  // A reserved lane stores no label — its name derives from `role`.
  expect(target.label).toBeNull()

  await invokeCmd(page, 'rename_track', { trackId: target.id, label: 'Smoke' })
  const summary1 = await invokeCmd<SmokeSummary>(page, 'project_summary')
  expect(summary1.tracks.find((t) => t.id === target.id)!.label).toBe('Smoke')
  expect(summary1.track_count).toBe(summary0.track_count)

  // Clearing writes null, which is what hands the lane back to its derived name.
  await invokeCmd(page, 'rename_track', { trackId: target.id, label: null })
  const summary2 = await invokeCmd<SmokeSummary>(page, 'project_summary')
  expect(summary2.tracks.find((t) => t.id === target.id)!.label).toBeNull()

  await app.close()
})
