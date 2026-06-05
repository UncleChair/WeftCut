import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { StartupScreen } from "./startup/StartupScreen";
import {
  projectOpen,
  recentsGetReopenOnLaunch,
  recentsMostRecent,
} from "./ipc";
import "./i18n";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

// Phase A.0 / H.0 dev-spike hatches removed in P12-e along with the
// legacy DOM preview. The Pixi compositor is the only preview surface
// now.

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

  // E2E-only: expose `window.__weftcutTest.newProjectAndEnter` so the WebDriver
  // suite can create a project + enter the editor headlessly. The dynamic
  // import behind the static `VITE_WEFTCUT_E2E` check is stripped from prod.
  useEffect(() => {
    if (import.meta.env.VITE_WEFTCUT_E2E !== "1") return;
    void import("./testhook/e2eHook").then(
      ({ installBootstrapHook, installTemplateHarnessHook }) => {
        installBootstrapHook(() => setStage("editor"));
        installTemplateHarnessHook();
      },
    );
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
    <Root />
  </React.StrictMode>,
);
