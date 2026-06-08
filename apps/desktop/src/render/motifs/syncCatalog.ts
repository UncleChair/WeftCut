// Pulls the backend Motif catalog (built-ins + on-disk user Motifs) over the
// `list_motifs` IPC and registers it into the runtime TS catalog so the
// frame-math (getMotif / resolveMotifContentDurationUs / motifFrameDescriptor)
// sees user Motifs. Built-ins are seeded statically in catalog.ts and stay
// authoritative; this only adds the user layer. Called once at boot (main.tsx)
// and re-callable whenever the catalog changes (later stages).
import { listMotifs as ipcListMotifs } from "../../ipc";
import { setUserMotifs, type MotifManifest } from "./catalog";

export async function syncUserMotifsFromBackend(): Promise<void> {
  try {
    const payload = await ipcListMotifs();
    // The IPC payload is a manifest superset (adds `html`); MotifManifest is a
    // structural subset, so the extra field is harmless. Strip nothing.
    setUserMotifs(payload as unknown as MotifManifest[]);
  } catch {
    // Leave the built-in-only catalog in place; a transient IPC failure must
    // not blank the picker or the frame-math.
  }
}
