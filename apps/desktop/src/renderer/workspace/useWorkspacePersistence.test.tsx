// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspacePersistence } from "./useWorkspacePersistence";
import {
  EMPTY_DOCK_WORKSPACE_SNAPSHOT,
  type DockWorkspaceController,
} from "./dockWorkspaceAdapter";
import type { WeftCutLayout } from "./workspaceLayout";
import {
  EDITING_WORKSPACE_ID,
  isBuiltinWorkspace,
  workspaceDocumentDefaults,
  type WorkspaceDocument,
  type WorkspaceProfile,
} from "../../shared/workspace";

// A minimal in-memory stand-in for the main-process store, mirroring its
// profile-CRUD semantics — the real store (main/workspace.ts) is unit-tested on
// its own; here it just gives the hook realistic documents to orchestrate over.
interface FakeStore {
  get(): WorkspaceDocument;
  setCurrent(current: unknown): void;
  setActive(id: string): WorkspaceDocument;
  saveBaseline(): WorkspaceDocument;
  createProfile(name: string, current: unknown): WorkspaceDocument;
  renameProfile(id: string, name: string): WorkspaceDocument;
  deleteProfile(id: string): WorkspaceDocument;
}

// The renderer talks to main over IPC; each wrapper delegates to the fake store.
const holder = vi.hoisted(() => ({
  store: null as FakeStore | null,
  getWorkspace: null as (() => Promise<WorkspaceDocument>) | null,
}));
vi.mock("../ipc", () => ({
  workspaceGet: () => holder.getWorkspace?.() ?? Promise.resolve(holder.store!.get()),
  workspaceSetCurrent: async (current: unknown) => holder.store!.setCurrent(current),
  workspaceSetActive: async (id: string) => holder.store!.setActive(id),
  workspaceSaveBaseline: async () => holder.store!.saveBaseline(),
  workspaceCreateProfile: async (name: string, current: unknown) =>
    holder.store!.createProfile(name, current),
  workspaceRenameProfile: async (id: string, name: string) =>
    holder.store!.renameProfile(id, name),
  workspaceDeleteProfile: async (id: string) => holder.store!.deleteProfile(id),
}));

const WEFTCUT_LAYOUT_VERSION = 1;

/** A layout snapshot whose one open Panel is `kind` — normalizes cleanly and is
 *  distinguishable after restore. */
function leaf(kind: string): unknown {
  return {
    version: WEFTCUT_LAYOUT_VERSION,
    empty: false,
    dockview: {
      grid: {
        root: { type: "leaf", data: { views: [kind], activeView: kind, id: `g-${kind}` }, size: 100 },
        orientation: "HORIZONTAL",
        width: 1000,
        height: 720,
      },
      panels: {},
      activeGroup: `g-${kind}`,
    },
    placements: {},
  };
}

/** Read the first leaf's first view out of a NORMALIZED layout. */
function firstView(layout: WeftCutLayout): string | null {
  if (layout.empty || !layout.dockview) return null;
  let node: unknown = (layout.dockview as { grid: { root: unknown } }).grid.root;
  while (node && typeof node === "object" && (node as { type?: string }).type === "branch") {
    node = ((node as { data: unknown[] }).data ?? [])[0];
  }
  const views = (node as { data?: { views?: string[] } } | undefined)?.data?.views;
  return views?.[0] ?? null;
}

function fakeController() {
  let liveKind: string | null = "preview";
  const listeners = new Set<() => void>();
  const calls = {
    restore: [] as WeftCutLayout[],
    reset: 0,
    serialized: 0,
    subscribe: 0,
    unsubscribe: 0,
  };
  const controller: DockWorkspaceController = {
    getSnapshot: () => EMPTY_DOCK_WORKSPACE_SNAPSHOT,
    subscribe: (l) => {
      calls.subscribe++;
      listeners.add(l);
      return () => {
        calls.unsubscribe++;
        listeners.delete(l);
      };
    },
    openPanel: () => {},
    closePanel: () => {},
    closeActivePanel: () => {},
    focusNextPanel: () => {},
    focusPreviousPanel: () => {},
    setHoveredPanel: () => {},
    toggleMaximize: () => {},
    restoreMaximizedPanel: () => {},
    resetWorkspace: () => {
      calls.reset++;
      liveKind = "preview";
    },
    serialize: () => {
      calls.serialized++;
      return (liveKind ? leaf(liveKind) : { version: 1, empty: true, dockview: null, placements: {} }) as WeftCutLayout;
    },
    restore: (layout) => {
      calls.restore.push(layout);
      liveKind = firstView(layout);
      return true;
    },
  };
  return {
    controller,
    calls,
    liveKind: () => liveKind,
    setLiveKind: (k: string | null) => {
      liveKind = k;
    },
    fireLayoutChange: () => {
      for (const listener of listeners) listener();
    },
  };
}

