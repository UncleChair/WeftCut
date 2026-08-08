import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import {
  commandRegistryVersion,
  getCommand,
  subscribeCommandRegistry,
} from "../commands/registry";
import { Menu, MenuItem, MenuSeparator } from "./Menu";
import type { MenuSection, MenuSpecEntry } from "./menuSpec";

/// One dropdown rendered from its `menuSpec` section: every entry is looked
/// up in the command registry, so label, handler, enabled/checked state and
/// the accelerator hint all come from the same catalog the palette reads.
///
/// The registry subscription matters on the first frame: App's provider
/// registers in a post-paint effect, so this renders once against an empty
/// registry and again when the catalog arrives.
export function CommandMenu({ section }: { section: MenuSection }) {
  const { t } = useTranslation();
  useSyncExternalStore(subscribeCommandRegistry, commandRegistryVersion);
  return (
    <Menu label={t(section.titleKey)}>
      {section.entries.map((entry, i) =>
        entry === "---" ? (
          // Position-keyed: separators have no identity of their own, and the
          // spec is static, so the index is stable.
          <MenuSeparator key={`sep-${i}`} />
        ) : (
          <CommandMenuItem
            key={typeof entry === "string" ? entry : entry.id}
            entry={entry}
          />
        ),
      )}
    </Menu>
  );
}

function CommandMenuItem({ entry }: { entry: Exclude<MenuSpecEntry, "---"> }) {
  const { t } = useTranslation();
  const id = typeof entry === "string" ? entry : entry.id;
  const hintKey = typeof entry === "string" ? undefined : entry.hintKey;
  const cmd = getCommand(id);
  // Not registered (first frame, or a provider unmounted): omit the row
  // rather than render a dead label — same policy as the native menu's
  // absent-id projection (shared/menu.ts).
  if (!cmd) return null;
  // enabled/checked are evaluated here, in the item's own render, not where
  // the spec entry was mapped: Base UI mounts the popup on open, so every
  // open re-reads the predicates, and an App re-render while the menu is
  // open refreshes them again — the same freshness the prop-driven markup
  // had.
  return (
    <MenuItem
      label={t(cmd.labelKey)}
      onSelect={cmd.run}
      disabled={cmd.enabled ? !cmd.enabled() : false}
      {...(cmd.checked ? { checked: cmd.checked() } : {})}
      {...(cmd.actionId ? { actionId: cmd.actionId } : {})}
      {...(hintKey ? { hint: t(hintKey) } : {})}
    />
  );
}
