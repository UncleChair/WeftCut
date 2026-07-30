// macOS native application menu bridge. The renderer pushes a projection of
// what the current surface can run; main rebuilds the menu from it (see
// src/shared/menu.ts for the contract and why the direction is renderer → main).
import type { MenuProjection } from "../../shared/menu";

export async function syncNativeMenu(projection: MenuProjection): Promise<void> {
  // Fire-and-forget: the native menu is an enhancement, and a failed sync must
  // never take a render pass with it. Off macOS main ignores the call.
  try {
    await window.api.menu.sync(projection);
  } catch (e) {
    console.warn("[weftcut/menu] native menu sync failed:", e);
  }
}