function seedStore(): FakeStore {
  let doc = workspaceDocumentDefaults();
  let ids = 0;
  const clone = (): WorkspaceDocument => structuredClone(doc);
  const mapActive = (fn: (p: WorkspaceProfile) => WorkspaceProfile) => {
    doc = { ...doc, profiles: doc.profiles.map((p) => (p.id === doc.activeId ? fn(p) : p)) };
  };
  return {
    get: clone,
    setCurrent: (current) => mapActive((p) => ({ ...p, current: current ?? null })),
    setActive: (id) => {
      doc = { ...doc, activeId: doc.profiles.some((p) => p.id === id) ? id : EDITING_WORKSPACE_ID };
      return clone();
    },
    saveBaseline: () => {
      if (!isBuiltinWorkspace(doc.activeId)) mapActive((p) => ({ ...p, saved: p.current ?? null }));
      return clone();
    },
    createProfile: (name, current) => {
      const id = `ws-${++ids}`;
      doc = {
        ...doc,
        profiles: [...doc.profiles, { id, name, current: current ?? null, saved: current ?? null }],
        activeId: id,
      };
      return clone();
    },
    renameProfile: (id, name) => {
      if (!isBuiltinWorkspace(id)) {
        doc = { ...doc, profiles: doc.profiles.map((p) => (p.id === id ? { ...p, name } : p)) };
      }
      return clone();
    },
    deleteProfile: (id) => {
      if (!isBuiltinWorkspace(id)) {
        doc = {
          ...doc,
          profiles: doc.profiles.filter((p) => p.id !== id),
          activeId: doc.activeId === id ? EDITING_WORKSPACE_ID : doc.activeId,
        };
      }
      return clone();
    },
  };
}

