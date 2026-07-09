import { useTranslation } from "react-i18next";

import { Menu, MenuHeading, MenuItem, MenuSeparator } from "../menu/Menu";
import {
  useDisplayMode,
  useMediaPoolDrawerOpen,
  toggleDisplayMode,
  setMediaPoolDrawerOpen,
} from "../settings/appSettingsStore";

/// `docs/data-model.md` R.8: View menu — radio between A/B-roll and
/// Show-All. Same setting the inline pill + `T` shortcut drive. Reads
/// the current value from the app-pref store so the checkmark stays in
/// sync regardless of how it changed.
export function ViewMenu() {
  const { t } = useTranslation();
  const mode = useDisplayMode();
  const isDrawerOpen = useMediaPoolDrawerOpen();
  return (
    <Menu label={t("menu.view", { defaultValue: "View" })}>
      <MenuHeading
        label={t("view.display_mode_heading", {
          defaultValue: "Track display",
        })}
      />
      <MenuItem
        actionId="toggleDisplayMode"
        label={t("view.display_ab", {
          defaultValue: "Display: A/B Roll only",
        })}
        checked={mode === "AbRoll"}
        onSelect={() => {
          if (mode !== "AbRoll") void toggleDisplayMode();
        }}
      />
      <MenuItem
        label={t("view.display_all", {
          defaultValue: "Display: Show all tracks",
        })}
        checked={mode === "ShowAll"}
        onSelect={() => {
          if (mode !== "ShowAll") void toggleDisplayMode();
        }}
      />
      <MenuSeparator />
      <MenuItem
        actionId="toggleMediaPool"
        label={
          isDrawerOpen
            ? t("view.close_media_pool", {
                defaultValue: "Close Media Pool drawer",
              })
            : t("view.open_media_pool", {
                defaultValue: "Open Media Pool drawer",
              })
        }
        onSelect={() => {
          void setMediaPoolDrawerOpen(!isDrawerOpen);
        }}
      />
    </Menu>
  );
}
