// Replaces @tauri-apps/plugin-shell.
// Imports seen in src/: open (as openInShell) from LogConsole.tsx
// In S1 this invokes the stub; the log-console "open in shell" button fails
// silently (which is fine — no backend).

export async function open(target: string): Promise<void> {
  await window.api.invoke('shell:open', { target })
}
