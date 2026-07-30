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
// Inert off macOS, which has no application menu at all (src/main/appMenu.ts).
// The contract and the direction of the handoff: src/shared/menu.ts.
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { isMac } from "@/platform";
import { listen, type UnlistenFn } from "../bridge/events";
import { syncNativeMenu } from "../bridge/menu";
import { MENU_ACTION_IDS, type MenuActionId, type MenuProjection } from "../../shared/menu";
import { ACTION_DEFS } from "../shortcuts/defs";
import {
  appActionsSuspended,
  runWithLogging,
  type HandlerMap,
  type OverrideMap,
} from "../shortcuts/useShortcuts";

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
  const { t } = useTranslation();
  const handlersRef = useRef<HandlerMap>(handlers);

  useLayoutEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  const actions: MenuProjection["actions"] = {};
  for (const id of MENU_ACTION_IDS) {
    // Indexing the catalogue with a MenuActionId is also the compile-time proof
    // that every projectable id is a real action — src/shared/menu.ts names the
    // subset, and this line is where a drifting name fails to build.
    const def = ACTION_DEFS[id];
    if (!handlers[id]) continue;
    actions[id] = { label: t(def.labelKey), keys: overrides[id] ?? def.defaultKeys };
  }
  // Titles of the two submenus main builds by hand; the role menus (Edit,
  // Window) carry Electron's own labels.
  const labels = { "menu.file": t("menu.file"), "menu.view": t("menu.view") };

  // Content-addressed, not identity-addressed. Callers build their handler map
  // inline and `overrides`/`t` need not be stable either, so ANY identity-based
  // dep would rebuild the native menu on every render. Serialising says exactly
  // what the sync is for — "the projection changed" — and covers the two real
  // triggers (a locale switch changes the labels, a rebind changes the keys)
  // without naming either.
  const serialized = JSON.stringify({ actions, labels });

  useEffect(() => {
    if (!isMac) return;
    void syncNativeMenu(JSON.parse(serialized) as MenuProjection);
  }, [serialized]);

  useEffect(() => {
    if (!isMac) return;
    let dispose: UnlistenFn | null = null;
    let cancelled = false;
    void listen<{ actionId: MenuActionId }>("menu:action", ({ payload }) => {
      // The dispatcher stands down by NOT calling preventDefault, which is
      // exactly what lets the chord fall through to this menu — so the same
      // guard has to hold here or a suspended action runs anyway.
      if (appActionsSuspended()) return;
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
