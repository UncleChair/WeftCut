// The global pick-session state machine (singleton — a new call preempts the
// old). Freezes BOTH sample buffers up front: every hover afterwards is a CPU
// read, and live-apply re-renders can never pollute the sample source (the
// chromakey feedback-loop fix). The overlay (PickOverlayHost) renders whenever
// the store holds a session and calls settle() to finish it.
// Spec: docs/superpowers/specs/2026-07-11-color-picker-design.md

import { create } from "zustand";
import { logEmit } from "../ipc";
import { transportPause } from "../state/playbackStore";
import type { FrameBuffer } from "./pixel";
import { getPreviewSampler } from "./previewSamplerRegistry";
import { captureWindowSnapshot, type WindowSnapshot } from "./snapshot";

export interface PickOptions {
  /// Chromakey: freeze the composition WITHOUT this effect's filter, so
  /// samples are the pixels its shader actually compares against.
  excludeEffectId?: string;
  /// rAF-throttled by the overlay; in-app sessions only (screen mode has none).
  onHover?: (hex: string) => void;
}

export interface PickResult {
  hex: string;
  source: "composition" | "ui" | "screen";
}

export interface PickSession {
  opts: PickOptions;
  /// Frozen composition buffer; null ⇒ canvas-region sampling unavailable.
  comp: FrameBuffer | null;
  /// Frozen window snapshot; null ⇒ non-canvas sampling unavailable.
  snap: WindowSnapshot | null;
  /// Idempotent; clears the store session and resolves the pickColor promise.
  settle(result: PickResult | null): void;
}

interface PickState {
  session: PickSession | null;
}

export const usePickSessionStore = create<PickState>(() => ({ session: null }));

function warn(message: string): void {
  void logEmit({
    level: "warn",
    category: { kind: "System" },
    source: { kind: "User" },
    message: `colorpick: ${message}`,
  });
}

/// A call still freezing its buffers (not yet installed in the store).
/// pickColor() must preempt BOTH phases of the previous call — the installed
/// session (store) AND a still-capturing one (this claim) — or the loser's
/// promise leaks unresolved forever.
interface Claim {
  cancelled: boolean;
}
let inFlight: Claim | null = null;

export async function pickColor(opts: PickOptions = {}): Promise<PickResult | null> {
  if (inFlight) inFlight.cancelled = true;
  usePickSessionStore.getState().session?.settle(null);
  transportPause();
  const claim: Claim = { cancelled: false };
  inFlight = claim;

  const sampler = getPreviewSampler();
  const [comp, snap] = await Promise.all([
    sampler
      ? sampler
          .captureFrame(opts.excludeEffectId ? { excludeEffectId: opts.excludeEffectId } : {})
          .catch((e: unknown) => {
            warn(`composition freeze failed: ${String(e)}`);
            return null;
          })
      : Promise.resolve(null),
    captureWindowSnapshot().catch((e: unknown) => {
      warn(`window snapshot failed: ${String(e)}`);
      return null;
    }),
  ]);

  // Preempted while capturing: the newer call owns the store — resolve null
  // WITHOUT installing (installing here would clobber the winner's session).
  if (claim.cancelled) return null;
  if (inFlight === claim) inFlight = null;

  if (!comp && !snap) {
    void logEmit({
      level: "error",
      category: { kind: "System" },
      source: { kind: "User" },
      message: "colorpick: no sample source (preview and window snapshot both failed)",
    });
    return null;
  }

  return new Promise<PickResult | null>((resolve) => {
    let settled = false;
    const session: PickSession = {
      opts,
      comp,
      snap,
      settle(result) {
        if (settled) return;
        settled = true;
        if (usePickSessionStore.getState().session === session) {
          usePickSessionStore.setState({ session: null });
        }
        resolve(result);
      },
    };
    usePickSessionStore.setState({ session });
  });
}
