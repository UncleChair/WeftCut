import { invoke } from "@/bridge/ipc";
import { initEval } from "../eval";
import { MOTIF_RUNTIME_SOURCE } from "../render/motifs/runtime";
import {
  installMotifsChangedListener,
  syncUserMotifsFromBackend,
} from "../render/motifs/syncCatalog";

interface StartupTask {
  id: StartupCheckId;
  name: string;
  run: () => Promise<unknown>;
}

export type StartupCheckId =
  | "evaluation_runtime"
  | "motif_capture_runtime"
  | "motif_catalog"
  | "motif_catalog_listener";

export interface StartupProgress {
  /** Checks that are still running, in stable display order. */
  pending: readonly StartupCheckId[];
  completed: number;
  total: number;
}

export interface RendererInitialization {
  /** Settles after every startup check has completed, failed, or timed out. */
  completion: Promise<void>;
  /** Immediately publishes the latest snapshot, then all subsequent changes. */
  subscribe: (listener: (progress: StartupProgress) => void) => () => void;
}

const STARTUP_TASK_TIMEOUT_MS = 15_000;

/**
 * Renderer systems that must settle before the launch surface can be used.
 *
 * Keep this list as the single startup seam: adding another task here makes
 * the splash hold automatically, without coupling that system to React or to
 * the animation timeline. Tasks run concurrently so the gate adds only the
 * duration of the slowest dependency.
 */
const STARTUP_TASKS: readonly StartupTask[] = [
  {
    id: "evaluation_runtime",
    name: "evaluation runtime",
    run: initEval,
  },
  {
    id: "motif_capture_runtime",
    name: "Motif capture runtime",
    run: () =>
      invoke("motif_register_runtime", { source: MOTIF_RUNTIME_SOURCE }),
  },
  {
    id: "motif_catalog",
    name: "Motif catalog",
    run: syncUserMotifsFromBackend,
  },
  {
    id: "motif_catalog_listener",
    name: "Motif catalog listener",
    run: installMotifsChangedListener,
  },
];

/**
 * Resolve after every renderer startup task has either completed or reported
 * an error. Individual failures are non-fatal, matching the previous startup
 * behaviour: the UI is surfaced so it can explain a degraded subsystem rather
 * than leaving the user behind a permanent splash screen.
 */
export function startRendererInitialization(): RendererInitialization {
  const pending = new Set(STARTUP_TASKS.map((task) => task.id));
  const listeners = new Set<(progress: StartupProgress) => void>();
  let progress = createProgress(pending);

  const notify = (listener: (progress: StartupProgress) => void) => {
    try {
      listener(progress);
    } catch (error) {
      // A presentation subscriber must never change startup settlement.
      console.error("[weftcut/startup] progress listener failed", error);
    }
  };
  const publish = () => {
    progress = createProgress(pending);
    listeners.forEach(notify);
  };

  const completion = Promise.allSettled(
    STARTUP_TASKS.map(async (task) => {
      try {
        return await runStartupTask(task);
      } finally {
        pending.delete(task.id);
        publish();
      }
    }),
  ).then((results) => {
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const task = STARTUP_TASKS[index];
      console.error(
        `[weftcut/startup] ${task?.name ?? "unknown task"} failed`,
        result.reason,
      );
    });
  });

  return {
    completion,
    subscribe(listener) {
      listeners.add(listener);
      notify(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createProgress(
  pending: ReadonlySet<StartupCheckId>,
): StartupProgress {
  const pendingInDisplayOrder = STARTUP_TASKS.flatMap((task) =>
    pending.has(task.id) ? [task.id] : [],
  );
  return {
    pending: pendingInDisplayOrder,
    completed: STARTUP_TASKS.length - pendingInDisplayOrder.length,
    total: STARTUP_TASKS.length,
  };
}

async function runStartupTask(task: StartupTask): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(
        new Error(
          `${task.name} did not settle within ${STARTUP_TASK_TIMEOUT_MS}ms`,
        ),
      );
    }, STARTUP_TASK_TIMEOUT_MS);
  });

  try {
    // Starting through a promise also converts a synchronous throw from a
    // future task adapter into a normal rejected result.
    return await Promise.race([Promise.resolve().then(task.run), timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
