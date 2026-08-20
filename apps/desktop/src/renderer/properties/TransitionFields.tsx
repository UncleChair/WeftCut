import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatTimecode, parseTimecode } from "../frames";
import { AppInput } from "../components/AppInput";
import { AppSelect } from "../components/AppSelect";
import { Button } from "@/components/ui/button";
import {
  removeTransition,
  updateTransition,
  type TransitionDirection,
  type TransitionSummary,
} from "../ipc";
import { logMutationFailure } from "../errors/tryMutate";
import { clearTransitionSelection } from "../state/selectionStore";
import {
  TRANSITION_DIRECTIONS,
  TRANSITION_KIND_NAMES,
  buildTransitionKindArgs,
  transitionDirectionOf,
  type TransitionKindName,
} from "../timeline/transitions";

/// Inspector body for a selected transition chip: kind picker, direction
/// picker (Wipe/Slide only), frame-snapped duration input (timecode — the
/// panel's duration-input precedent), delete button. Every edit routes
/// through `update_transition` — one commit, one undo step. Kind changes to
/// Wipe/Slide always send a direction with the kind (backend rejects kind
/// alone); the picker's preselected default is 'left'.
export function TransitionFields({
  transition,
  fpsNum,
  fpsDen,
  onMutated,
}: {
  transition: TransitionSummary;
  fpsNum: number;
  fpsDen: number;
  onMutated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const kind = transition.kind.kind;
  const direction = transitionDirectionOf(transition.kind);

  const [durTc, setDurTc] = useState(() =>
    formatTimecode(transition.duration_us, fpsNum, fpsDen),
  );
  // Resync from the authoritative snapshot on committed changes (own
  // round-trip, undo). Primitive deps so unrelated refreshes can't clobber
  // the field mid-typing.
  useEffect(() => {
    setDurTc(formatTimecode(transition.duration_us, fpsNum, fpsDen));
  }, [transition.id, transition.duration_us, fpsNum, fpsDen]);

  // Surface structured backend errors through the status bar / log — the
  // app's error path (errors/formatCommandError.ts owns the copy). This
  // panel's commits never send `extended_us`, so the refusals here are the
  // overlap-routing ones (occupied destination, t = 0 crossing, duration
  // bounds). NO silent clamping anywhere.
  const surfaceError = (err: unknown) => {
    logMutationFailure(err, "Update transition");
  };

  const commitKind = async (nextKind: TransitionKindName): Promise<void> => {
    if (nextKind === kind) return;
    // Kind→direction pairing: Wipe/Slide must carry a direction in the same
    // patch; keep the current one where it exists, else the 'left' default.
    const kindArgs = buildTransitionKindArgs(nextKind, direction);
    try {
      await updateTransition({ transitionId: transition.id, ...kindArgs });
      await onMutated();
    } catch (e) {
      surfaceError(e);
    }
  };

  const commitDirection = async (
    nextDirection: TransitionDirection,
  ): Promise<void> => {
    if (nextDirection === direction || kind === "Crossfade") return;
    try {
      await updateTransition({
        transitionId: transition.id,
        kind,
        direction: nextDirection,
      });
      await onMutated();
    } catch (e) {
      surfaceError(e);
    }
  };

  const commitDuration = async (): Promise<void> => {
    const us = parseTimecode(durTc, fpsNum, fpsDen);
    // parseTimecode output is frame-snapped by construction; `> 0` enforces
    // the 1-frame minimum. Invalid input reverts, matching the panel's
    // timecode fields.
    if (us === null || us <= 0) {
      setDurTc(formatTimecode(transition.duration_us, fpsNum, fpsDen));
      return;
    }
    if (us === transition.duration_us) return;
    try {
      // Duration only — no extended_us — so the mutation's sanctity-preferring
      // routing decides the geometry: growth moves the incoming layer left and
      // never borrows tail; shrink returns borrowed tail first (ADR 0048).
      await updateTransition({ transitionId: transition.id, durationUs: us });
      await onMutated();
    } catch (e) {
      setDurTc(formatTimecode(transition.duration_us, fpsNum, fpsDen));
      surfaceError(e);
    }
  };

  const onDelete = async (): Promise<void> => {
    try {
      await removeTransition(transition.id);
      clearTransitionSelection();
      await onMutated();
    } catch (e) {
      surfaceError(e);
    }
  };

  return (
    <section
      className="prop-section"
      aria-label={t("property_panel.transition", { defaultValue: "Transition" })}
    >
      <h3>{t("property_panel.transition", { defaultValue: "Transition" })}</h3>
      <TransitionField label={t("property_panel.kind", { defaultValue: "Kind" })}>
        <AppSelect
          value={kind}
          ariaLabel={t("property_panel.kind", { defaultValue: "Kind" })}
          onValueChange={(v) => void commitKind(v as TransitionKindName)}
          options={TRANSITION_KIND_NAMES.map((name) => ({
            value: name,
            label: t(`transitions.kind_${name.toLowerCase()}`, {
              defaultValue: name,
            }),
          }))}
        />
      </TransitionField>
      {kind !== "Crossfade" && (
        <TransitionField
          label={t("property_panel.direction", { defaultValue: "Direction" })}
        >
          <AppSelect
            value={direction ?? "left"}
            ariaLabel={t("property_panel.direction", {
              defaultValue: "Direction",
            })}
            onValueChange={(v) =>
              void commitDirection(v as TransitionDirection)
            }
            options={TRANSITION_DIRECTIONS.map((d) => ({
              value: d,
              label: t(`transitions.direction_${d}`, { defaultValue: d }),
            }))}
          />
        </TransitionField>
      )}
      <TransitionField
        label={t("property_panel.duration", { defaultValue: "Duration" })}
      >
        <AppInput
          value={durTc}
          mono
          ariaLabel={t("property_panel.duration", { defaultValue: "Duration" })}
          onValueChange={setDurTc}
          onBlur={() => void commitDuration()}
        />
      </TransitionField>
      <Button variant="destructive" size="sm" onClick={() => void onDelete()}>
        {t("property_panel.transition_delete", {
          defaultValue: "Delete transition",
        })}
      </Button>
    </section>
  );
}

/// Minimal label+control row matching PropertyPanel's `Field` markup (kept
/// local — importing PropertyPanel's private Field would create a module
/// cycle since the panel renders this component).
function TransitionField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="prop-field">
      <span className="prop-field-label">{label}</span>
      <div className="prop-field-control">{children}</div>
    </label>
  );
}
