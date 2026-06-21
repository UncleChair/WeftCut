const TS_FIELDS = new Set(['created_at', 'modified_at'])
const TS_SENTINEL = '<TS>'

/** Return a structurally-canonical clone: object keys sorted recursively,
 *  arrays left in order (order is semantic for tracks/layers/keyframes),
 *  wall-clock fields normalized. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) {
      out[key] = TS_FIELDS.has(key) && typeof src[key] === 'string' ? TS_SENTINEL : canonicalize(src[key])
    }
    return out
  }
  return value
}

export function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}
