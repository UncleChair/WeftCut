// Renderer leg of the chip edge-drag golden (spec D6). The SAME fixture is
// driven through the main-process actor in
// src/main/state/mutations/transitionEdgeClamp.golden.test.ts — a value that
// clamps differently here than the mutation accepts over there is twin drift,
// exactly what this pair exists to catch (snapFrameRound golden precedent).
import { describe, expect, it } from "vitest";
import type { TransitionSummary } from "../ipc";
import {
  transitionLeftEdgeClampUs,
  transitionLeftEdgeDragArgs,
  transitionRightEdgeClampUs,
  transitionRightEdgeDragArgs,
  transitionTailHandleUs,
} from "./transitions";
import fixture from "./transitionEdgeClampGolden.fixture.json";

interface Case {
  name: string;
  fps: { num: number; den: number };
  edge: "left" | "right";
  setup: {
    mediaDurationUs: number | null;
    aStartUs: number;
    cutUs: number;
    bEnd0Us: number;
    addDurationUs: number;
  };
  geometry: {
    aEndUs: number;
    bStartUs: number;
    bEndUs: number;
    extendedUs: number;
    aSrcOutUs: number | null;
  };
  rawTargetUs: number;
  clampedUs: number;
  commit: { durationUs: number; extendedUs: number };
}

describe("transition edge clamp golden (renderer leg)", () => {
  for (const c of fixture.cases as Case[]) {
    it(c.name, () => {
      const g = c.geometry;
      const transition: TransitionSummary = {
        id: "tr-golden",
        from_layer: "a",
        to_layer: "b",
        duration_us: g.aEndUs - g.bStartUs,
        kind: { kind: "Crossfade" },
        extended_us: g.extendedUs,
      };
      const clamped =
        c.edge === "left"
          ? transitionLeftEdgeClampUs({
              targetUs: c.rawTargetUs,
              aStartUs: c.setup.aStartUs,
              aEndUs: g.aEndUs,
              bStartUs: g.bStartUs,
              bEndUs: g.bEndUs,
              extendedUs: g.extendedUs,
              fpsNum: c.fps.num,
              fpsDen: c.fps.den,
            })
          : transitionRightEdgeClampUs({
              targetUs: c.rawTargetUs,
              bStartUs: g.bStartUs,
              bEndUs: g.bEndUs,
              aEndUs: g.aEndUs,
              tailHandleUs: transitionTailHandleUs(
                c.setup.mediaDurationUs === null ? "Color" : "VideoClip",
                g.aSrcOutUs ?? 0,
                c.setup.mediaDurationUs,
              ),
              fpsNum: c.fps.num,
              fpsDen: c.fps.den,
            });
      expect(clamped).toBe(c.clampedUs);
      const args =
        c.edge === "left"
          ? transitionLeftEdgeDragArgs(transition, g.aEndUs, clamped)
          : transitionRightEdgeDragArgs(transition, g.aEndUs, g.bStartUs, clamped);
      expect(args).toEqual({
        transitionId: "tr-golden",
        durationUs: c.commit.durationUs,
        extendedUs: c.commit.extendedUs,
      });
    });
  }
});
