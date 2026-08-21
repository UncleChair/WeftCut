// The two centring commands, end to end from the catalogue: what they gate on,
// what they write, and what they refuse. The geometry itself is covered by
// `preview/centerInFrame.test.ts`; this is the wiring around it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnimTrack, LayerParamsView, LayerSummary, ProjectSummary } from "../ipc";
import { setPlayheadTimeUs } from "../state/playheadStore";
import { useProjectStore } from "../state/projectStore";
import { clearLayerSelection, setLayerSelection } from "../state/selectionStore";
import {
  clearGizmoProbe,
  registerGizmoProbe,
  type GizmoProbe,
} from "../preview/gizmoProbeRegistry";
import type { HandlerMap } from "../shortcuts";
import { buildAppCommands } from "./appCommands";

type Entries = [string, AnimTrack<number>][];
const commit = vi.fn(async (_layerId: string, _entries: Entries) => {});
const emit = vi.fn(async (_entry: Record<string, unknown>) => {});
vi.mock("../ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ipc")>();
  return {
    ...actual,
    updateLayerParamTracks: (layerId: string, entries: Entries) => commit(layerId, entries),
    logEmit: (entry: Record<string, unknown>) => emit(entry),
  };
});

const stat = (value: number): AnimTrack<number> => ({ mode: "Static", value });

const handlers: HandlerMap = {};
const menu = {
  addColorLayer: () => {},
  addTextLayer: () => {},
  openMotifPicker: () => {},
  openAgentPanel: () => {},
  enterAgentMode: () => {},
  createCheckpoint: () => {},
  moveToNewTrack: () => {},
  toggleMarkersVisible: () => {},
  applyDefaultTransition: () => {},
};
const flags = {
  busy: false,
  canUndo: false,
  canRedo: false,
  canBlade: false,
  exportLocked: false,
};

const command = (id: string) =>
  buildAppCommands(handlers, menu, flags).find((d) => d.id === id)!;

/// 1280×720 30 fps comp with one layer on [2 s, 4 s).
function fixture(kind: string, params: Record<string, unknown> = {}): ProjectSummary {
  const layer: LayerSummary = {
    id: "l1",
    label: null,
    t_start_us: 2_000_000,
    t_end_us: 4_000_000,
    kind,
    color_hint: "",
    enabled: true,
    locked: false,
    effects: [],
    params: {
      kind,
      x: stat(0),
      y: stat(0),
      scale_x: stat(1),
      scale_y: stat(1),
      rotation_deg: stat(0),
      anchor_x: stat(0.5),
      anchor_y: stat(0.5),
      ...params,
    } as unknown as LayerParamsView,
  } as unknown as LayerSummary;
  return {
    project_id: "p1",
    name: "fixture",
    composition: {
      width: 1280,
      height: 720,
      fps_num: 30,
      fps_den: 1,
      duration_pinned: false,
      fps_locked: false,
    },
    track_count: 1,
    layer_count: 1,
    duration_us: 10_000_000,
    history: { cursor: 0, len: 0, can_undo: false, can_redo: false },
    media: [],
    tracks: [
      {
        id: "t1",
        kind: "Video",
        label: "A-Roll",
        enabled: true,
        locked: false,
        muted: false,
        solo: false,
        role: "a-roll",
        transient: false,
        layers: [layer],
      },
    ],
    groups: [],
    markers: [],
    transitions: [],
    audio_roles: [],
  } as unknown as ProjectSummary;
}

/// 640×360 of content, whatever the layer is.
let staged = true;
const probe: GizmoProbe = {
  canvasRect: () => null,
  naturalSizeOf: () => (staged ? { w: 640, h: 360 } : null),
};

beforeEach(() => {
  commit.mockClear();
  emit.mockClear();
  staged = true;
  registerGizmoProbe(probe);
  useProjectStore.getState().apply(fixture("VideoClip"));
  setLayerSelection("l1", ["l1"]);
  setPlayheadTimeUs(2_500_000);
});

afterEach(() => {
  clearGizmoProbe(probe);
  clearLayerSelection();
  useProjectStore.getState().apply(null);
});

describe("centerHorizontally / centerVertically", () => {
  // The acceptance criterion: both kinds put the CONTENT in the middle, from
  // different stored origins (a media layer's top-left vs Text's anchor).
  it("writes one axis in ONE commit, per the kind's origin", async () => {
    await command("centerHorizontally").run();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("l1", [["x", { mode: "Static", value: 320 }]]);

    commit.mockClear();
    useProjectStore.getState().apply(fixture("Text"));
    await command("centerHorizontally").run();
    expect(commit).toHaveBeenCalledWith("l1", [["x", { mode: "Static", value: 640 }]]);
  });

  it("centres vertically without touching x", async () => {
    await command("centerVertically").run();
    expect(commit).toHaveBeenCalledWith("l1", [["y", { mode: "Static", value: 180 }]]);
  });

  it("keys a keyframed track at the frame-snapped playhead instead of flattening it", async () => {
    useProjectStore.getState().apply(
      fixture("VideoClip", {
        x: {
          mode: "Keyframed",
          value: [{ id: "k1", t_us: 0, value: 0, interp: { kind: "Linear" } }],
        } as AnimTrack<number>,
      }),
    );
    await command("centerHorizontally").run();
    const x = commit.mock.calls[0]![1][0]![1];
    expect(x.mode).toBe("Keyframed");
    // Playhead 2.5 s − layer start 2 s = 0.5 s = frame 15 at 30 fps.
    const keys = x.value as Array<{ t_us: number; value: number }>;
    expect(keys.find((k) => k.t_us === 500_000)?.value).toBe(320);
  });

  it("writes nothing when the layer is already centred", async () => {
    useProjectStore.getState().apply(fixture("VideoClip", { x: stat(320) }));
    await command("centerHorizontally").run();
    expect(commit).not.toHaveBeenCalled();
  });

  // A layer the compositor has not staged has an UNKNOWABLE size, not a zero
  // one, so the command refuses out loud rather than moving it somewhere
  // derived from a guess.
  it("refuses with a Project log row when the preview has not staged the layer", async () => {
    staged = false;
    await command("centerHorizontally").run();
    expect(commit).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]!).toMatchObject({
      level: "warn",
      category: { kind: "Project" },
      i18n_key: "log.center_layer_unstaged",
    });
  });

  describe("enabled", () => {
    it("is off with no selection", () => {
      clearLayerSelection();
      expect(command("centerHorizontally").enabled!()).toBe(false);
      expect(command("centerVertically").enabled!()).toBe(false);
    });

    it("is off for a kind with no transform", () => {
      useProjectStore.getState().apply(fixture("Color"));
      setLayerSelection("l1", ["l1"]);
      expect(command("centerHorizontally").enabled!()).toBe(false);
    });

    it("is on for every transformable kind, read live", () => {
      // Built BEFORE each swap: a build-time snapshot would freeze on the first.
      const horizontally = command("centerHorizontally");
      for (const kind of ["VideoClip", "ImageOverlay", "Text", "Motif"]) {
        useProjectStore.getState().apply(fixture(kind));
        setLayerSelection("l1", ["l1"]);
        expect(horizontally.enabled!(), kind).toBe(true);
      }
    });

    // The probe is deliberately NOT part of the gate — staging flickers with
    // decoding and with the preview panel's own lifetime.
    it("stays on while the layer is unstaged, and refuses at run time instead", () => {
      staged = false;
      expect(command("centerHorizontally").enabled!()).toBe(true);
    });
  });
});
