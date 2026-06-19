import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/// True when the OS keyring backs safeStorage. False on Linux without a
/// keyring (headless CI, minimal containers) → key material persists in
/// plaintext. Callers should warn + degrade, never hard-fail.
export function encryptionAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}

const KEYS_FILE = () => path.join(app.getPath('userData'), 'cloud_keys.json')

/// On-disk shape: { "<provider>": "<base64(safeStorage.encryptString)>" }.
type Stored = Record<string, string>

function readStored(): Stored {
  try {
    const raw = fs.readFileSync(KEYS_FILE(), 'utf8')
    const obj = JSON.parse(raw) as Stored
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

function writeStored(s: Stored): void {
  try {
    fs.writeFileSync(KEYS_FILE(), JSON.stringify(s), 'utf8')
  } catch {
    /* best-effort */
  }
}

/// Decrypt every stored key. A blob that fails to decrypt (OS backend rotated,
/// corrupt entry) is dropped from the file and skipped — never throws.
export function loadAllKeys(): Record<string, string> {
  const stored = readStored()
  const out: Record<string, string> = {}
  let mutated = false
  for (const [provider, b64] of Object.entries(stored)) {
    try {
      out[provider] = safeStorage.decryptString(Buffer.from(b64, 'base64'))
    } catch {
      delete stored[provider]
      mutated = true
    }
  }
  if (mutated) writeStored(stored)
  return out
}

/// Encrypt + persist one provider key. Trims; empty key is a no-op clear.
export function setKey(provider: string, key: string): void {
  const trimmed = (key ?? '').trim()
  const stored = readStored()
  if (!trimmed) {
    delete stored[provider]
  } else {
    stored[provider] = safeStorage.encryptString(trimmed).toString('base64')
  }
  writeStored(stored)
}

/// Remove one provider key (idempotent).
export function clearKey(provider: string): void {
  const stored = readStored()
  delete stored[provider]
  writeStored(stored)
}
