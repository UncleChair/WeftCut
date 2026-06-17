import { protocol } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'

// The real built-in lower-third, served as motif://lower-third/<path>.
// NOTE: this file is bundled into `main.cjs` at the poc root, so at runtime
// `__dirname` is the poc root (apps/desktop/poc/electron-napi) — hence `../../`
// reaches apps/desktop/src-tauri (NOT `../../../`).
const LOWER_THIRD_DIR = path.resolve(
  __dirname,
  '../../src-tauri/src/motifs/catalog/lower-third',
)

// Fail loudly if the path is wrong, instead of serving 404s that read as a
// blank capture.
if (!fs.existsSync(path.join(LOWER_THIRD_DIR, 'index.html'))) {
  throw new Error(`lower-third not found at ${LOWER_THIRD_DIR} (check the relative path / cwd)`)
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  }
  return map[ext] || 'application/octet-stream'
}

export function registerMotifSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'motif', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

export function registerMotifProtocol(): void {
  protocol.handle('motif', (request) => {
    const url = new URL(request.url) // motif://lower-third/index.html
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const abs = path.join(LOWER_THIRD_DIR, rel || 'index.html')
    // path-safety: stay within the motif dir
    if (!abs.startsWith(LOWER_THIRD_DIR)) {
      return new Response('forbidden', { status: 403 })
    }
    try {
      const data = fs.readFileSync(abs)
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': mimeFor(abs) },
      })
    } catch {
      return new Response('not found: ' + rel, { status: 404 })
    }
  })
}