describe("useWorkspacePersistence", () => {
  beforeEach(() => {
    holder.store = seedStore();
    holder.getWorkspace = null;
  });

  it("subscribes once when StrictMode replays an in-flight restore", async () => {
    let resolveGet!: (doc: WorkspaceDocument) => void;
    const pending = new Promise<WorkspaceDocument>((resolve) => {
      resolveGet = resolve;
    });
    holder.getWorkspace = vi.fn(() => pending);
    const fake = fakeController();
    renderHook(() => useWorkspacePersistence(fake.controller), {
      reactStrictMode: true,
    });
    await waitFor(() => expect(holder.getWorkspace).toHaveBeenCalledTimes(2));
    resolveGet(holder.store!.get());

    await waitFor(() => expect(fake.calls.subscribe).toBe(1));
    expect(fake.calls.unsubscribe).toBe(0);
  });

  it("repairs a corrupt active profile with the built-in layout", async () => {
    holder.store!.setCurrent({ version: 1, empty: false, dockview: { grid: {} } });
    const fake = fakeController();

    renderHook(() => useWorkspacePersistence(fake.controller));

    await waitFor(() => expect(fake.calls.reset).toBe(1));
    await waitFor(() =>
      expect(holder.store!.get().profiles[0]?.current).toEqual(leaf("preview")),
    );
  });

  it("leaves the already-mounted built-in baseline intact for a pristine profile", async () => {
    const fake = fakeController();

    renderHook(() => useWorkspacePersistence(fake.controller));

    await waitFor(() => expect(fake.calls.subscribe).toBe(1));
    expect(fake.calls.reset).toBe(0);
    expect(holder.store!.get().profiles[0]?.current).toBeNull();
  });

  it("restores the active profile's current layout on mount", async () => {
    holder.store!.setCurrent(leaf("timeline")); // Editing.current
    const fake = fakeController();

    const { result } = renderHook(() => useWorkspacePersistence(fake.controller));

    await waitFor(() => expect(result.current).not.toBeNull());
    await waitFor(() => expect(fake.liveKind()).toBe("timeline"));
    expect(result.current!.activeId).toBe(EDITING_WORKSPACE_ID);
    expect(result.current!.profiles).toEqual([
      { id: EDITING_WORKSPACE_ID, name: "Editing", isBuiltin: true },
    ]);
  });

  it("switches to another profile without a save prompt, flushing then restoring", async () => {
    holder.store!.setCurrent(leaf("timeline")); // Editing
    holder.store!.createProfile("Cutting", leaf("media")); // ws-1 active
    holder.store!.setActive(EDITING_WORKSPACE_ID); // active = Editing again
    const fake = fakeController();

    const { result } = renderHook(() => useWorkspacePersistence(fake.controller));
    await waitFor(() => expect(fake.liveKind()).toBe("timeline"));

    act(() => result.current!.switchTo("ws-1"));

    await waitFor(() => expect(result.current!.activeId).toBe("ws-1"));
    await waitFor(() => expect(fake.liveKind()).toBe("media"));
    // The outgoing Editing profile stayed auto-saved (still a valid current).
    expect(holder.store!.get().profiles[0]?.current).toBeTruthy();
  });

  it("Save As branches a custom profile from the live arrangement without restoring it", async () => {
    holder.store!.setCurrent(leaf("timeline"));
    const fake = fakeController();

    const { result } = renderHook(() => useWorkspacePersistence(fake.controller));
    await waitFor(() => expect(fake.liveKind()).toBe("timeline"));
    const restoresAfterMount = fake.calls.restore.length;
    // The live arrangement the editor is looking at when they choose Save As.
    fake.setLiveKind("attribute");

    act(() => result.current!.saveAs("Grading"));

    await waitFor(() =>
      expect(result.current!.profiles.map((p) => p.name)).toEqual(["Editing", "Grading"]),
    );
    expect(result.current!.activeIsBuiltin).toBe(false);
    // The live layout stays mounted — no extra restore on Save As.
    expect(fake.calls.restore.length).toBe(restoresAfterMount);
    // The new profile's baseline was seeded from the current arrangement.
    const created = holder.store!.get().profiles.find((p) => p.name === "Grading")!;
    expect(created.saved).toEqual(leaf("attribute"));
  });

  it("Save promotes a custom profile's current to its baseline (and is inert on Editing)", async () => {
    holder.store!.createProfile("Cutting", leaf("media")); // ws-1 active
    const fake = fakeController();

    const { result } = renderHook(() => useWorkspacePersistence(fake.controller));
    await waitFor(() => expect(result.current!.activeId).toBe("ws-1"));
    await waitFor(() => expect(fake.liveKind()).toBe("media"));
    fake.setLiveKind("nearby"); // the editor rearranges, then chooses Save

    act(() => result.current!.save());
    await waitFor(() =>
      expect(holder.store!.get().profiles.find((p) => p.id === "ws-1")!.saved).toEqual(
        leaf("nearby"),
      ),
    );
  });

  it("Reset restores the active profile's saved baseline", async () => {
    holder.store!.createProfile("Cutting", leaf("media")); // ws-1 current
    holder.store!.setCurrent(leaf("media"));
    holder.store!.saveBaseline(); // ws-1.saved = leaf('media')
    holder.store!.setCurrent(leaf("timeline")); // drift the current away from the baseline
    const fake = fakeController();

    const { result } = renderHook(() => useWorkspacePersistence(fake.controller));
    await waitFor(() => expect(fake.liveKind()).toBe("timeline"));

    act(() => result.current!.reset());
    await waitFor(() => expect(fake.liveKind()).toBe("media"));
  });

  it("Reset on the built-in Editing profile falls back to the code baseline", async () => {
    const fake = fakeController();
    const { result } = renderHook(() => useWorkspacePersistence(fake.controller));
    await waitFor(() => expect(result.current).not.toBeNull());
    const resetsBefore = fake.calls.reset;

    act(() => result.current!.reset());
    await waitFor(() => expect(fake.calls.reset).toBe(resetsBefore + 1));
  });

  it("deleting the active custom profile activates and restores Editing", async () => {
    holder.store!.setCurrent(leaf("timeline")); // Editing.current
    holder.store!.createProfile("Cutting", leaf("media")); // ws-1 active
    const fake = fakeController();

    const { result } = renderHook(() => useWorkspacePersistence(fake.controller));
    await waitFor(() => expect(result.current!.activeId).toBe("ws-1"));

    act(() => result.current!.remove("ws-1"));
    await waitFor(() => expect(result.current!.activeId).toBe(EDITING_WORKSPACE_ID));
    await waitFor(() => expect(fake.liveKind()).toBe("timeline"));
    expect(result.current!.profiles).toHaveLength(1);
  });

  it("autosaves live layout changes to the active profile once subscribed", async () => {
    const fake = fakeController();
    const { result } = renderHook(() => useWorkspacePersistence(fake.controller));
    await waitFor(() => expect(result.current).not.toBeNull());

    fake.setLiveKind("caption");
    act(() => fake.fireLayoutChange());
    await waitFor(() =>
      expect(holder.store!.get().profiles[0]?.current).toEqual(leaf("caption")),
    );
  });

  it("contains serialization failures raised by the autosave listener", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeController();
    const { result } = renderHook(() => useWorkspacePersistence(fake.controller));
    await waitFor(() => expect(result.current).not.toBeNull());
    await waitFor(() => expect(fake.calls.subscribe).toBe(1));

    fake.controller.serialize = () => {
      throw new Error("invalid live layout");
    };

    expect(() => act(() => fake.fireLayoutChange())).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[dock-workspace] persist failed:",
      expect.objectContaining({ message: "invalid live layout" }),
    );
    warn.mockRestore();
  });
});
