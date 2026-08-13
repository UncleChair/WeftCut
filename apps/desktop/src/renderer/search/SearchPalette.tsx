import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AppInput } from "../components/AppInput";
import { getCommand } from "../commands/registry";
import { formatTimecode } from "../frames";
import { logEmit } from "../ipc";
import { resolveAccelerator } from "../shortcuts/match";
import { useEffectiveBindings } from "../shortcuts/bindings-context";
import { jumpToLayer, jumpToTimeUs, revealInMediaPool } from "../state/navigation";
import { useProjectStore } from "../state/projectStore";
import { GROUP_ORDER, rankEntries, type RankedResult } from "./matcher";
import { useSearchEntries } from "./searchIndexStore";
import type { MediaUsage, SearchEntryType } from "./types";

const VISIBLE_PER_GROUP = 5;
const RANK_CAP = 50;

interface MediaSubList {
  label: string;
  mediaId: string;
  usages: MediaUsage[];
}

function logStaleTarget(): void {
  void logEmit({
    level: "info",
    category: { kind: "System" },
    source: { kind: "User" },
    message: "search: target no longer exists",
  });
}

/// The global search palette (Mod+K): fuzzy-ranked commands/media/tracks/
/// clips/captions/markers in one Spotlight-style overlay. Mounted
/// conditionally by App.tsx (mount == open, same convention as every other
/// dialog in the app); the Dialog's `onOpenChange` is the single Esc/
/// backdrop path and unwinds one level (media sub-list → results → closed)
/// per the behavior contract.
export function SearchPalette({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const entries = useSearchEntries();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [sub, setSubState] = useState<MediaSubList | null>(null);
  const [expanded, setExpanded] = useState<Set<SearchEntryType>>(new Set());
  const subRef = useRef<MediaSubList | null>(null);
  const setSub = (v: MediaSubList | null) => { subRef.current = v; setSubState(v); };
  const fpsNum = useProjectStore((s) => s.summary?.composition.fps_num ?? 30);
  const fpsDen = useProjectStore((s) => s.summary?.composition.fps_den ?? 1);

  const grouped = useMemo(() => rankEntries(query, entries, RANK_CAP), [query, entries]);
  // Visible rows after per-group slicing; `flat` drives keyboard order.
  // `flatIndex` is the row → keyboard-position lookup so each rendered row
  // knows its index without a per-row O(n) search.
  const { flat, flatIndex, truncatedCounts } = useMemo(() => {
    const flat: RankedResult[] = [];
    const flatIndex = new Map<RankedResult, number>();
    const truncatedCounts = new Map<SearchEntryType, number>();
    for (const g of GROUP_ORDER) {
      const rows = grouped.get(g) ?? [];
      const visible = expanded.has(g) ? rows : rows.slice(0, VISIBLE_PER_GROUP);
      for (const r of visible) {
        flatIndex.set(r, flat.length);
        flat.push(r);
      }
      if (rows.length > visible.length) truncatedCounts.set(g, rows.length - visible.length);
    }
    return { flat, flatIndex, truncatedCounts };
  }, [grouped, expanded]);

  type SubAction =
    | { kind: "reveal"; mediaId: string }
    | { kind: "usage"; usage: MediaUsage };
  const subActions: SubAction[] = useMemo(() => {
    if (!sub) return [];
    return [
      { kind: "reveal" as const, mediaId: sub.mediaId },
      ...sub.usages.map((usage) => ({ kind: "usage" as const, usage })),
    ];
  }, [sub]);

  const count = sub ? subActions.length : flat.length;
  const clampedActive = Math.min(active, Math.max(0, count - 1));

  const activate = (idx: number) => {
    if (sub) {
      const a = subActions[idx];
      if (!a) return;
      if (a.kind === "reveal") {
        if (!revealInMediaPool(a.mediaId)) logStaleTarget();
      } else if (!jumpToLayer(a.usage.layerId)) {
        logStaleTarget();
      }
      onClose();
      return;
    }
    const r = flat[idx];
    if (!r) return;
    const p = r.entry.payload;
    switch (p.type) {
      case "command": {
        const cmd = getCommand(p.commandId);
        if (!cmd || cmd.enabled?.() === false) return;
        onClose(); // close first — the command may open its own dialog
        void cmd.run();
        return;
      }
      case "media":
        if (p.usages.length === 0) {
          // Unused media: skip the one-row sub-list, reveal directly.
          if (!revealInMediaPool(p.mediaId)) logStaleTarget();
          onClose();
          return;
        }
        setSub({ label: r.entry.label, mediaId: p.mediaId, usages: p.usages });
        setActive(0);
        return;
      case "track":
        if (p.firstLayerId && !jumpToLayer(p.firstLayerId)) logStaleTarget();
        onClose();
        return;
      case "clip":
      case "caption":
        if (!jumpToLayer(p.layerId)) logStaleTarget();
        onClose();
        return;
      case "marker":
        jumpToTimeUs(p.tUs);
        onClose();
        return;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((v) => Math.min(v + 1, count - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((v) => Math.max(v - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(clampedActive);
    }
    // Escape is NOT handled here — the Dialog's onOpenChange intercept
    // below unwinds one level at a time (sub-list → results → closed)
    // and catches backdrop clicks through the same path.
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        if (subRef.current) {
          setSub(null);
          setActive(0);
          return;
        }
        onClose();
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-black/50 supports-backdrop-filter:backdrop-blur-none" />
        <DialogPrimitive.Popup className="search-palette" aria-label={t("actions.open_search")}>
          <div className="search-palette-input">
            <AppInput
              type="search"
              clearable
              autoFocus
              placeholder={t("search.placeholder")}
              ariaLabel={t("search.placeholder")}
              clearAriaLabel={t("media_pool.clear_search")}
              value={query}
              onValueChange={(v) => {
                setQuery(v);
                setActive(0);
                setSub(null);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          <div className="search-palette-list" role="listbox">
            {sub ? (
              <>
                <div className="search-group-header">{sub.label}</div>
                {subActions.map((a, i) => (
                  <SubActionRow
                    key={a.kind === "reveal" ? "reveal" : a.usage.layerId}
                    action={a}
                    fpsNum={fpsNum}
                    fpsDen={fpsDen}
                    active={i === clampedActive}
                    onHover={() => setActive(i)}
                    onActivate={() => activate(i)}
                  />
                ))}
              </>
            ) : flat.length === 0 ? (
              <div className="search-empty">{t("search.no_results", { query })}</div>
            ) : (
              GROUP_ORDER.map((g) => grouped.has(g) ? (
                <div key={g}>
                  <div className="search-group-header">{t(`search.group_${g}`)}</div>
                  {(expanded.has(g)
                    ? grouped.get(g)!
                    : grouped.get(g)!.slice(0, VISIBLE_PER_GROUP)
                  ).map((r) => {
                    const idx = flatIndex.get(r) ?? -1;
                    return (
                      <ResultRow
                        key={r.entry.key}
                        r={r}
                        active={idx === clampedActive}
                        onHover={() => setActive(idx)}
                        onActivate={() => activate(idx)}
                      />
                    );
                  })}
                  {truncatedCounts.has(g) && (
                    <button
                      type="button"
                      className="search-show-more"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        // Expanding this group inserts `delta` rows into
                        // `flat` BEFORE every later group — shift the
                        // keyboard cursor by the same amount when it sits
                        // in one of those later groups, so the highlighted
                        // row (not just its index) survives the expansion.
                        // Rows in/before this group keep their indices:
                        // the visible slice is a stable prefix.
                        const delta = truncatedCounts.get(g) ?? 0;
                        const activeGroup = flat[clampedActive]?.entry.type;
                        if (
                          activeGroup !== undefined &&
                          GROUP_ORDER.indexOf(activeGroup) > GROUP_ORDER.indexOf(g)
                        ) {
                          setActive(clampedActive + delta);
                        }
                        setExpanded((prev) => new Set(prev).add(g));
                      }}
                    >
                      {t("search.show_more", { count: truncatedCounts.get(g) })}
                    </button>
                  )}
                </div>
              ) : null)
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}

function HighlightedLabel({ label, indexes }: { label: string; indexes: number[] }) {
  if (indexes.length === 0) return <>{label}</>;
  const set = new Set(indexes);
  const out: React.ReactNode[] = [];
  // fuzzysort indexes are UTF-16 code units; render per code point so
  // surrogate pairs (emoji in labels) stay whole and offsets stay aligned.
  let unit = 0;
  for (const ch of label) {
    const hit = set.has(unit) || (ch.length === 2 && set.has(unit + 1));
    out.push(hit ? <mark key={unit}>{ch}</mark> : <span key={unit}>{ch}</span>);
    unit += ch.length;
  }
  return <>{out}</>;
}

function ResultRow({
  r,
  active,
  onHover,
  onActivate,
}: {
  r: RankedResult;
  active: boolean;
  onHover: () => void;
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  const p = r.entry.payload;
  const binding = useEffectiveBindings(p.type === "command" ? p.actionId : undefined);
  const accelerator = binding ? resolveAccelerator(binding) : "";
  const command = p.type === "command" ? getCommand(p.commandId) : undefined;
  const disabled = command?.enabled?.() === false;
  // Which way a checkable command is currently set — `undefined` for everything
  // that isn't checkable, which is most rows. Read live, in this row's own
  // render, for the same reason `enabled` is: the index is rebuilt on a debounce
  // and would carry a stale answer. Without it the palette lists a toggle
  // without saying which way selecting it would flip it.
  const checked = command?.checked?.();
  const unused = p.type === "media" && p.usages.length === 0;
  return (
    <div
      role="option"
      tabIndex={-1}
      aria-selected={active}
      {...(checked === undefined ? {} : { "aria-checked": checked })}
      aria-disabled={disabled || undefined}
      className={cn("search-row", active && "is-active", disabled && "is-disabled")}
      // Keep focus in the input (AppInput clear-button precedent).
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onActivate}
      ref={(el) => {
        if (active) el?.scrollIntoView({ block: "nearest" });
      }}
    >
      <span className="search-row-label">
        <HighlightedLabel label={r.entry.label} indexes={r.highlight} />
      </span>
      {p.type === "media" && !p.available && (
        <span className="search-row-badge">{t("search.missing_badge")}</span>
      )}
      <span className="search-row-context">
        {unused ? t("search.unused") : r.entry.context}
      </span>
      {/* Right-hand end, beside the accelerator, rather than a leading check
          slot like the menus': most rows here are not commands, so a leading
          slot would either indent every label in the palette or indent only the
          checkable rows. `aria-checked` on the row above carries this to a
          screen reader, hence aria-hidden. */}
      {checked && (
        <span className="search-row-check" aria-hidden="true">
          <CheckIcon size={12} />
        </span>
      )}
      {accelerator && <kbd className="search-row-kbd">{accelerator}</kbd>}
    </div>
  );
}

function SubActionRow({
  action,
  fpsNum,
  fpsDen,
  active,
  onHover,
  onActivate,
}: {
  action: { kind: "reveal"; mediaId: string } | { kind: "usage"; usage: MediaUsage };
  fpsNum: number;
  fpsDen: number;
  active: boolean;
  onHover: () => void;
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  const label =
    action.kind === "reveal"
      ? t("search.reveal_in_pool")
      : `${action.usage.trackLabel} · ${formatTimecode(action.usage.tStartUs, fpsNum, fpsDen)}`;
  return (
    <div
      role="option"
      tabIndex={-1}
      aria-selected={active}
      className={cn("search-row", active && "is-active")}
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onActivate}
      ref={(el) => {
        if (active) el?.scrollIntoView({ block: "nearest" });
      }}
    >
      <span className="search-row-label">{label}</span>
    </div>
  );
}
