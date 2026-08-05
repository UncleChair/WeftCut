// Public surface for the shortcuts module. The dispatcher lives in
// `useShortcuts.ts`; the binding-string DSL is in `match.ts`; the
// static action catalogue is in `defs.ts`.
//
// Consumers:
// - `App.tsx` calls `useShortcuts({...})` once, passing handlers for
//   every `ActionId` listed in `ACTION_DEFS`.
// - `Menu.tsx`'s `<MenuItem actionId="...">` reads `ACTION_DEFS[id]`
//   and `resolveAccelerator()` to render the accelerator hint.
// - `SettingsPanel.tsx`'s Keyboard section uses `eventToBinding`,
//   `resolveAccelerator`, `bindingsEqual` to drive the capture chip
//   and conflict detection. Writes round-trip through the backend
//   `keybindings_*` IPC commands.

export type { ActionId, ActionDef } from "./defs";
export { ACTION_DEFS, ACTION_IDS } from "./defs";
export type { ParsedBinding } from "./match";
export {
  bindingsEqual,
  eventToBinding,
  isChord,
  isEditableTarget,
  isInTransientWidget,
  matchEvent,
  parseBinding,
  resolveAccelerator,
} from "./match";
export type { Handler, HandlerMap, OverrideMap } from "./useShortcuts";
export { useShortcuts } from "./useShortcuts";
export {
  ShortcutBindingsProvider,
  useEffectiveBindings,
} from "./bindings-context";
