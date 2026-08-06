// Pulls the backend Motif catalog (built-ins + on-disk user Motifs) over the
// `list_motifs` IPC and registers it into the runtime TS catalog so the
// frame-math (getMotif / resolveMotifContentDurationUs / motifFrameDescriptor)
// sees user Motifs. Built-ins are seeded statically in catalog.ts and stay
// authoritative; this only adds the user layer. Called once at boot
// (startup/initializeRenderer.ts) and re-callable whenever the catalog changes.
import { listen } from "@/bridge/events";
import { listMotifs as ipcListMotifs, MOTIFS_CHANGED_EVENT } from "../../ipc";
import { setUserMotifs, type MotifManifest } from "./catalog";

export async function syncUserMotifsFromBackend(): Promise<void> {
  try {
    const payload = await ipcListMotifs();
    // The IPC payload is a manifest superset (adds `html`); MotifSummary
    // declares content_duration_s + settle_rafs, so it structurally satisfies
    // MotifManifest. The extra `html` field on live wire values is harmless —
    // setUserMotifs only reads manifest fields. Strip nothing.
    setUserMotifs(payload as MotifManifest[]);
  } catch (e) {
    // Leave the built-in-only catalog in place; a transient IPC failure must
    // not blank the picker or the frame-math.
    // eslint-disable-next-line no-console
    console.warn("[weftcut/motifs] syncUserMotifsFromBackend failed; keeping built-in-only catalog", e);
  }
}

/// Subscribe to backend `motifs:changed` events and re-pull the catalog so a
/// just-created/installed/deleted Motif is immediately resolvable by the
/// frame-math. Returns the unlisten fn.
export async function installMotifsChangedListener(): Promise<() => void> {
  return listen(MOTIFS_CHANGED_EVENT, () => {
    void syncUserMotifsFromBackend();
  });
}
