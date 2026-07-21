// Dedicated Worker that runs the issue-#7-boundary-#1 import probe in a Worker
// context — the export bug's ACTUAL context (exportWorker.ts). The e2e hook
// (`installDecodeBenchHooks`) spawns this alongside a main-thread run so the spec
// can compare the two: if the direct 2D `drawImage` of a HW frame is black in
// the Worker but not on the main thread, the bug is Worker-scoped. See
// importProbe.ts for the full rationale.

import { probeBothModes, type BothModesResult } from "./importProbe";

interface ProbeRequest {
  assetUrl: string;
}
export type ProbeWorkerResponse =
  | { ok: true; result: BothModesResult }
  | { ok: false; error: string };

self.onmessage = (e: MessageEvent<ProbeRequest>) => {
  const { assetUrl } = e.data;
  probeBothModes(assetUrl).then(
    (result) => (self as unknown as { postMessage: (m: ProbeWorkerResponse) => void }).postMessage({ ok: true, result }),
    (err: unknown) =>
      (self as unknown as { postMessage: (m: ProbeWorkerResponse) => void }).postMessage({
        ok: false,
        error: String(err),
      }),
  );
};
