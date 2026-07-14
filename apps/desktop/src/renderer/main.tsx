// NOTE: do NOT import "pixi.js/unsafe-eval" here. Its no-eval shader polyfill
// renders every filtered object EMPTY on the WebGPU backend (the per-layer
// effects subsystem would be dead on the preview). We instead let PixiJS use
// its real `new Function()` codegen and allow `'unsafe-eval'` in the packaged
// CSP (see electron.vite.config.ts). Filters then work on WebGPU + WebGL alike.
import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@/bridge/ipc";
import { getCurrentWindow } from "@/bridge/window";
import { App } from "./App";
import { StartupScreen } from "./startup/StartupScreen";
import { SplashScreen } from "./startup/SplashScreen";
import { PerfHUDWindow } from "./render/PerfHUD";
import {
  projectOpen,
  recentsGetReopenOnLaunch,
  recentsMostRecent,
} from "./ipc";
import { MOTIF_RUNTIME_SOURCE } from "./render/motifs/runtime";
import { syncUserMotifsFromBackend, installMotifsChangedListener } from "./render/motifs/syncCatalog";
import { initEval } from "./eval";
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

// The Pixi compositor is the only preview surface.

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
  const [splashVisible, setSplashVisible] = useState(true);

  // The main BrowserWindow is frameless, so draw a subtle inner edge in the
  // renderer to keep the dark surface legible against dark desktops and
  // overlapping windows. Window state lives on <html> so the frame spans the
  // startup, editor, agent, and splash surfaces without affecting layout.
  useEffect(() => {
    const rootElement = document.documentElement;
    const currentWindow = getCurrentWindow();
    let cancelled = false;

    const setFocused = () => rootElement.classList.remove("app-window-inactive");
    const setInactive = () => rootElement.classList.add("app-window-inactive");
    const setMaximized = (maximized: boolean) => {
      rootElement.classList.toggle("app-window-maximized", maximized);
    };

    rootElement.classList.add("app-window-framed");
    rootElement.classList.toggle("app-window-inactive", !document.hasFocus());
    void currentWindow.isMaximized().then((maximized) => {
      if (!cancelled) setMaximized(maximized);
    });
    const unlisten = currentWindow.onMaximizeChange((maximized) => {
      if (!cancelled) setMaximized(maximized);
    });
    window.addEventListener("focus", setFocused);
    window.addEventListener("blur", setInactive);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", setFocused);
      window.removeEventListener("blur", setInactive);
      void unlisten.then((dispose) => dispose());
      rootElement.classList.remove(
        "app-window-framed",
        "app-window-inactive",
        "app-window-maximized",
      );
    };
  }, []);

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

  // E2E-only: expose `window.__weftcutTest.newProjectAndEnter` so the E2E
  // suite can create a project + enter the editor headlessly. The dynamic
  // import behind the static `VITE_WEFTCUT_E2E` check is stripped from prod.
  useEffect(() => {
    if (import.meta.env.VITE_WEFTCUT_E2E !== "1") return;
    void import("./testhook/e2eHook").then(
      ({ installBootstrapHook, installMotifTestHooks, installMotifHook, installAudioTestHooks, installDecodeBenchHooks }) => {
        installBootstrapHook(
          () => setStage("editor"),
          () => setStage("startup"),
        );
        installMotifTestHooks();
        installMotifHook();
        installAudioTestHooks();
        installDecodeBenchHooks();
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
  const onSplashComplete = useCallback(() => setSplashVisible(false), []);

  // Boot resolution runs behind the launch animation. In the usual case the
  // destination is ready before the mark finishes, so the transition is
  // immediate and the splash does not add IPC time to startup.
  return (
    <>
      {stage === "startup" && (
        <StartupScreen onWorkspaceReady={onWorkspaceReady} />
      )}
      {stage === "editor" && <App onCloseProject={onCloseProject} />}
      {(splashVisible || stage === "boot") && (
        <SplashScreen onComplete={onSplashComplete} />
      )}
      {import.meta.env.DEV && !splashVisible && stage !== "boot" && (
        <button
          type="button"
          className="dev-splash-replay"
          onClick={() => setSplashVisible(true)}
          title="Replay splash animation"
        >
          <span aria-hidden="true">↻</span>
          Replay splash
        </button>
      )}
    </>
  );
}

function mount() {
  ReactDOM.createRoot(root!).render(
    <React.StrictMode>
      {isPerfHudWindow ? <PerfHUDWindow /> : <Root />}
    </React.StrictMode>,
  );
}

// Load the shared weftcut-eval wasm before mounting so the first composite /
// preview frame resolves snap + keyframes synchronously (the renderer's
// frames.ts / render/animated.ts call it). Chained off the promise rather than a
// top-level await to dodge the Vite production top-level-await gotcha. Mount even
// if init fails, so the failure surfaces in the UI instead of a blank window.
void initEval()
  .catch((err) => console.error("eval wasm init failed; eval calls will throw until reload", err))
  .finally(mount);
