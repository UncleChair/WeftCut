import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initEval: vi.fn(),
  invoke: vi.fn(),
  syncUserMotifsFromBackend: vi.fn(),
  installMotifsChangedListener: vi.fn(),
}));

vi.mock("@/bridge/ipc", () => ({ invoke: mocks.invoke }));
vi.mock("../eval", () => ({ initEval: mocks.initEval }));
vi.mock("../render/motifs/runtime", () => ({
  MOTIF_RUNTIME_SOURCE: "runtime source",
}));
vi.mock("../render/motifs/syncCatalog", () => ({
  syncUserMotifsFromBackend: mocks.syncUserMotifsFromBackend,
  installMotifsChangedListener: mocks.installMotifsChangedListener,
}));

import { startRendererInitialization } from "./initializeRenderer";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.initEval.mockResolvedValue(undefined);
  mocks.invoke.mockResolvedValue(undefined);
  mocks.syncUserMotifsFromBackend.mockResolvedValue(undefined);
  mocks.installMotifsChangedListener.mockResolvedValue(() => {});
});

describe("startRendererInitialization", () => {
  it("starts systems concurrently, publishes progress, and waits for the slowest one", async () => {
    let finishEval!: () => void;
    mocks.initEval.mockReturnValue(
      new Promise<void>((resolve) => {
        finishEval = resolve;
      }),
    );

    let settled = false;
    const progress: Array<{
      pending: readonly string[];
      completed: number;
      total: number;
    }> = [];
    const initialization = startRendererInitialization();
    const unsubscribe = initialization.subscribe((snapshot) => {
      progress.push(snapshot);
    });
    const completion = initialization.completion.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(mocks.initEval).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("motif_register_runtime", {
      source: "runtime source",
    });
    expect(mocks.syncUserMotifsFromBackend).toHaveBeenCalledOnce();
    expect(mocks.installMotifsChangedListener).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(progress[0]).toEqual({
      pending: [
        "evaluation_runtime",
        "motif_capture_runtime",
        "motif_catalog",
        "motif_catalog_listener",
      ],
      completed: 0,
      total: 4,
    });

    finishEval();
    await completion;
    expect(settled).toBe(true);
    expect(progress.at(-1)).toEqual({ pending: [], completed: 4, total: 4 });
    unsubscribe();
  });

  it("reports a failed subsystem and still opens the startup gate", async () => {
    const error = new Error("catalog unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.syncUserMotifsFromBackend.mockRejectedValue(error);

    await expect(
      startRendererInitialization().completion,
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "[weftcut/startup] Motif catalog failed",
      error,
    );
    consoleError.mockRestore();
  });
});
