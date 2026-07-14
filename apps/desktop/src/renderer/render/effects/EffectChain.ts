// Maintains a cached, ordered list of Pixi Filter instances for one layer's
// effect chain. Rebuilds instances only when the (id, kind) sequence changes
// structurally; applies resolved param values every frame.

import type { Filter } from "pixi.js";
import type { EffectView } from "../../ipc";
import { resolveAnimated } from "../animated";
import { isEffectDisabled, overrideFor } from "./effectOverrides";
import { getDescriptor } from "./effectRegistry";

interface Instance { id: string; kind: string; filter: Filter; }

export class EffectChain {
  private instances: Instance[] = [];
  private warned = new Set<string>();

  /** Returns the ordered, param-updated filter list for the current frame. */
  sync(views: EffectView[], tInLayerUs: number): Filter[] {
    const wanted = views.filter((v) => v.enabled && getDescriptor(v.kind) !== null);

    // Rebuild instance list only on a structural change (id+kind sequence).
    const sameStructure =
      wanted.length === this.instances.length &&
      wanted.every((v, i) => this.instances[i]!.id === v.id && this.instances[i]!.kind === v.kind);
    if (!sameStructure) {
      for (const inst of this.instances) inst.filter.destroy();
      this.instances = wanted.map((v) => ({ id: v.id, kind: v.kind, filter: getDescriptor(v.kind)!.create() }));
    }

    // Warn once per unknown kind so authors learn the kind isn't in the catalog.
    for (const v of views) {
      if (v.enabled && getDescriptor(v.kind) === null && !this.warned.has(v.kind)) {
        this.warned.add(v.kind);
        console.warn(`[effects] unknown effect kind "${v.kind}" — skipped`);
      }
    }

    // Apply resolved params each frame.
    for (let i = 0; i < this.instances.length; i++) {
      const inst = this.instances[i]!;
      const view = wanted[i]!;
      const spec = getDescriptor(inst.kind)!.params;
      for (const [key, paramSpec] of Object.entries(spec)) {
        const v = resolveAnimated(view.params[key], tInLayerUs, paramSpec.default);
        // Color-pick hover live-apply: a transient override (never recorded)
        // wins over the resolved track value for this frame only.
        paramSpec.apply(inst.filter, overrideFor(inst.id, key) ?? v);
      }
    }
    // Color-pick freeze: an override-disabled effect is excluded from THIS
    // frame's filter list but keeps its instance (no destroy/recompile churn).
    return this.instances.flatMap((i) => isEffectDisabled(i.id) ? [] : [i.filter]);
  }

  dispose(): void {
    for (const inst of this.instances) inst.filter.destroy();
    this.instances = [];
  }
}
