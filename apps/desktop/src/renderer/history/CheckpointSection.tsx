import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Plus, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AppDialog } from "../components/AppDialog";
import { tryMutate } from "../errors/tryMutate";
import {
  projectDeleteCheckpoint,
  projectRestoreCheckpoint,
  type HistoryCheckpointSummary,
} from "../ipc";
import { refreshHistoryView } from "../state/historyStore";
import { openCheckpointPrompt } from "./checkpointPrompt";
import { formatClock } from "./historyRows";

/// Named checkpoints, in their OWN section above the stack — never inline pins
/// (spec decision 9). Two independent reasons:
///
///   - `NamedCheckpoint` carries no `op_id`, only a `created_at`, so there is no
///     stack row to anchor it to — and the stack truncates and evicts out from
///     under it anyway;
///   - the click semantics differ. A stack row moves the CURSOR;
///     `restore_checkpoint` RECORDS a new entry instead. Drawing the two in one
///     list would imply "click = jump" and lie about what a click does.
///
/// The new entry restore records shows up in the stack below, one row further
/// on. That is correct, not a bug.

interface CheckpointSectionProps {
  checkpoints: readonly HistoryCheckpointSummary[];
  /// Non-null while an agent holds the revert lock. Disables **Restore only** —
  /// see the note on the button.
  lockReason: string | null;
}

export function CheckpointSection({
  checkpoints,
  lockReason,
}: CheckpointSectionProps) {
  const { t } = useTranslation();
  /// The row whose delete is awaiting confirmation, or null.
  const [pendingDelete, setPendingDelete] =
    useState<HistoryCheckpointSummary | null>(null);
  /// Ids with an action in flight, so a double-click can't fire twice.
  const [busyId, setBusyId] = useState<string | null>(null);

  const onRestore = async (id: string) => {
    if (lockReason) return; // belt-and-suspenders; the backend also rejects
    setBusyId(id);
    // No explicit refresh: restore RECORDS an entry, so it broadcasts
    // `project:changed` and the store refetches itself. Create and delete are
    // the ones that don't (see below).
    await tryMutate(
      () => projectRestoreCheckpoint(id),
      "project_restore_checkpoint",
    );
    setBusyId(null);
  };

  const onConfirmDelete = async (id: string) => {
    setBusyId(id);
    const ok = await tryMutate(
      () => projectDeleteCheckpoint(id),
      "project_delete_checkpoint",
    );
    setBusyId(null);
    setPendingDelete(null);
    if (!ok) return;
    // `delete_checkpoint` changes no project state, so nothing broadcasts and
    // the Panel would keep drawing the row it just destroyed (ticket 02's
    // constraint on 04).
    await refreshHistoryView();
  };

  return (
    <section className="history-checkpoints" data-history-section="checkpoints">
      <header className="history-checkpoints-header">
        <span className="history-checkpoints-title">
          {t("history_panel.checkpoints_title")}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={openCheckpointPrompt}
          title={t("history_panel.checkpoint_create_hint")}
        >
          <Plus size={12} aria-hidden="true" />
          {t("history_panel.checkpoint_create")}
        </Button>
      </header>
      {/* Not decoration. Checkpoints are absent from `serialize.ts` /
          `persistence.ts` and `replace_state` clears them
          (docs/features.md:39), so a user who reads these as durable saves
          loses work. Making them durable needs `.vproj` migration — issue #14,
          out of scope here. */}
      <p className="checkpoint-session-note">
        {t("history_panel.checkpoints_note")}
      </p>
      {checkpoints.length === 0 ? (
        <p className="history-checkpoints-empty">
          {t("history_panel.checkpoints_empty")}
        </p>
      ) : (
        <ul className="history-checkpoint-list">
          {checkpoints.map((checkpoint) => {
            const client =
              checkpoint.actor.kind === "Agent" ? checkpoint.actor.client : null;
            const busy = busyId === checkpoint.id;
            return (
              <li
                key={checkpoint.id}
                className="history-checkpoint-row"
                data-checkpoint-id={checkpoint.id}
              >
                <span className="history-row-time">
                  {formatClock(checkpoint.created_at)}
                </span>
                {/* Same actor vocabulary as the stack rows: one glyph, one
                    data-actor hook, the client name in the accessible label. */}
                <span
                  className="history-row-actor"
                  data-actor={client === null ? "user" : "agent"}
                  aria-label={
                    client === null
                      ? t("history_panel.actor_user")
                      : t("history_panel.agent_client", { client })
                  }
                >
                  {client === null ? (
                    <User size={12} aria-hidden="true" />
                  ) : (
                    <Bot size={12} aria-hidden="true" />
                  )}
                </span>
                <span
                  className="history-checkpoint-label"
                  title={checkpoint.label}
                >
                  {checkpoint.label}
                </span>
                {/* ONLY Restore disables under the lock. The lock rejects
                    REVERT paths (docs/features.md#undo-stack-scope) and restore
                    is one; create and delete are not, and the backend serves
                    both while locked. Disabling a button the backend would
                    happily serve is a lie in the opposite direction from the
                    one RecordPanel avoids. */}
                <Button
                  variant="secondary"
                  size="xs"
                  className="history-checkpoint-restore"
                  disabled={lockReason !== null || busy}
                  title={
                    lockReason
                      ? t("history_panel.locked_hint", { reason: lockReason })
                      : t("history_panel.checkpoint_restore_hint")
                  }
                  onClick={() => void onRestore(checkpoint.id)}
                >
                  {t("history_panel.checkpoint_restore")}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="history-checkpoint-delete"
                  disabled={busy}
                  title={t("history_panel.checkpoint_delete_hint")}
                  onClick={() => setPendingDelete(checkpoint)}
                >
                  {t("history_panel.checkpoint_delete")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {pendingDelete && (
        <DeleteCheckpointDialog
          target={pendingDelete}
          deleting={busyId === pendingDelete.id}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void onConfirmDelete(pendingDelete.id)}
        />
      )}
    </section>
  );
}

/// Delete confirms; create does not. A checkpoint is a named recovery point
/// pinning a whole snapshot, and dropping it records nothing — so Ctrl-Z does
/// not bring it back and there is no second chance anywhere. Create is cheap
/// and reversible by exactly this action, which is why only one side asks.
///
/// Built on `AppDialog` + a destructive footer button, the same shape
/// `MediaPool`'s remove-media confirmation uses — the codebase's one
/// destructive-confirm primitive.
function DeleteCheckpointDialog({
  target,
  deleting,
  onCancel,
  onConfirm,
}: {
  target: HistoryCheckpointSummary;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AppDialog
      title={t("history_panel.checkpoint_delete_title")}
      onClose={deleting ? undefined : onCancel}
      closeLabel={deleting ? undefined : t("history_panel.checkpoint_cancel")}
      panelClassName="settings-panel checkpoint-delete-dialog"
    >
      <div className="settings-body">
        <div className="settings-card">
          <p className="settings-blurb">
            {t("history_panel.checkpoint_delete_body", { label: target.label })}
          </p>
          <p className="settings-warn">
            {t("history_panel.checkpoint_delete_note")}
          </p>
          <div className="export-actions">
            <Button size="lg" disabled={deleting} onClick={onCancel}>
              {t("history_panel.checkpoint_cancel")}
            </Button>
            <Button
              variant="destructive"
              size="lg"
              disabled={deleting}
              onClick={onConfirm}
            >
              {deleting
                ? t("history_panel.checkpoint_deleting")
                : t("history_panel.checkpoint_delete_confirm")}
            </Button>
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
