// The two-input transition compositor node. During an active window the
// Compositor diverts both participating layers here: each side — already
// carrying its own transform / opacity / effects filters from the normal
// per-layer update path — renders into a composition-sized offscreen RT,
// and one full-frame quad composites the pair with the kind's fragment
// shader at the first participant's stage position. Composition-space
// full-frame semantics: uncovered regions stay transparent, and the mix
// runs on premultiplied captures.
//
// Frame protocol (driven by Compositor.compositeFrame): beginFrame(active)
// → sweep consults sideFor / takeQuadToStage → finishFrame(). Sides only
// BORROW Compositor-owned sprites for the offscreen render (removeChildren,
// never destroy).

import { Container, Mesh, MeshGeometry, RenderTexture, Shader } from "pixi.js";
import type { Renderer } from "pixi.js";
import { logEmit } from "../../ipc";
import type { ActiveTransition } from "./activeTransitions";
import { TransitionRtPool } from "./TransitionRtPool";
import { directionVector, shaderSourceFor, TRANSITION_GL_VERT } from "./transitionSources";

/// Side captures must clear to transparent — the renderer's background
/// color is for the root canvas, not these full-frame captures.
const TRANSPARENT: [number, number, number, number] = [0, 0, 0, 0];

interface TransitionUniforms {
  uDirection: Float32Array;
  uProgress: number;
}

interface Node {
  /// `TransitionKind` discriminant — the shader identity. A kind edit
  /// mid-window rebuilds the node.
  kindName: string;
  /// Side A = outgoing (`from_layer`), side B = incoming (`to_layer`);
  /// progress 0 shows A, 1 shows B.
  rtA: RenderTexture;
  rtB: RenderTexture;
  sideA: Container;
  sideB: Container;
  mesh: Mesh<MeshGeometry, Shader>;
  progress: number;
  /// The quad stages exactly once per frame, at the FIRST participant the
  /// sweep reaches — that slot is the transition's z-position.
  stagedThisFrame: boolean;
}

export class TransitionNodeManager {
  private nodes = new Map<string, Node>();
  /// Participant layerId → node + side, valid for the current frame only
  /// (rebuilt by every beginFrame).
  private byLayer = new Map<string, { node: Node; side: "a" | "b" }>();
  private pool: TransitionRtPool<RenderTexture>;
  private warnedKinds = new Set<string>();

  constructor(
    private renderer: Renderer,
    private width: number,
    private height: number,
  ) {
    // WebGPU LANDMINE: Pixi's WebGPU pipelines hard-code bgra8unorm color
    // targets, so an rgba8unorm RT trips Dawn's attachment validation and
    // every render into it is silently dropped (same wall Nv12Ingest hit).
    // WebGL keeps rgba8unorm. 8-bit sides mean the 10-bit export lane
    // quantizes through a transition window — accepted for v1 (float RTs
    // would need EXT_color_buffer_float, which preview's WebGL fallback
    // can't assume).
    const format = "gl" in renderer ? ("rgba8unorm" as const) : ("bgra8unorm" as const);
    this.pool = new TransitionRtPool<RenderTexture>(width, height, {
      create: (w, h) => RenderTexture.create({ width: w, height: h, format }),
      destroy: (rt) => rt.destroy(true),
    });
  }

  hasNodes(): boolean {
    return this.nodes.size > 0;
  }

  /// Sync nodes to this frame's active set: release finished windows' RTs
  /// back to the pool, build missing nodes, refresh progress, and reset the
  /// per-frame side/stage state.
  beginFrame(active: readonly ActiveTransition[]): void {
    if (this.nodes.size > 0) {
      for (const id of [...this.nodes.keys()]) {
        if (!active.some((t) => t.id === id)) this.releaseNode(id);
      }
    }
    this.byLayer.clear();
    for (const t of active) {
      let node = this.nodes.get(t.id);
      if (node && node.kindName !== t.kind.kind) {
        this.releaseNode(t.id);
        node = undefined;
      }
      if (!node) {
        node = this.buildNode(t);
        this.nodes.set(t.id, node);
      }
      node.progress = t.progress;
      node.stagedThisFrame = false;
      node.sideA.removeChildren();
      node.sideB.removeChildren();
      this.byLayer.set(t.fromLayerId, { node, side: "a" });
      this.byLayer.set(t.toLayerId, { node, side: "b" });
    }
  }

  /// The offscreen container a diverted participant stages into this frame,
  /// or null when the layer isn't participating.
  sideFor(layerId: string): Container | null {
    const hit = this.byLayer.get(layerId);
    if (!hit) return null;
    return hit.side === "a" ? hit.node.sideA : hit.node.sideB;
  }

