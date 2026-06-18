import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const AUTH_FILE = () => path.join(app.getPath('userData'), 'mcp_auth.json')

export interface McpAuth {
  token: string
  port: number
}

export function loadOrInitAuth(): McpAuth {
  try {
    const raw = fs.readFileSync(AUTH_FILE(), 'utf8')
    const a = JSON.parse(raw) as McpAuth
    if (a.token && typeof a.port === 'number') return a
  } catch {
    /* fall through to fresh */
  }
  return { token: randomBytes(32).toString('hex'), port: 0 } // 0 → OS-pick at listen
}

export function saveAuth(a: McpAuth): void {
  try {
    fs.writeFileSync(AUTH_FILE(), JSON.stringify(a), 'utf8')
  } catch {
    /* best-effort */
  }
}

export function rotateToken(a: McpAuth): McpAuth {
  const next = { ...a, token: randomBytes(32).toString('hex') }
  saveAuth(next)
  return next
}
