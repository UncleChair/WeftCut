// Renderer mirror of the two proxy-preference ProjectSettings fields
// (prefer_proxies + proxy_overrides). PixiPreview reads it live per
// ensureClip; the UI subscribes via atomic selectors. Setters write
// through the unrecorded update_project_settings mutation, then update
// the store optimistically (updateProjectSettings returns void). Follows
// the appSettingsStore pattern. See docs/preview.md §Proxies.

import { create } from "zustand";

import { getProjectSettings, updateProjectSettings } from "../ipc";
import { useProjectStore } from "./projectStore";

interface ProxyPrefState {
  preferProxies: boolean;
  overrides: Record<string, boolean>;
  hydrate: (v: { preferProxies: boolean; overrides: Record<string, boolean> }) => void;
}

export const useProxyPrefStore = create<ProxyPrefState>((set) => ({
  preferProxies: false,
  overrides: {},
  hydrate: (v) => set({ preferProxies: v.preferProxies, overrides: v.overrides }),
}));

/** Effective per-clip intent: a per-clip override wins over the global toggle. */
export function proxyIntent(mediaId: string): boolean {
  const s = useProxyPrefStore.getState();
  return s.overrides[mediaId] ?? s.preferProxies;
}

export async function setPreferProxies(v: boolean): Promise<void> {
  await updateProjectSettings({ prefer_proxies: v });
  useProxyPrefStore.setState({ preferProxies: v });
}

export async function setProxyOverride(mediaId: string, value: boolean | null): Promise<void> {
  await updateProjectSettings({ proxy_override: { media_id: mediaId, value } });
  useProxyPrefStore.setState((s) => {
    const overrides = { ...s.overrides };
    if (value === null) delete overrides[mediaId];
    else overrides[mediaId] = value;
    return { overrides };
  });
}

async function rehydrate(): Promise<void> {
  try {
    const v = await getProjectSettings();
    useProxyPrefStore.getState().hydrate({ preferProxies: v.prefer_proxies, overrides: v.proxy_overrides });
  } catch {
    // No project loaded yet — keep defaults.
  }
}

/** Hydrate on mount and re-hydrate whenever the project summary swaps
 *  (new project / reload). Call once from App.tsx; returns an unsubscribe. */
export function wireProxyPrefStore(): () => void {
  void rehydrate();
  return useProjectStore.subscribe((s, prev) => {
    if (s.summary !== prev.summary) void rehydrate();
  });
}
