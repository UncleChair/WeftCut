import { listen } from "@/bridge/events";
import { getCurrentWindow } from "@/bridge/window";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AGENT_SESSION_EVENTS,
  agentSessionBegin,
  agentSessionEnd,
  agentSessionGet,
  keybindingsGet,
  type AgentSession,
  type KeybindingsMap,
  motifStalenessReport,
  type MotifStaleEntry,
  ping,
} from "../ipc";
import { wireLogStream } from "../logs/store";
import { wireSearchIndex } from "../search/searchIndexStore";
import { wireProjectStore } from "../state/projectStore";
import { wireProxyPrefStore } from "../state/proxyPreferenceStore";
import { wireAppSettingsStream } from "../settings/appSettingsStore";
import { wireDecodeComponent } from "../settings/decodeComponentStore";

/// Owns the App-root backend wiring: the pong healthcheck, keybindings +
/// agent-session state (seeded on mount, kept live via
/// `agent_session:changed`), the on-open stale-motifs pull, and the
/// stream-wiring effects (status log, project-state mirror, app-settings,
/// and the `project:changed` → refresh subscription). `refresh` arrives from
/// App via `deps` — App still owns the callback itself since the R.7
/// effects and the save handlers also call it directly.
export function useAppWiring(deps: { refresh: () => Promise<void> }): {
  pong: string;
  keybindings: KeybindingsMap;
  setKeybindings: React.Dispatch<React.SetStateAction<KeybindingsMap>>;
  agentSession: AgentSession | null;
  exitAgentMode: () => Promise<void>;
  enterAgentMode: (reason: string) => Promise<void>;
  staleMotifs: MotifStaleEntry[];
  setStaleMotifs: React.Dispatch<React.SetStateAction<MotifStaleEntry[]>>;
} {
  const { refresh } = deps;
  const [pong, setPong] = useState<string>("…");
  // User shortcut overrides. Loaded once on mount; refreshed when the
  // Settings → Keyboard panel writes (it calls back via the
  // `onKeybindingsChanged` prop). The map is `Record<string, string[]>`
  // on the wire; we widen-cast into `OverrideMap` since the frontend
  // catalogue (`ACTION_DEFS`) is the validator. Unknown action ids in
  // the file are silently ignored at dispatch time.
  const [keybindings, setKeybindings] = useState<KeybindingsMap>({});
  // Active agent session (null = editor mode). Set by the
  // `agent_session:changed` event the backend emits whenever an MCP
  // client calls `begin_agent_session` or any path clears the slot
  // (workspace change, user-side exit). Always seeded by an explicit
  // get on mount so the UI never blinks through the wrong mode on
  // app start.
  const [agentSession, setAgentSession] = useState<AgentSession | null>(null);

  // §7-B on-open staleness: App mounts exactly once per successful project
  // open (every open path remounts it), so a mount-time pull IS the
  // once-per-open check. Read-only; the ack happens on dismiss.
  const [staleMotifs, setStaleMotifs] = useState<MotifStaleEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    void motifStalenessReport()
      .then((r) => {
        if (!cancelled && r.length > 0) setStaleMotifs(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    ping().then(setPong).catch((e) => setPong(`error: ${String(e)}`));
    refresh();
    keybindingsGet().then(setKeybindings).catch(() => {});
    // Seed agent-session mode explicitly so the UI never flashes through
    // editor mode on a fresh app start when an MCP client has already
    // begun a session (e.g., on app re-launch via deeplink in the
    // future). Subsequent flips arrive via the agent_session:changed
    // event below.
    agentSessionGet().then(setAgentSession).catch(() => {});
  }, [refresh]);

  // Subscribe to agent_session:changed — payload is `AgentSession | null`.
  // Begin / replace / end all flow through here so the conditional render
  // below stays in sync with the backend slot.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await listen<AgentSession | null>(
        AGENT_SESSION_EVENTS.changed,
        (e) => setAgentSession(e.payload),
      );
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const exitAgentMode = useCallback(async () => {
    try {
      await agentSessionEnd();
    } catch (e) {
      console.warn("agent_session_end failed:", e);
    }
  }, []);

  const enterAgentMode = useCallback(async (reason: string) => {
    try {
      await agentSessionBegin(reason);
    } catch (e) {
      console.warn("agent_session_begin failed:", e);
    }
  }, []);

  // Wire the status-log stream: seed from `log_list`, then subscribe to
  // `log:entry` events. Pre-workspace this is a no-op (backend bus is
  // None). The Zustand store backs the status bar's selectors.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await wireLogStream();
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Project state mirror for the Pixi preview (docs/preview.md). Coexists
  // with the local-state fetches below — both subscribe to `project:changed`
  // and re-fetch, with no cross-talk. The Pixi preview engine reads from
  // `useProjectStore`; App.tsx's own fetches still drive the panels.
  // The search index rides along on the same effect: it reads
  // `useProjectStore`'s summary, so it wires right after the store itself
  // is live.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unwireSearch: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await wireProjectStore();
      const unwire = wireSearchIndex();
      if (cancelled) {
        u();
        unwire();
        return;
      }
      unlisten = u;
      unwireSearch = unwire;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (unwireSearch) unwireSearch();
    };
  }, []);

  // App-level settings stream (`docs/data-model.md`). Seeds the store
  // from the current value, then subscribes to `app_settings:changed`
  // so any pill/menu/shortcut flip propagates to every consumer (the
  // timeline filter, the right panel's peek-window width, and settings UI).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await wireAppSettingsStream();
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Proxy-preference mirror (prefer_proxies + proxy_overrides). Hydrates
  // immediately and re-hydrates whenever the project summary swaps (new
  // project / reload) — see `state/proxyPreferenceStore.ts`. Unlike the
  // other stream wirings above, `wireProxyPrefStore` is synchronous (it
  // fires the initial fetch fire-and-forget and returns the project-store
  // unsubscribe immediately), so no cancelled/async dance is needed.
  useEffect(() => {
    return wireProxyPrefStore();
  }, []);

  // Native-decode component availability (level-0 gate). Pulled once on mount;
  // availability is fixed for a process lifetime (the require is memoized in
  // main), so this is fire-and-forget — no subscription, no unlisten.
  useEffect(() => {
    void wireDecodeComponent();
  }, []);

  // Project-change subscription — fired by the actor whenever a commit lands,
  // regardless of source (UI command, MCP tool call, undo/redo, checkpoint
  // restore). Without this, MCP-driven edits land in state but the panels
  // stay frozen until the user clicks something.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const u = await listen<unknown>("project:changed", () => {
        refresh();
      });
      if (cancelled) {
        u();
        return;
      }
      unlisten = u;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh]);

  return {
    pong,
    keybindings,
    setKeybindings,
    agentSession,
    exitAgentMode,
    enterAgentMode,
    staleMotifs,
    setStaleMotifs,
  };
}

/// OS window-title binding.
export function useWindowTitle(projectName: string | null | undefined): void {
  const { t, i18n } = useTranslation();
  // Bind the OS window title to the project name (AE-style: the
  // project's identity lives in the window chrome, not in an in-app
  // bar). Falls back to the bare app title when no project is loaded
  // yet. Re-runs on locale flip so the dash / phrasing follows the
  // user's language preference. Resets to the bare title on unmount
  // (Save and Close) so the StartupScreen doesn't inherit a stale
  // project name in the OS title bar.
  useEffect(() => {
    const win = getCurrentWindow();
    const next = projectName
      ? t("app.window_title", { name: projectName })
      : t("app.title");
    void win.setTitle(next).catch(() => {});
  }, [projectName, i18n.resolvedLanguage, t]);
  useEffect(() => {
    return () => {
      void getCurrentWindow().setTitle("WeftCut").catch(() => {});
    };
  }, []);
}
