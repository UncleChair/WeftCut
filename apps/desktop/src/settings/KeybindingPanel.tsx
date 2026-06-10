import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { XIcon } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  keybindingsExport,
  keybindingsImport,
  keybindingsResetAll,
  keybindingsSet,
  type KeybindingsMap,
} from "../ipc";
import {
  ACTION_DEFS,
  ACTION_IDS,
  type ActionId,
  bindingsEqual,
} from "../shortcuts";
import {
  KeybindingCapture,
  bindingLabel,
} from "./KeybindingCapture";
import { Button } from "@/components/ui/button";

interface Props {
  /// Current overrides loaded by App.tsx. Missing entries inherit the
  /// default from `ACTION_DEFS`. An empty array means "explicitly
  /// unbound."
  keybindings: KeybindingsMap;
  /// App.tsx owns the state; this callback hands it back updated maps
  /// after every successful mutation. We avoid full-refetches by
  /// reusing the returned map from the backend's import/export
  /// commands or by mutating locally and posting the result.
  onChanged: (next: KeybindingsMap) => void;
  /// Surface errors back to the parent so the panel's existing error
  /// banner can render them.
  onError: (message: string | null) => void;
}

/// Compute the effective binding for each action — defaults overlaid
/// with user overrides. Missing override = use default. Empty-array
/// override = explicitly unbound (no key fires).
function resolveEffective(
  overrides: KeybindingsMap,
): Record<ActionId, string[]> {
  const out = {} as Record<ActionId, string[]>;
  for (const id of ACTION_IDS) {
    const ovr = overrides[id];
    out[id] = ovr ?? ACTION_DEFS[id].defaultKeys;
  }
  return out;
}

/// True if the action's effective bindings equal its defaults
/// (in any order). Used to decide whether the per-row Reset button
/// should be visible.
function isAtDefault(
  effective: Record<ActionId, string[]>,
  id: ActionId,
): boolean {
  const def = ACTION_DEFS[id].defaultKeys;
  const cur = effective[id];
  if (def.length !== cur.length) return false;
  // Equal lengths (guarded above) ⇒ every `def` index is in-bounds for `cur`.
  return def.every((k, i) => bindingsEqual(k, cur[i]!));
}

/// Find which other action currently owns the given chord, if any.
function findChordOwner(
  effective: Record<ActionId, string[]>,
  chord: string,
  except: ActionId,
): ActionId | null {
  for (const id of ACTION_IDS) {
    if (id === except) continue;
    if (effective[id].some((k) => bindingsEqual(k, chord))) return id;
  }
  return null;
}

export function KeybindingPanel({
  keybindings,
  onChanged,
  onError,
}: Props) {
  const { t } = useTranslation();
  const effective = useMemo(() => resolveEffective(keybindings), [keybindings]);
  const [capturing, setCapturing] = useState<ActionId | null>(null);
  // The capture chip beats the global dispatcher without needing an
  // explicit `disabled` toggle: it attaches a `keydown` listener on
  // `window` with `{ capture: true }`, calls `preventDefault` +
  // `stopPropagation`, and the global dispatcher (listening on the
  // bubble phase) never sees the event. `useShortcuts` keeps a
  // `disabled` prop available for future modal flows that don't have
  // their own capturing listener.

  async function applyOverride(action: ActionId, keys: string[]) {
    try {
      onError(null);
      await keybindingsSet(action, keys);
      onChanged({ ...keybindings, [action]: keys });
    } catch (e) {
      onError(String(e));
    }
  }

  async function onAddCommitted(action: ActionId, binding: string) {
    setCapturing(null);
    const current = effective[action];
    if (current.some((k) => bindingsEqual(k, binding))) return; // dedupe
    await applyOverride(action, [...current, binding]);
  }

  async function onRemoveChord(action: ActionId, chord: string) {
    const current = effective[action];
    const next = current.filter((k) => !bindingsEqual(k, chord));
    await applyOverride(action, next);
  }

  async function onResetRow(action: ActionId) {
    // Per Q10 of the design: per-row reset blocks if a default would
    // conflict with a currently-bound chord on another action.
    const defaults = ACTION_DEFS[action].defaultKeys;
    for (const d of defaults) {
      const owner = findChordOwner(effective, d, action);
      if (owner) {
        onError(
          t("keybindings.reset_blocked", {
            chord: bindingLabel(d),
            action: t(ACTION_DEFS[owner].labelKey),
          }),
        );
        return;
      }
    }
    await applyOverride(action, defaults);
  }

  async function onResetAll() {
    try {
      onError(null);
      await keybindingsResetAll();
      onChanged({});
    } catch (e) {
      onError(String(e));
    }
  }

  async function onExport() {
    try {
      onError(null);
      const dest = await saveDialog({
        title: t("keybindings.export_title"),
        defaultPath: "weftcut-keybindings.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof dest !== "string") return;
      await keybindingsExport(dest);
    } catch (e) {
      onError(String(e));
    }
  }

  async function onImport() {
    try {
      onError(null);
      const src = await openDialog({
        title: t("keybindings.import_title"),
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof src !== "string") return;
      const next = await keybindingsImport(src);
      onChanged(next);
    } catch (e) {
      onError(String(e));
    }
  }

  return (
    <div className="keybindings">
      <div className="keybindings-toolbar">
        <Button size="sm" onClick={onResetAll}>
          {t("keybindings.reset_all")}
        </Button>
        <Button size="sm" onClick={onExport}>
          {t("keybindings.export")}
        </Button>
        <Button size="sm" onClick={onImport}>
          {t("keybindings.import")}
        </Button>
      </div>
      <table className="keybindings-table">
        <tbody>
          {ACTION_IDS.map((id) => {
            const def = ACTION_DEFS[id];
            const chords = effective[id];
            const atDefault = isAtDefault(effective, id);
            return (
              <tr key={id} className="keybindings-row">
                <td className="keybindings-label">{t(def.labelKey)}</td>
                <td className="keybindings-chords">
                  {chords.length === 0 && (
                    <span className="keybindings-empty">
                      {t("keybindings.no_binding")}
                    </span>
                  )}
                  {chords.map((chord) => (
                    <span key={chord} className="keybindings-chip">
                      <span className="keybindings-chip-label">
                        {bindingLabel(chord)}
                      </span>
                      <button
                        type="button"
                        className="keybindings-chip-remove"
                        title={t("keybindings.remove_hint")}
                        aria-label={t("keybindings.remove_hint")}
                        onClick={() => onRemoveChord(id, chord)}
                      >
                        <XIcon size={11} aria-hidden />
                      </button>
                    </span>
                  ))}
                  {capturing === id ? (
                    <KeybindingCapture
                      effective={effective}
                      ownerId={id}
                      onCommit={(binding) => onAddCommitted(id, binding)}
                      onCancel={() => setCapturing(null)}
                      onActiveChange={() => {
                        // No-op: the capture chip wins by listening
                        // with `capture: true` + stopPropagation,
                        // not by toggling a global suspend flag.
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="keybindings-add"
                      onClick={() => setCapturing(id)}
                    >
                      {t("keybindings.add")}
                    </button>
                  )}
                </td>
                <td className="keybindings-row-actions">
                  {!atDefault && (
                    <button
                      type="button"
                      className="keybindings-reset"
                      onClick={() => onResetRow(id)}
                    >
                      {t("keybindings.reset")}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
