// Add-effect picker: one trigger button opening a searchable, category-grouped
// popup over the effect catalog.
//
// The popup is PORTALED (Base UI Popover.Portal): the Effect panel renders
// inside `.weft-dock-panel-scroll` (overflow: auto), so an in-flow dropdown
// would be clipped by the panel instead of floating over it.

import { Fragment, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@base-ui/react/popover";
import { Plus } from "lucide-react";
import { AppInput } from "../components/AppInput";
import type { EffectDescriptor } from "../render/effects/effectRegistry";
import {
  filterEffects,
  groupEffects,
  type EffectPickItem,
} from "./effectPickerMatch";

/// Translate the catalog into picker rows. Kept separate from the component so
/// the label/description fallbacks live in one place: an effect with no
/// `effects.<kind>.desc` string simply shows no description line.
function useCatalogItems(catalog: EffectDescriptor[]): EffectPickItem[] {
  const { t } = useTranslation();
  return useMemo(
    () =>
      catalog.map((d) => ({
        kind: d.kind,
        label: t(d.nameI18nKey, { defaultValue: d.kind }),
        desc: t(`effects.${d.kind}.desc`, { defaultValue: "" }),
        category: d.category,
        categoryLabel: t(`effects.category.${d.category}`, {
          defaultValue: d.category,
        }),
      })),
    [catalog, t],
  );
}

/// The popup body — search box + grouped rows. Exported without the popover
/// shell so the ranking/keyboard behaviour is testable in jsdom without Base
/// UI's portal and focus machinery.
export function EffectPickerList({
  items,
  onPick,
  inputRef,
}: {
  items: EffectPickItem[];
  onPick: (kind: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Flat relevance order drives the keyboard cursor; the groups below are a
  // presentation of that same list, so ↓ walks across group boundaries.
  const flat = filterEffects(query, items);
  const groups = groupEffects(flat);
  // A shrinking result set must never leave the cursor past the end.
  const cursor = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);

  const move = (delta: number) => {
    if (flat.length === 0) return;
    const next = (cursor + delta + flat.length) % flat.length;
    setActive(next);
    const row = listRef.current?.querySelector(`[data-pick-index="${next}"]`);
    // Best-effort chrome — jsdom doesn't implement scrollIntoView at all.
    if (row instanceof HTMLElement && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[cursor];
      if (item) onPick(item.kind);
    }
    // Escape is left to the popover shell, which owns close.
  };

  return (
    <div className="effect-picker">
      <div className="effect-picker-search">
        <AppInput
          ref={inputRef}
          type="search"
          clearable
          value={query}
          onValueChange={(next) => {
            setQuery(next);
            setActive(0);
          }}
          placeholder={t("effects.search_placeholder")}
          ariaLabel={t("effects.search_placeholder")}
          clearAriaLabel={t("effects.search_clear")}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="effect-picker-list" role="listbox" ref={listRef}>
        {flat.length === 0 && (
          <p className="effect-picker-empty">{t("effects.no_results")}</p>
        )}
        {groups.map((group) => (
          <Fragment key={group.category}>
            <div className="effect-picker-group">{group.label}</div>
            {group.items.map((item) => {
              const index = flat.indexOf(item);
              return (
                <button
                  key={item.kind}
                  type="button"
                  role="option"
                  aria-selected={index === cursor}
                  data-pick-index={index}
                  data-testid={`effect-pick-${item.kind}`}
                  className={
                    index === cursor
                      ? "effect-picker-row is-active"
                      : "effect-picker-row"
                  }
                  // Hover moves the cursor so mouse and keyboard never disagree
                  // about which row Enter would take.
                  onPointerEnter={() => setActive(index)}
                  onClick={() => onPick(item.kind)}
                >
                  <span className="effect-picker-row-label">{item.label}</span>
                  {item.desc !== "" && (
                    <span className="effect-picker-row-desc">{item.desc}</span>
                  )}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/// Trigger + popup. Picking closes the popup and hands the kind up; the caller
/// owns the `add_effect` command and its error surface.
export function EffectPicker({
  catalog,
  onPick,
  disabled,
}: {
  catalog: EffectDescriptor[];
  onPick: (kind: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const items = useCatalogItems(catalog);
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="effect-add-trigger"
        data-testid="effect-add"
        disabled={disabled ?? false}
      >
        <Plus size={13} aria-hidden="true" />
        {t("effects.add")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          className="app-popup-positioner"
        >
          {/* Focus lands in the search box, not the popup shell, so the popup
              is type-to-filter from the first keystroke. */}
          <Popover.Popup className="app-menu-list" initialFocus={inputRef}>
            <EffectPickerList
              items={items}
              inputRef={inputRef}
              onPick={(kind) => {
                setOpen(false);
                onPick(kind);
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
