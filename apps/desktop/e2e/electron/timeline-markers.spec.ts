import { expect, test, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { invokeCmd, launchApp, newProject, tmpDir } from './helpers/driver'

/**
 * Markers painted on the timeline ruler, and the one switch that silences them.
 *
 * Everything here is unreachable from the colocated Vitest suites, which mock the
 * IPC surface and render the ruler in isolation: the assertions below are about
 * the REAL wiring — a marker created OUTSIDE the renderer reaching the ruler's
 * own store selector, and one app-level setting reaching the strip button, the
 * View menu checkbox and the marker layer at once.
 *
 * Markers are seeded over MCP because that is the only way they can be created
 * today — there is no human authoring path (that is the next slice) and no
 * renderer channel for `add_marker` either, so this is the read path's real
 * upstream, not a test-only shortcut. The connection details come from the same
 * `get_mcp_info` IPC the Settings → Agent tab reads, so this can boot through
 * `launchApp` like every other UI spec instead of parsing the connect log.
 *
 * Cross-restart persistence is deliberately NOT here — it is asserted in the
 * main-process app-settings suite, because every spec in this suite boots
 * Electron.
 */

const CANVAS = { width: 640, height: 360, fpsNum: 30, fpsDen: 1 }

/// An MCP client on this app's own loopback server, as an agent would connect.
async function mcpClient(page: Page): Promise<Client> {
  const info = await page.evaluate(
    () =>
      (window as any).api.mcp.getInfo() as Promise<{
        url: string
        bearer_token: string
      } | null>,
  )
  if (!info) throw new Error('MCP server not up')
  const transport = new StreamableHTTPClientTransport(new URL(info.url), {
    requestInit: { headers: { Authorization: `Bearer ${info.bearer_token}` } },
  })
  const client = new Client({ name: 'e2e-timeline-markers', version: '0.0.0' })
  await client.connect(transport)
  return client
}

test('the ruler paints markers, and one toggle silences them from either surface', async () => {
  test.setTimeout(120_000)
  const { app, page } = await launchApp()
  try {
    const parent = tmpDir('weftcut-markers-')
    await newProject(page, { parentFolder: parent, name: 'timeline-markers', canvas: CANVAS })
    // REQUIRED before any pointer gesture: the splash overlay outlives the
    // first dock render and swallows mousedown while the target is visible.
    await expect(page.locator('.splash-screen')).toHaveCount(0, { timeout: 15_000 })

    const marks = page.locator('[data-testid="timeline-marker"]')
    const markerLayer = page.locator('[data-testid="timeline-marker-layer"]')
    const stripButton = page.locator('button[data-quick-action="toggleMarkersVisible"]')
    const viewMenu = page.locator('.menu-trigger').nth(2)
    const showMarkersItem = page
      .locator('.app-menu-item')
      .filter({ hasText: /^Show markers$/ })

    // ── Seed a point and a region, from outside the app ───────────────────
    await expect(marks).toHaveCount(0)
    // Frame-grid times at 30 fps (ADR 0037 rejects an off-grid marker). Two
    // different authored colours, because the colour IS the content here — a
    // taxonomy an agent applied is the thing the ruler has to make legible.
    const client = await mcpClient(page)
    try {
      await client.callTool({
        name: 'add_marker',
        arguments: {
          t_us: 1_000_000,
          label: 'cut here',
          color: { r: 255, g: 136, b: 0, a: 255 },
        },
      })
      await client.callTool({
        name: 'add_marker',
        arguments: {
          t_us: 2_000_000,
          end_t_us: 3_000_000,
          label: 'needs VO',
          color: { r: 34, g: 204, b: 85, a: 255 },
        },
      })
    } finally {
      await client.close()
    }

    // Both appear with no project reload and no user action: the ruler reads the
    // markers through a store selector, so an agent's `add_marker` lands the
    // moment it commits — the whole point of the slice.
    await expect(marks).toHaveCount(2)
    await expect(
      page.locator('[data-testid="timeline-marker"][data-shape="point"]'),
    ).toHaveCount(1)
    const regionMark = page.locator('[data-testid="timeline-marker"][data-shape="region"]')
    await expect(regionMark).toHaveCount(1)
    // Each in the colour its author gave it, not a semantic marker colour.
    await expect(regionMark).toHaveCSS('background-color', 'rgb(34, 204, 85)')
    // Hover text is this slice's only human-readable output, and a region's
    // carries both ends.
    await expect(regionMark).toHaveAttribute(
      'title',
      'needs VO · 00:00:02:00 – 00:00:03:00',
    )

    // ── Hide from the strip ───────────────────────────────────────────────
    await expect(stripButton).toHaveAttribute('aria-pressed', 'true')
    await stripButton.click()
    // Not "hidden" — GONE, wrapper included (see the landmine on the layer).
    await expect(marks).toHaveCount(0)
    await expect(markerLayer).toHaveCount(0)
    await expect(stripButton).toHaveAttribute('aria-pressed', 'false')
    await expect(stripButton).toHaveAttribute(
      'aria-label',
      'Timeline markers hidden. Click to show.',
    )
    // A canvas-noise control and nothing more: the markers are still project
    // content, so the search palette can still find and navigate to them.
    const state = await invokeCmd<{ markers: unknown[] }>(page, 'project_summary', {})
    expect(state.markers).toHaveLength(2)

    // ── Show again from the strip ─────────────────────────────────────────
    await stripButton.click()
    await expect(marks).toHaveCount(2)
    await expect(stripButton).toHaveAttribute('aria-pressed', 'true')

    // ── …and from the View menu, which is the same one setting ────────────
    await viewMenu.click()
    await expect(showMarkersItem).toHaveCount(1)
    await showMarkersItem.click()
    await expect(marks).toHaveCount(0)
    // The proof that it is ONE setting and not two: flipping it in the menu
    // un-presses the strip button.
    await expect(stripButton).toHaveAttribute('aria-pressed', 'false')

    await viewMenu.click()
    await showMarkersItem.click()
    await expect(marks).toHaveCount(2)
    await expect(stripButton).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await app.close()
  }
})
