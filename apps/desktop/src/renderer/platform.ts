// Renderer-side platform detection, cached at module load (users don't migrate
// OS mid-session). `navigator.platform` is deprecated but still populated in
// Electron's Chromium engine; the userAgent fallback catches the rest. Shared
// so the shortcut formatter and the window chrome agree on one source of truth.
export const isMac: boolean = (() => {
  if (typeof navigator === "undefined") return false;
  const p = (navigator as Navigator).platform || "";
  const ua = (navigator as Navigator).userAgent || "";
  return /Mac|iPhone|iPad|iPod/.test(p) || /Macintosh/.test(ua);
})();

/// Coarse OS classification for platform-gated policies (e.g. the export
/// HW-decode allowlist in exportDecodeRouting.ts). "linux" doubles as the
/// verdict for anything unrecognized — every current policy treats unknown
/// and Linux identically (take the conservative path).
export type RendererOS = "windows" | "mac" | "linux";

/// Pure classifier over the two navigator signals, split out so tests can
/// exercise the matrix without a DOM.
export function classifyOS(platform: string, userAgent: string): RendererOS {
  if (/^Win/i.test(platform) || /Windows/.test(userAgent)) return "windows";
  if (/Mac|iPhone|iPad|iPod/.test(platform) || /Macintosh/.test(userAgent)) return "mac";
  return "linux";
}

export const rendererOS: RendererOS =
  typeof navigator === "undefined"
    ? "linux"
    : classifyOS(
        (navigator as Navigator).platform || "",
        (navigator as Navigator).userAgent || "",
      );
