// Keybinding types shared by the Electron main process (owner of persistence)
// and the renderer (consumer via ipc). One definition → no main↔renderer drift.
// Mirrors the on-disk JSON shape's overrides map exactly.
//
// On-disk shape (keybindings.json):
//   { "overrides": { "<action-id>": ["Mod+Z", "F3"], ... } }

/** Map of action id → list of binding strings. An empty array means the action
 *  is explicitly unbound — distinct from "no entry for this action", which
 *  inherits the frontend default at dispatch time. */
export type KeybindingsMap = Record<string, string[]>;
