import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { tryMutate } from "../errors/tryMutate";
import { projectCreateCheckpoint } from "../ipc";
import { refreshHistoryView } from "../state/historyStore";
import {
  closeCheckpointPrompt,
  useCheckpointPromptStore,
} from "./checkpointPrompt";

/// Label prompt for "create checkpoint", raised from the History Panel's
/// section header and from the `createCheckpoint` command alike.
///
/// This is a PROMPT, not a confirmation: creating a checkpoint is cheap and its
/// own undo is Delete, so it asks for nothing but the name — which it does have
/// to ask for, since an unlabelled checkpoint is unidentifiable in the list
/// (and the backend refuses an empty label outright).
///
/// Rendered by App rather than by the Panel — see `checkpointPrompt.ts`.
export function CheckpointPromptDialog() {
  const { t } = useTranslation();
  const open = useCheckpointPromptStore((s) => s.open);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  // Fresh draft per opening: a name left over from the last checkpoint would
  // be silently re-submitted by an Enter press.
  useEffect(() => {
    if (open) {
      setLabel("");
      setSaving(false);
    }
  }, [open]);

  if (!open) return null;

  const trimmed = label.trim();
  const canConfirm = trimmed !== "" && !saving;

  const submit = async () => {
    if (!canConfirm) return;
    setSaving(true);
    const ok = await tryMutate(
      () => projectCreateCheckpoint(trimmed),
      "project_create_checkpoint",
    );
    if (!ok) {
      // The refusal is already one legible status-bar line (tryMutate). Stay
      // open so the name the user typed isn't thrown away with it.
      setSaving(false);
      return;
    }
    closeCheckpointPrompt();
    // `create_checkpoint` changes no project state, so it neither commits nor
    // broadcasts `project:changed` — the Panel is driven by that event and
    // would never hear about the new row (ticket 02's constraint on 04).
    // No-op while the Panel is closed, which the command path allows.
    await refreshHistoryView();
  };

  return (
    <AppDialog
      title={t("history_panel.checkpoint_create_title")}
      onClose={saving ? undefined : closeCheckpointPrompt}
      closeLabel={saving ? undefined : t("history_panel.checkpoint_cancel")}
      panelClassName="new-project-panel"
    >
      <label className="new-project-row">
        <span>{t("history_panel.checkpoint_label")}</span>
        <AppInput
          value={label}
          placeholder={t("history_panel.checkpoint_label_placeholder")}
          ariaLabel={t("history_panel.checkpoint_label")}
          onValueChange={setLabel}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canConfirm) {
              e.preventDefault();
              void submit();
            }
          }}
          spellCheck={false}
          autoFocus
        />
      </label>
      {/* Said here as well as in the Panel section, because the command path
          can raise this dialog without the Panel ever being visible. */}
      <p className="checkpoint-session-note">
        {t("history_panel.checkpoints_note")}
      </p>
      <footer className="new-project-actions">
        <Button size="lg" disabled={saving} onClick={closeCheckpointPrompt}>
          {t("history_panel.checkpoint_cancel")}
        </Button>
        <Button
          variant="default"
          size="lg"
          disabled={!canConfirm}
          onClick={() => void submit()}
        >
          {t("history_panel.checkpoint_create_confirm")}
        </Button>
      </footer>
    </AppDialog>
  );
}
