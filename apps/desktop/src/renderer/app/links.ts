/// The project's public web presence. The repo (package.json `homepage`) is
/// the single root; releases / issues hang off it. Used by the Help menu and
/// the About dialog.
export const REPO_URL = "https://github.com/UncleChair/WeftCut";
export const RELEASES_URL = `${REPO_URL}/releases`;
export const ISSUES_URL = `${REPO_URL}/issues`;
/// Repo files referenced from the About dialog (default branch: main).
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const THIRD_PARTY_NOTICES_URL = `${REPO_URL}/blob/main/THIRD-PARTY-NOTICES.md`;

/// Open an external URL in the default browser via the audited `shell:open`
/// IPC (main refuses non-http(s) targets). Fire-and-forget: menu handlers
/// can't await, and a failed open must not wedge the menu.
export function openExternal(url: string): void {
  void window.api.shell.open(url).catch((error: unknown) => {
    console.error("[weftcut/links] failed to open external URL:", error);
  });
}
