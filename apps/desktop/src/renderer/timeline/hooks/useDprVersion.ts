import { useEffect, useState } from "react";

/// Bumps once per devicePixelRatio change (e.g. dragging a maximized window
/// across monitors with different scale factors) so tile canvases redraw at
/// the new backing resolution. The `matchMedia` query string embeds the OLD
/// dpr, so it stops matching after the change fires; each firing re-arms a
/// fresh query for the new dpr. Feature-detected: no-op (and no crash) in
/// test/jsdom environments that don't implement `matchMedia`.
export function useDprVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    let disposed = false;
    let mql: MediaQueryList | null = null;
    const onChange = () => {
      mql?.removeEventListener("change", onChange);
      if (!disposed) setVersion((v) => v + 1);
      arm();
    };
    function arm() {
      if (disposed) return;
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener("change", onChange);
    }
    arm();
    return () => {
      disposed = true;
      mql?.removeEventListener("change", onChange);
    };
  }, []);
  return version;
}
