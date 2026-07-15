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
