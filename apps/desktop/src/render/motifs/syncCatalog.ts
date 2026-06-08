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
    // The IPC payload is a manifest superset (adds `html`); MotifSummary now
    // declares content_duration_s + settle_rafs so it structurally satisfies
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
