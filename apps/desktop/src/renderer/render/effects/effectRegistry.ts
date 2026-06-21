// Effect registry: maps a kind string to an EffectDescriptor (stock Pixi Filter
// factory + per-param apply glue + fidelity tier). Rust owns effect instances;
// this module owns the catalog — what filters exist, how to construct them, and
// how to apply each parameter value.
//
// Adding an effect: add one entry to REGISTRY with the shape below. The
// fidelity field documents whether the filter operates correctly at float16
// precision ("f16-verified") or loses range ("precision-reduced").

import { BlurFilter, type Filter } from "pixi.js";

export interface EffectParamSpec {
  default: number;
  range?: [number, number];
  /// Number-field / slider step. Absent ⇒ the UI derives one from the range
  /// width (≤10 → 0.1, else 1).
  step?: number;
  apply(filter: Filter, value: number): void;
}

export interface EffectDescriptor {
  kind: string;
  nameI18nKey: string;
  create(): Filter;
  params: Record<string, EffectParamSpec>;
  fidelity: "f16-verified" | "precision-reduced";
  colorspace: "display-gamma";
}

const REGISTRY: Record<string, EffectDescriptor> = {
  blur: {
    kind: "blur",
    nameI18nKey: "effects.blur.name",
    create: () => new BlurFilter({ strength: 8 }),
    params: {
      strength: {
        default: 8,
        range: [0, 100],
        step: 1,
        apply: (f, v) => {
          (f as BlurFilter).strength = v;
        },
      },
    },
    fidelity: "f16-verified",
    colorspace: "display-gamma",
  },
};

export function getDescriptor(kind: string): EffectDescriptor | null {
  return REGISTRY[kind] ?? null;
}

/// All catalog entries, for the add-effect picker and the param-row generator.
/// The UI is fully data-driven off this — a new filter is one REGISTRY entry,
/// zero UI change.
export function listEffects(): EffectDescriptor[] {
  return Object.values(REGISTRY);
}
