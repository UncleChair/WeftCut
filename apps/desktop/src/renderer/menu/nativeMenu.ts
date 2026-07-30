// The renderer's half of the macOS native application menu.
//
// Two directions, one hook:
//   • up   — project what THIS surface can run (label + effective accelerator
//            per action id) into the main process, which owns the menu's
//            structure. Re-sent whenever the locale or a keybinding changes, so
//            the native menu can never show a stale label or a rebound chord.
//   • down — run an item the user chose, through the SAME handler map
//            `useShortcuts` dispatches into. One implementation of each action,
//            three entry points (chord, in-app menu bar, native menu).
//
// Off macOS this is inert: Windows/Linux run with no application menu at all
// (ADR 0031 Stage 1), and the renderer-drawn `AppMenuBar` is the only bar.
//
// Note the menu is NOT how a chord reaches its action. The renderer is upstream
// of the menu on macOS — `useShortcuts` sees Cmd+S first and its
// `preventDefault()` suppresses the matching item — so `menu:action` fires only
// when the user picks with the mouse, or when no renderer handler consumed the
// chord (docs/notes/electron-chromium-behavior.md).
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { isMac } from "@/platform";
import { listen, type UnlistenFn } from "../bridge/events";
import { syncNativeMenu } from "../bridge/menu";
import { MENU_ACTION_IDS, type MenuActionId, type MenuProjection } from "../../shared/menu";
import { ACTION_DEFS } from "../shortcuts/defs";
import { runWithLogging, type HandlerMap, type OverrideMap } from "../shortcuts/useShortcuts";

interface UseNativeMenuOptions {
  /// The surface's action handlers — the same map passed to `useShortcuts`.
  /// An id missing from it is omitted from the menu rather than shown disabled
  /// (the startup screen has no project to save), so the menu can never offer
  /// something this surface would silently drop.
  handlers: HandlerMap;
  /// Per-user rebinds, as loaded from `keybindings.json`. Missing entries fall
  /// back to the catalogue defaults — the same resolution `useShortcuts` and
  /// the in-app menu hints use.
  overrides: OverrideMap;
}

export function useNativeMenu({ handlers, overrides }: UseNativeMenuOptions): void {
  const { t, i18n } = useTranslation();
  const handlersRef = useRef<HandlerMap>(handlers);

  useLayoutEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  // Callers build their handler map inline, so its identity changes every
  // render; what actually matters to the menu is WHICH ids are present. Sync on
  // that (a stable string) instead, or the menu would rebuild on every render.
  const availableIds = MENU_ACTION_IDS.filter((id) => !!handlers[id]).join(",");

  useEffect(() => {
    if (!isMac) return;
    const actions: MenuProjection["actions"] = {};
    for (const id of MENU_ACTION_IDS) {
      // Indexing the catalogue with a MenuActionId is also the compile-time
      // proof that every projectable id is a real action — src/shared/menu.ts
      // names the subset, and this line is where a drifting name fails to build.
      const def = ACTION_DEFS[id];
      if (!handlersRef.current[id]) continue;
      actions[id] = { label: t(def.labelKey), keys: overrides[id] ?? def.defaultKeys };
    }
    void syncNativeMenu({
      actions,
      // Titles of the two submenus main builds by hand; the role menus (Edit,
      // Window) carry Electron's own labels.
      labels: { "menu.file": t("menu.file"), "menu.view": t("menu.view") },
    });
    // `i18n.language` is the resync trigger for a locale switch — `t` itself is
    // a stable identity across one, so depending on it alone would not fire.
  }, [availableIds, overrides, t, i18n.language]);

  useEffect(() => {
    if (!isMac) return;
    let dispose: UnlistenFn | null = null;
    let cancelled = false;
    void listen<{ actionId: MenuActionId }>("menu:action", ({ payload }) => {
      const fn = handlersRef.current[payload.actionId];
      // Absent when the surface changed between the sync and the click — a
      // no-op is the right answer, not a throw.
      if (fn) runWithLogging(payload.actionId, fn);
    }).then((un) => {
      if (cancelled) un();
      else dispose = un;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
}
