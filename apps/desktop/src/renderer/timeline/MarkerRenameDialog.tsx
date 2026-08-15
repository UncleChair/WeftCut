import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { tryMutate } from "../errors/tryMutate";
import { renameMarker } from "../ipc";
import { useProjectStore } from "../state/projectStore";
import {
  closeMarkerRenamePrompt,
  useMarkerRenamePromptStore,
} from "./markerRenamePrompt";

/// Label prompt for "rename marker", raised from the marker context menu and
/// from `M` on an already-marked frame alike.
///
/// Prefilled with the current label — fixing a typo must not mean retyping the
/// line — and gated on non-empty: an empty label is a legal *store* state (the
/// tooltip falls back to the translated noun), but it also silently drops the
/// marker from palette search, so clearing one stays agent-side.
///
/// Rendered by App rather than by the ruler — see `markerRenamePrompt.ts`.
export function MarkerRenameDialog() {
  const { t } = useTranslation();
  const markerId = useMarkerRenamePromptStore((s) => s.markerId);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  // Fresh draft per opening, seeded from the marker's current label. An
  // imperative read: the marker demonstrably exists at open (both entry points
  // found it a moment ago), and a subscription would re-seed the draft under
  // the user's cursor on every summary tick.
  useEffect(() => {
    if (markerId !== null) {
      const current = useProjectStore
        .getState()
        .summary?.markers.find((m) => m.id === markerId);
      setLabel(current?.label ?? "");
      setSaving(false);
    }
  }, [markerId]);

  if (markerId === null) return null;

  const trimmed = label.trim();
  const canConfirm = trimmed !== "" && !saving;

  const submit = async () => {
    if (!canConfirm) return;
    setSaving(true);
    // Renaming to the unchanged label is an actor-level no-op: ok result, no
    // history entry. The dialog closes either way.
    const ok = await tryMutate(
      () => renameMarker(markerId, trimmed),
      "update_marker",
    );
    if (!ok) {
      // The refusal is already one legible status-bar line (tryMutate). Stay
      // open so the name the user typed isn't thrown away with it.
      setSaving(false);
      return;
    }
    closeMarkerRenamePrompt();
  };

  return (
    <AppDialog
      title={t("marker_rename.title")}
      onClose={saving ? undefined : closeMarkerRenamePrompt}
      closeLabel={saving ? undefined : t("marker_rename.cancel")}
      panelClassName="new-project-panel"
    >
      <label className="new-project-row">
        <span>{t("marker_rename.label")}</span>
        <AppInput
          value={label}
          placeholder={t("marker_rename.placeholder")}
          ariaLabel={t("marker_rename.label")}
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
      <footer className="new-project-actions">
        <Button size="lg" disabled={saving} onClick={closeMarkerRenamePrompt}>
          {t("marker_rename.cancel")}
        </Button>
        <Button
          variant="default"
          size="lg"
          disabled={!canConfirm}
          onClick={() => void submit()}
        >
          {t("marker_rename.confirm")}
        </Button>
      </footer>
    </AppDialog>
  );
}
