// NOTE: do NOT import "pixi.js/unsafe-eval" here. Its no-eval shader polyfill
// renders every filtered object EMPTY on the WebGPU backend (the per-layer
// effects subsystem would be dead on the preview). We instead let PixiJS use
// its real `new Function()` codegen and allow `'unsafe-eval'` in the packaged
// CSP (see electron.vite.config.ts). Filters then work on WebGPU + WebGL alike.
import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@/bridge/window";
import { App } from "./App";
import { StartupScreen } from "./startup/StartupScreen";
import { SplashScreen } from "./startup/SplashScreen";
import {
  startRendererInitialization,
  type StartupProgress,
} from "./startup/initializeRenderer";
import { PerformanceMonitorWindow } from "./render/PerfHUD";
import {
  projectOpen,
  recentsGetReopenOnLaunch,
  recentsMostRecent,
} from "./ipc";
import { initEval } from "./eval";
import { isMac } from "./platform";
import "./i18n";
// Tailwind entry first; styles.css stays unlayered so its legacy rules win
// over Tailwind's layered output wherever both match (see app.css header).
import "./app.css";
import "./styles.css";

const isPerfHudWindow = new URLSearchParams(window.location.search).get("perfHud") === "1";
const showSplashDebugControl =
  import.meta.env.DEV || import.meta.env.VITE_WEFTCUT_E2E === "1";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

// macOS uses `titleBarStyle: 'hidden'`, so the window keeps the OS-drawn traffic
// lights and its native rounded frame. Tag <html> for the chrome that differs on
// that basis (base.css suppresses the self-drawn window edge). The titlebar
// insets do NOT use this class — they read env(titlebar-area-*), which is empty
// off macOS, so those rules stay platform-agnostic.
// Applies to every renderer surface (main + Performance Monitor) that shares this bundle.
if (isMac) document.documentElement.classList.add("platform-mac");

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
        "input, textarea, [contenteditable], .connect-snippet pre, .log-message, .log-details-json",
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
  const [systemsReady, setSystemsReady] = useState(false);
  const [startupProgress, setStartupProgress] =
    useState<StartupProgress | null>(null);
  const [splashVisible, setSplashVisible] = useState(true);
  const [devSplashHeld, setDevSplashHeld] = useState(false);

  useEffect(() => {
    const initialization = rendererInitialization;
    if (!initialization) return;
    let cancelled = false;
    const unsubscribe = initialization.subscribe((progress) => {
      if (!cancelled) setStartupProgress(progress);
    });
    void initialization.completion.then(() => {
      if (!cancelled) setSystemsReady(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

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
    const setFullscreen = (fullscreen: boolean) => {
      rootElement.classList.toggle("app-window-fullscreen", fullscreen);
    };

    rootElement.classList.add("app-window-framed");
    rootElement.classList.toggle("app-window-inactive", !document.hasFocus());
    void currentWindow.isMaximized().then((maximized) => {
      if (!cancelled) setMaximized(maximized);
    });
    const unlisten = currentWindow.onMaximizeChange((maximized) => {
      if (!cancelled) setMaximized(maximized);
    });
    // Only enter/leave transitions are tracked — no initial query, because the
    // one state this class drives (the self-drawn edge) can't be wrong at boot:
    // a window CAN now be restored straight into fullscreen, but only on macOS
    // (sanitizeGeometry forces fullScreen false elsewhere), and macOS suppresses
    // the self-drawn edge entirely in favour of the native frame. The
    // traffic-light inset is not involved — that reads env(titlebar-area-*),
    // which is already correct on the first paint.
    const unlistenFullscreen = currentWindow.onFullscreenChange((fullscreen) => {
      if (!cancelled) setFullscreen(fullscreen);
    });
    window.addEventListener("focus", setFocused);
    window.addEventListener("blur", setInactive);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", setFocused);
      window.removeEventListener("blur", setInactive);
      void unlisten.then((dispose) => dispose());
      void unlistenFullscreen.then((dispose) => dispose());
      rootElement.classList.remove(
        "app-window-framed",
        "app-window-inactive",
        "app-window-maximized",
        "app-window-fullscreen",
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
  // the splash's first painted frame. Initialization now runs behind that
  // visible animation instead of delaying the renderer mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      void getCurrentWindow().show();
    });
    return () => cancelAnimationFrame(id);
  }, []);
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
  const onSplashComplete = useCallback(() => {
    setSplashVisible(false);
    setDevSplashHeld(false);
  }, []);
  const toggleDevSplash = useCallback(() => {
    if (splashVisible) {
      setSplashVisible(false);
      setDevSplashHeld(false);
      return;
    }
    setDevSplashHeld(true);
    setSplashVisible(true);
  }, [splashVisible]);
  const launchReady = systemsReady && stage !== "boot";

  // Route resolution and system initialization run behind the launch motion.
  // The splash owns its minimum display time and holds its completed mark when
  // either dependency is slower, then performs the exit once both are ready.
  return (
    <>
      {launchReady && stage === "startup" && (
        <StartupScreen onWorkspaceReady={onWorkspaceReady} />
      )}
      {launchReady && stage === "editor" && (
        <App onCloseProject={onCloseProject} />
      )}
      {(splashVisible || !launchReady) && (
        <SplashScreen
          ready={launchReady}
          autoComplete={!devSplashHeld}
          startupProgress={startupProgress}
          routePending={stage === "boot"}
          onComplete={onSplashComplete}
        />
      )}
      {showSplashDebugControl && launchReady && (
        <button
          type="button"
          className="dev-splash-toggle"
          onClick={toggleDevSplash}
          title={
            splashVisible ? "Exit splash animation" : "Play splash animation"
          }
          aria-pressed={splashVisible}
        >
          <span aria-hidden="true">{splashVisible ? "×" : "▶"}</span>
          {splashVisible ? "Exit splash" : "Play splash"}
        </button>
      )}
    </>
  );
}

function mount() {
  ReactDOM.createRoot(root!).render(
    <React.StrictMode>
      {isPerfHudWindow ? <PerformanceMonitorWindow /> : <Root />}
    </React.StrictMode>,
  );
}

// Main-window initialization begins before React mounts, then settles behind
// the splash. The Performance Monitor keeps a lightweight route and does not
// initialize main-window-only Motif systems.
const rendererInitialization = isPerfHudWindow
  ? null
  : startRendererInitialization();
const perfHudInitialization = isPerfHudWindow
  ? initEval().catch((err) =>
      console.error(
        "eval wasm init failed; eval calls will throw until reload",
        err,
      ),
    )
  : null;

if (isPerfHudWindow) {
  void perfHudInitialization!.finally(mount);
} else {
  mount();
}
