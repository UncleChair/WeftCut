import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { Button } from "@/components/ui/button";

export type WorkspaceNameMode = "save-as" | "rename";

/// Name prompt for Save Workspace As (create a custom profile from the current
/// arrangement) and Rename Workspace. App owns the open/close state; this dialog
/// only collects a trimmed non-empty name and hands it back on confirm.
interface WorkspaceNameDialogProps {
  mode: WorkspaceNameMode;
  initialName: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export function WorkspaceNameDialog({
  mode,
  initialName,
  onSubmit,
  onCancel,
}: WorkspaceNameDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const trimmed = name.trim();
  const canConfirm = trimmed !== "";
  const submit = () => {
    if (canConfirm) onSubmit(trimmed);
  };
  const title =
    mode === "rename"
      ? t("workspace_name.rename_title", { defaultValue: "Rename Workspace" })
      : t("workspace_name.save_as_title", { defaultValue: "Save Workspace As" });
  return (
    <AppDialog
      title={title}
      onClose={onCancel}
      closeLabel={t("workspace_name.cancel", { defaultValue: "Cancel" })}
      panelClassName="new-project-panel"
    >
      <label className="new-project-row">
        <span>{t("workspace_name.name_label", { defaultValue: "Workspace name" })}</span>
        <AppInput
          value={name}
          placeholder={t("workspace_name.placeholder", {
            defaultValue: "e.g. Color Grading",
          })}
          ariaLabel={t("workspace_name.name_label", { defaultValue: "Workspace name" })}
          onValueChange={setName}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canConfirm) {
              e.preventDefault();
              submit();
            }
          }}
          spellCheck={false}
          autoFocus
        />
      </label>
      <footer className="new-project-actions">
        <Button size="lg" onClick={onCancel}>
          {t("workspace_name.cancel", { defaultValue: "Cancel" })}
        </Button>
        <Button variant="default" size="lg" onClick={submit} disabled={!canConfirm}>
          {t("workspace_name.confirm", { defaultValue: "Save" })}
        </Button>
      </footer>
    </AppDialog>
  );
}
