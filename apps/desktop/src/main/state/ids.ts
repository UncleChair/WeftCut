/** A source of opaque, unique entity ids. Injected so the differential
 *  harness can replace it with a deterministic sequence. */
export type IdGen = () => string

function hyphenate32(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Deterministic generator: id #n = Uuid::from_u128(n). Byte-identical to the
 *  Rust replay driver's deterministic mode (native/src/state/ids.rs).
 *
 *  `start` is the FIRST value yielded (default 1). The no-arg form is the
 *  Rust-parity entry point: it matches the Rust `det` counter, which always
 *  counts from 1. The Rust side has NO custom-start path — `seededGen(0)`
 *  would yield the nil UUID first and diverge from Rust. Only use a custom
 *  `start` for TS-local sequences, never to mirror a Rust id stream. */
export function seededGen(start?: number): IdGen {
  let n = start !== undefined ? start - 1 : 0
  return () => {
    n += 1
    return hyphenate32(n.toString(16).padStart(32, '0'))
  }
}

/** Production generator: UUIDv7 (time-ordered). ~15 lines, no dependency. */
export function uuidV7Gen(): IdGen {
  return () => {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    const ms = Date.now()
    // 48-bit big-endian millisecond timestamp
    bytes[0] = (ms / 2 ** 40) & 0xff
    bytes[1] = (ms / 2 ** 32) & 0xff
    bytes[2] = (ms / 2 ** 24) & 0xff
    bytes[3] = (ms / 2 ** 16) & 0xff
    bytes[4] = (ms / 2 ** 8) & 0xff
    bytes[5] = ms & 0xff
    bytes[6] = (bytes[6] & 0x0f) | 0x70 // version 7
    bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return hyphenate32(hex)
  }
}
