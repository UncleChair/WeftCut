// The menu bar's structure book: which commands appear in which dropdown, in
// what order, with which separators. Everything else about an item — label,
// handler, enabled/checked state, shortcut hint — is looked up in the command
// registry at render time (`CommandMenu.tsx`), so this file and `ACTION_DEFS`
// cannot drift: adding a menu command means one entry in the registry's
// catalog and one id here.
//
// Structure stays a static tree rather than placement metadata on each
// CommandDef because menu order is an editorial decision, not command state —
// the same judgement `shared/menu.ts` makes when it gives main the native
// menu's structure but not its labels.
//
// Ids are type-locked to the union of catalogued actions and menu-only
// commands; a typo or a removed command fails `tsc`, not the user.

import type { ActionId } from "../shortcuts/defs";
import type { MenuOnlyCommandId } from "../commands/appCommands";

export type MenuCommandId = ActionId | MenuOnlyCommandId;

export type MenuSpecEntry =
  | MenuCommandId
  /// Object form for items carrying a tooltip — a menu-presentation detail,
  /// so it lives here rather than on CommandDef.
  | { id: MenuCommandId; hintKey: string }
  | "---";

export interface MenuSection {
  titleKey: string;
  entries: readonly MenuSpecEntry[];
}

export const FILE_MENU: MenuSection = {
  titleKey: "menu.file",
  entries: [
    "importMedia",
    "---",
    "save",
    "saveAs",
    { id: "closeProject", hintKey: "actions.save_and_close_hint" },
    "---",
    "export",
    "---",
    // Stays here on every platform for cross-platform consistency, even though
    // macOS ALSO projects it into the App menu under Cmd+, — the two dispatch
    // the same action (ADR 0031).
    { id: "openSettings", hintKey: "actions.settings_hint" },
  ],
};

export const EDIT_MENU: MenuSection = {
  titleKey: "menu.edit",
  entries: [
    "undo",
    "redo",
    "---",
    // Modal tools: checkmarks make the armed tool visible here too, so blade
    // mode isn't discoverable only by the timeline cursor. Selection is always
    // available; the Blade needs a layer to cut.
    "selectTool",
    "toggleBladeMode",
  ],
};

export const INSERT_MENU: MenuSection = {
  titleKey: "menu.insert",
  entries: [
    "addColorLayer",
    "addTextLayer",
    { id: "openMotifPicker", hintKey: "actions.motifs_hint" },
  ],
};

/// Every spec-driven section, for tests that sweep the whole book. The bar
/// itself places these explicitly in `AppMenuBar` — the bespoke menus (View,
/// Help, Dev) interleave between them.
export const MENU_SPEC: readonly MenuSection[] = [
  FILE_MENU,
  EDIT_MENU,
  INSERT_MENU,
];
