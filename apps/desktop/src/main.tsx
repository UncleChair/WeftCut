import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { StartupScreen } from "./startup/StartupScreen";
import { SpikePreview } from "./preview/dom/SpikePreview";
import {
  projectOpen,
  recentsGetReopenOnLaunch,
  recentsMostRecent,
} from "./ipc";
import "./i18n";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

/// Branch-only dev hatch: navigating to `#dom-spike` mounts the Phase A.0
/// spike instead of the normal app tree. Removed at Phase F cutover.
///
/// Tauri webview has no visible URL bar — easiest activation is to open
/// DevTools (F12) and run `__weftDomSpike()`, which sets the hash and
/// reloads. The console hint below makes the function discoverable
/// without having to remember the URL trick.
declare global {
  interface Window {
    __weftDomSpike?: () => void;
  }
}
window.__weftDomSpike = () => {
  window.location.hash = "#dom-spike";
  window.location.reload();
};
// eslint-disable-next-line no-console
console.info(
  "%c[DOM preview spike] %crun %c__weftDomSpike()%c to load — Phase A.0 only, removed at Phase F cutover",
  "color:#3a6;font-weight:bold",
  "color:#aaa",
  "color:#eee;background:#222;padding:2px 4px;border-radius:2px;font-family:monospace",
  "color:#aaa",
);
const isDomSpike = window.location.hash === "#dom-spike";

/// Top-level router per workspace-redesign Q7. The app boots into the
/// StartupScreen by default; once the user picks Create / Open / Recent
/// (or the "Reopen last project on launch" auto-open fires), we flip to
/// the editor. Reverse transition (back to startup) isn't supported yet —
/// quitting and reopening is the natural flow.
function Root() {
  // `boot`: still resolving "reopen on launch" — keep the surface blank for
  // a beat so we don't flash StartupScreen for users who *did* opt into
  // auto-open. `startup`: user must pick. `editor`: workspace is mounted.
  const [stage, setStage] = useState<"boot" | "startup" | "editor">("boot");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const enabled = await recentsGetReopenOnLaunch();
        if (!enabled) {
          if (!cancelled) setStage("startup");
          return;
        }
        const recent = await recentsMostRecent();
        if (!recent) {
          if (!cancelled) setStage("startup");
          return;
        }
        try {
          await projectOpen(recent.path);
          if (!cancelled) setStage("editor");
        } catch (err) {
          console.warn("reopen-on-launch failed; falling back to startup", err);
          if (!cancelled) setStage("startup");
        }
      } catch (err) {
        console.warn("startup pref read failed:", err);
        if (!cancelled) setStage("startup");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onWorkspaceReady = useCallback(() => setStage("editor"), []);
  const onCloseProject = useCallback(() => setStage("startup"), []);

  if (stage === "boot") {
    // Brief — usually one tick — while we're checking the reopen-on-launch
    // pref. Render nothing to avoid flashing the wrong surface.
    return null;
  }
  if (stage === "startup") {
    return <StartupScreen onWorkspaceReady={onWorkspaceReady} />;
  }
  return <App onCloseProject={onCloseProject} />;
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {isDomSpike ? <SpikePreview /> : <Root />}
  </React.StrictMode>,
);
