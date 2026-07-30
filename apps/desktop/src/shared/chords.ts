// The chord notation's modifier vocabulary — "Mod+Shift+S", "Alt+ArrowLeft".
//
// One home, because three places translate the same spellings into three
// different targets and a token added to only one of them fails silently:
//   • src/renderer/shortcuts/match.ts — `parseBinding` into KeyboardEvent flags,
//     `resolveAccelerator` into a display label;
//   • src/main/appMenu.ts — `toElectronAccelerator` into an Electron accelerator
//     (a spelling it doesn't know yields NO accelerator on the native item).
//
// `mod` stays canonical rather than resolving to ctrl/meta here: which one it
// means is a per-platform question, and Electron has its own token for it
// (`CommandOrControl`) that must not be pre-resolved.

/// Accepted spellings (lower-cased) → the canonical modifier they name.
export const CHORD_MODIFIERS = {
  mod: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  meta: 'meta',
  command: 'meta',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
} as const

export type ChordModifier = (typeof CHORD_MODIFIERS)[keyof typeof CHORD_MODIFIERS]

/// The canonical modifier a token names, or undefined if the token is not a
/// modifier at all. Case-insensitive, like the notation.
export function chordModifier(token: string): ChordModifier | undefined {
  return CHORD_MODIFIERS[token.toLowerCase() as keyof typeof CHORD_MODIFIERS]
}
