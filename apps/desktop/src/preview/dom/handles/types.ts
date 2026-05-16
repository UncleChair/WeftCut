/// Shared types for `apps/desktop/src/preview/dom/handles/*`.
///
/// Each layer-kind handle implements `LayerHandle` from the
/// PlaybackEngine; `HandleContext` is what the Layer component
/// passes in at construction time. All per-tick state changes flow
/// through the handle's own `tick` method — the React tree never
/// touches the underlying DOM element after mount.

import type { LayerHandle } from "../PlaybackEngine";
import type { AudioGraph } from "../audio/AudioGraph";

export interface HandleContext {
  /// Stable layer id from `LayerSummary.id`.
  layerId: string;
  /// Parent `<div>` the handle mounts its element inside. The Layer
  /// component owns this div; handles append exactly one child.
  container: HTMLDivElement;
  /// Web Audio graph for routing media-element audio. Null when audio
  /// is disabled (preview launched without AudioContext / tests).
  audioGraph: AudioGraph | null;
}

export type { LayerHandle };
