// Tiny React error boundary scoped to the PixiJS preview surface.
// A PixiJS shader crash, WebGL context loss, or downstream throw
// inside `PixiPreview` would otherwise propagate up to App and
// unmount the entire editor. The boundary catches it and renders a
// visible error so the rest of the UI stays alive.
//
// Plan: docs/pixi-renderer-plan.md (P2)

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class PixiErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("[weftcut/pixi] error boundary caught:", error, info);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div
          style={{
            position: "relative",
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#1f2937",
            color: "#ffb4b4",
            font: "13px ui-monospace, monospace",
            padding: "16px",
            textAlign: "center",
          }}
        >
          <div>
            <div style={{ marginBottom: 8, opacity: 0.7 }}>
              PixiJS preview crashed — falling back to error display.
            </div>
            <div style={{ wordBreak: "break-word" }}>
              {error.name}: {error.message}
            </div>
            <div style={{ marginTop: 12, fontSize: 11, opacity: 0.5 }}>
              Remove the <code>?pixi=1</code> flag (or{" "}
              <code>localStorage.removeItem(&quot;weftcut.preview.pixi&quot;)</code>) to
              return to the legacy preview.
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
