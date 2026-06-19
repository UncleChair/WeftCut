// MUST be first: PixiJS uses `new Function()` for shader/uniform codegen, which
// the packaged renderer's Content-Security-Policy (no `unsafe-eval`; see
// electron.vite.config.ts) blocks — the live Pixi preview would fail to init.
// This side-effect import installs static no-eval polyfills and must run before
// any renderer is created (@pixi/react Application). The export worker isn't
// under the document CSP, so it doesn't need this.
import "pixi.js/unsafe-eval";
import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@/bridge/ipc";
import { getCurrentWindow } from "@/bridge/window";
import { App } from "./App";
import { StartupScreen } from "./startup/StartupScreen";
import { PerfHUDWindow } from "./render/PerfHUD";
import {
  projectOpen,
  recentsGetReopenOnLaunch,
  recentsMostRecent,
} from "./ipc";
import { MOTIF_RUNTIME_SOURCE } from "./render/motifs/runtime";
import { syncUserMotifsFromBackend, installMotifsChangedListener } from "./render/motifs/syncCatalog";
import "./i18n";
// Tailwind entry first; styles.css stays unlayered so its legacy rules win
// over Tailwind's layered output wherever both match (see app.css header).
import "./app.css";
import "./styles.css";

const isPerfHudWindow = new URLSearchParams(window.location.search).get("perfHud") === "1";

// Motifs: hand the clock-takeover runtime source to Rust once at boot so the
// hidden Motif host window can inject it as its `initialization_script`.
// Fire-and-forget — the capture command errors clearly if this hasn't landed.
if (!isPerfHudWindow) {
  void invoke("motif_register_runtime", { source: MOTIF_RUNTIME_SOURCE });
}
// Populate the runtime Motif catalog (built-ins + on-disk user Motifs) so the
// frame-math and picker see user Motifs. Fire-and-forget; failures keep the
// built-in-only catalog.
if (!isPerfHudWindow) {
  void syncUserMotifsFromBackend();
}
// Keep the runtime Motif catalog fresh as drafts are written/installed/deleted.
if (!isPerfHudWindow) {
  void installMotifsChangedListener();
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

// Production: suppress the Chromium/Electron default context menu (reload / print /
// inspect) except over editable or copyable content, where the native
// cut/copy/paste menu stays useful. The app's own context menus (timeline
// layers) preventDefault on their targets either way. Dev keeps the default
// menu for right-click → Inspect.
if (!import.meta.env.DEV) {
  document.addEventListener("contextmenu", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (
      t?.closest(
        "input, textarea, [contenteditable], .connect-value, .connect-snippet pre, .log-message, .log-details-json",
      )
    ) {
      return;
    }
    e.preventDefault();
  });
}

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
      ({ installBootstrapHook, installMotifTestHooks, installMotifHook }) => {
        installBootstrapHook(
          () => setStage("editor"),
          () => setStage("startup"),
        );
        installMotifTestHooks();
        installMotifHook();
      },
    );
  }, []);

  // Flash-free startup: the Electron main window is created hidden (the main
  // process withholds show until the renderer signals ready) and revealed on
  // the first painted frame after the boot stage resolves — the user never
  // sees an unpainted surface. show() on an already-visible window is a no-op,
  // so later stage flips don't matter.
  useEffect(() => {
    if (stage === "boot") return;
    const id = requestAnimationFrame(() => {
      void getCurrentWindow().show();
    });
    return () => cancelAnimationFrame(id);
  }, [stage]);
  // Safety net: if boot wedges before the stage resolves (IPC hang), surface
  // the window anyway so the failure is visible instead of a ghost process.
  useEffect(() => {
    const t = window.setTimeout(() => {
      void getCurrentWindow().show();
    }, 3000);
    return () => window.clearTimeout(t);
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
    {isPerfHudWindow ? <PerfHUDWindow /> : <Root />}
  </React.StrictMode>,
);
