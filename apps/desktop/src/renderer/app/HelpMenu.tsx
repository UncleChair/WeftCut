import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Menu, MenuItem, MenuSeparator } from "../menu/Menu";
import { AboutDialog } from "./AboutDialog";
import { ISSUES_URL, openExternal, RELEASES_URL } from "./links";

/// The Help menu — update check + issue reporting (both external links until
/// a real updater exists; `electron-updater` is a consumer-ready milestone
/// item, not a v1 one) and the About box. Self-contained:
/// the About dialog state lives here, so AppMenuBar stays prop-driven chrome.
export function HelpMenu() {
  const { t } = useTranslation();
  const [aboutOpen, setAboutOpen] = useState(false);
  return (
    <>
      <Menu label={t("menu.help")}>
        <MenuItem
          label={t("help.check_updates")}
          onSelect={() => openExternal(RELEASES_URL)}
        />
        <MenuItem
          label={t("help.report_issue")}
          onSelect={() => openExternal(ISSUES_URL)}
        />
        <MenuSeparator />
        <MenuItem
          label={t("help.about")}
          onSelect={() => setAboutOpen(true)}
        />
      </Menu>
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </>
  );
}
