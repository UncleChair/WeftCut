import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { AppDialog } from "../components/AppDialog";
import { Button } from "@/components/ui/button";
import type { AppVersions } from "../../shared/ipc";
import {
  LICENSE_URL,
  openExternal,
  REPO_URL,
  THIRD_PARTY_NOTICES_URL,
} from "./links";

interface AboutDialogProps {
  onClose: () => void;
}

/// The Help → About box: brand, version identity (pulled from the main
/// process — the renderer bundle has no package.json access), author/license
/// lines, and the repo link. The copy button hands bug reports a ready-made
/// environment line (app / Electron / Chrome / platform). Skin reuses the
/// legacy settings-panel chrome; layout classes live in misc.css.
export function AboutDialog({ onClose }: AboutDialogProps) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<AppVersions | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    window.api.app
      .versions()
      .then((next) => {
        if (alive) setVersions(next);
      })
      .catch(() => {
        // Version identity is informational; never block the dialog on it.
      });
    return () => {
      alive = false;
    };
  }, []);

  // "Copied" feedback reverts after a beat so the button is reusable.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyVersionInfo = () => {
    const info = versions
      ? `WeftCut ${versions.app} | Electron ${versions.electron} | Chrome ${versions.chrome} | ${versions.platform} ${versions.arch}`
      : "WeftCut";
    void navigator.clipboard
      .writeText(info)
      .then(() => setCopied(true))
      .catch(() => {
        // Clipboard can be unavailable (permissions); the copy is a courtesy.
      });
  };

  return (
    <AppDialog
      title={t("help.about")}
      onClose={onClose}
      closeLabel={t("help.close")}
      panelClassName="settings-panel"
    >
      <div className="settings-body">
        <div className="about-dialog">
          {/* Three tiers: brand hero → info band → action. */}
          <div className="about-hero">
            <img
              className="about-logo"
              src="./icons/icon.svg"
              alt=""
              aria-hidden
              width={56}
              height={56}
            />
            <p className="about-name">{t("app.title")}</p>
            <p className="about-version">
              {t("help.version", { version: versions?.app ?? "…" })}
            </p>
          </div>
          <div className="about-info">
            <p className="about-meta">{t("help.developed_by")}</p>
            {/* License + notices lines carry inline links; Trans swaps the
                <mit>/<notices> tags in the locale strings for link buttons. */}
            <p className="about-meta">
              <Trans
                i18nKey="help.license_mit"
                components={{
                  mit: (
                    <button
                      type="button"
                      className="about-link"
                      onClick={() => openExternal(LICENSE_URL)}
                    />
                  ),
                }}
              />
            </p>
            <p className="about-meta">
              <Trans
                i18nKey="help.third_party"
                components={{
                  notices: (
                    <button
                      type="button"
                      className="about-link"
                      onClick={() => openExternal(THIRD_PARTY_NOTICES_URL)}
                    />
                  ),
                }}
              />
            </p>
            <button
              type="button"
              className="about-link"
              onClick={() => openExternal(REPO_URL)}
            >
              {t("help.project_link")}
            </button>
          </div>
          <div className="about-actions">
            <Button variant="secondary" onClick={copyVersionInfo}>
              {copied ? t("help.copied") : t("help.copy_version")}
            </Button>
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