  /// The quad to insert at the current stage position — returned exactly
  /// once per node per frame, null afterwards.
  takeQuadToStage(layerId: string): Container | null {
    const hit = this.byLayer.get(layerId);
    if (!hit || hit.node.stagedThisFrame) return null;
    hit.node.stagedThisFrame = true;
    return hit.node.mesh;
  }

  /// Bake both sides into their RTs (an empty side clears to transparent —
  /// the full-frame semantics) and publish progress. Runs after the sweep
  /// so the staged quad samples THIS frame's pixels at the ticker's render.
  finishFrame(): void {
    for (const node of this.nodes.values()) {
      this.renderer.render({ container: node.sideA, target: node.rtA, clear: true, clearColor: TRANSPARENT });
      this.renderer.render({ container: node.sideB, target: node.rtB, clear: true, clearColor: TRANSPARENT });
      const u = (node.mesh.shader!.resources as { transition: { uniforms: TransitionUniforms } })
        .transition.uniforms;
      u.uProgress = node.progress;
    }
  }

  /// Pool accounting for the perf HUD / memory-ratchet instrumentation.
  stats(): { nodes: number; rt: ReturnType<TransitionRtPool<RenderTexture>["stats"]> } {
    return { nodes: this.nodes.size, rt: this.pool.stats() };
  }

  /// Composition resize: stale-size RTs are destroyed on their way back to
  /// the pool; live nodes rebuild at the new size on the next beginFrame.
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.pool.setSize(width, height);
    for (const id of [...this.nodes.keys()]) this.releaseNode(id);
    this.byLayer.clear();
  }

  /// Release every node + pooled RT (suspend / project unload). The manager
  /// stays usable — the next beginFrame rebuilds on demand.
  reset(): void {
    for (const id of [...this.nodes.keys()]) this.releaseNode(id);
    this.byLayer.clear();
    this.pool.drain();
  }

  dispose(): void {
    for (const id of [...this.nodes.keys()]) this.releaseNode(id);
    this.byLayer.clear();
    this.pool.dispose();
  }

  private buildNode(t: ActiveTransition): Node {
    const kindName = t.kind.kind;
    const { source, isFallback } = shaderSourceFor(kindName);
    if (isFallback) this.warnMissingShader(kindName);
    const rtA = this.pool.acquire();
    const rtB = this.pool.acquire();
    const w = this.width;
    const h = this.height;
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = Shader.from({
      gl: { vertex: TRANSITION_GL_VERT, fragment: source.glFragment },
      gpu: {
        vertex: { entryPoint: "mainVert", source: source.wgsl },
        fragment: { entryPoint: "mainFrag", source: source.wgsl },
      },
      resources: {
        uTexA: rtA.source,
        uTexASampler: rtA.source.style,
        uTexB: rtB.source,
        uTexBSampler: rtB.source.style,
        transition: {
          uDirection: { value: new Float32Array(directionVector(t.kind)), type: "vec2<f32>" },
          uProgress: { value: t.progress, type: "f32" },
        },
      },
    });
    const mesh = new Mesh<MeshGeometry, Shader>({ geometry, shader });
    return {
      kindName,
      rtA,
      rtB,
      sideA: new Container(),
      sideB: new Container(),
      mesh,
      progress: t.progress,
      stagedThisFrame: false,
    };
  }

  private releaseNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.nodes.delete(id);
    // Detach borrowed sprites BEFORE destroy — destroy({children}) defaults
    // off, but removeChildren makes the non-ownership explicit.
    node.sideA.removeChildren();
    node.sideB.removeChildren();
    node.sideA.destroy();
    node.sideB.destroy();
    const { geometry, shader } = node.mesh;
    node.mesh.destroy();
    geometry.destroy();
    shader?.destroy();
    this.pool.release(node.rtA);
    this.pool.release(node.rtB);
  }

  /// Not-yet-implemented kind (07 adds Wipe/Slide shaders): fall back to the
  /// Crossfade mix and say so once per kind. LogBus needs the preload bridge
  /// — absent in the export Worker, where console is the only surface.
  private warnMissingShader(kindName: string): void {
    if (this.warnedKinds.has(kindName)) return;
    this.warnedKinds.add(kindName);
    const message = `Transition kind "${kindName}" has no shader yet — rendering as Crossfade`;
    if (typeof window !== "undefined" && window.api?.backend) {
      void logEmit({
        level: "warn",
        category: { kind: "System" },
        source: { kind: "System" },
        message,
      }).catch(() => {});
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[weftcut/transitions] ${message}`);
    }
  }
}
