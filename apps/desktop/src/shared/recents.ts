// Recent-project entry type shared by the Electron main process (owner of
// persistence) and the renderer (consumer via ipc). One definition → no
// main↔renderer drift. Field names are snake_case to match the on-disk JSON
// shape written historically by the Rust addon, so existing users'
// recents.json keeps working after the move to TS.

export interface RecentEntry {
  path: string;
  name: string;
  /** ISO-8601 timestamp — e.g. "2026-06-27T12:00:00.000Z". */
  last_opened: string;
}
