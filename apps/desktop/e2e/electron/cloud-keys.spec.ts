import { test, expect } from '@playwright/test'
import { launchApp } from './helpers/driver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

interface Info { url: string; bearer_token: string }
type Status = { provider: string; label: string; configured: boolean }

async function connect(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'e2e-cloud-keys', version: '0.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

test('safeStorage key round-trip + cloud tools advertised', async () => {
  const { app, page } = await launchApp()

  // `api.backend.invoke` is ONLY for Rust dispatcher commands (incl. the
  // settings_* channels main intercepts before the Rust fall-through). Main-process
  // IPC handlers (`fs:*`, `path:*`, `get_mcp_info`) have their own `api.*` methods —
  // routing them through backend.invoke hits the dispatcher's "unavailable" error.
  const invoke = (cmd: string, args: unknown) =>
    page.evaluate(([c, a]) => (window as any).api.backend.invoke(c, a), [cmd, args] as const)
  const readJson = (path: string) =>
    page.evaluate(async (p) => new TextDecoder().decode(await (window as any).api.fs.readFile(p)), path)

  // Resolve userData path from the main process (no require/import needed here).
  const userData = (await app.evaluate(({ app }) => app.getPath('userData'))) as string

  // Skip when the OS keyring is absent (headless Linux CI) — the round-trip
  // calls safeStorage.encryptString which throws "Encryption is not available".
  const encryptionAvailable = (await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable())) as boolean
  test.skip(!encryptionAvailable, 'safeStorage encryption unavailable (no OS keyring) — round-trip is verified where a keyring exists (Windows/macOS/Linux-desktop)')

  const keysPath = (await page.evaluate(
    ([u]) => (window as any).api.path.join([u, 'cloud_keys.json']),
    [userData],
  )) as string

  // Clean slate.
  await invoke('settings_clear_api_key', { provider: 'openai' })

  // Set a dummy key → status flips to configured + cloud_keys.json holds an entry.
  await invoke('settings_set_api_key', { provider: 'openai', key: 'sk-test-dummy' })
  let status = (await invoke('settings_get_api_key_status', {})) as Status[]
  const openai = status.find((s) => s.provider === 'openai')!
  expect(openai.configured).toBe(true)

  // Read cloud_keys.json via the fs:readFile IPC and confirm the stored value is
  // an encrypted blob (base64), not the plaintext key.
  const stored = JSON.parse(await readJson(keysPath)) as Record<string, string>
  expect(typeof stored.openai).toBe('string')
  expect(stored.openai).not.toContain('sk-test-dummy') // encrypted, not plaintext

  // The cloud MCP tools are now advertised to an external client.
  const info = (await page.evaluate(() => (window as any).api.mcp.getInfo())) as Info
  const client = await connect(info.url, info.bearer_token)
  const names = (await client.listTools()).tools.map((t) => t.name)
  expect(names).toContain('transcribe_clip')
  expect(names).toContain('synthesize_speech')
  await client.close()

  // Clear → status flips back + entry gone.
  await invoke('settings_clear_api_key', { provider: 'openai' })
  status = (await invoke('settings_get_api_key_status', {})) as Status[]
  expect(status.find((s) => s.provider === 'openai')!.configured).toBe(false)
  const exists = (await page.evaluate((p) => (window as any).api.fs.exists(p), keysPath)) as boolean
  if (exists) {
    const after = JSON.parse(await readJson(keysPath)) as Record<string, string>
    expect(after.openai).toBeUndefined()
  }
  // If the file doesn't exist at all after clear, the entry is definitely gone.

  await app.close()
})
