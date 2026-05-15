// Phase B1 dev-mode gate.
//
// Returns true when the WebCodecs smoke preview (`RealtimePreview`)
// should replace the standard `<PreviewSurface>`. Two activation paths
// (either works):
//
//   1. URL query string:  `?previewMode=realtime`
//   2. localStorage:      `localStorage.setItem("weftcut:previewMode",
//                          "realtime"); location.reload();`
//
// localStorage is the practical method during dev — Tauri's devUrl
// doesn't carry query strings cleanly. The user-facing
// Auto/Real-time/Cached preference lands in B4 and supersedes this.
const KEY = "weftcut:previewMode";

export function isRealtimeDevMode(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("previewMode") === "realtime") return true;
  } catch {
    // window.location.search can be unavailable in non-browser test envs.
  }
  try {
    if (window.localStorage.getItem(KEY) === "realtime") return true;
  } catch {
    // localStorage can be blocked under sandbox settings; non-fatal.
  }
  return false;
}
