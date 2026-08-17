// Effect registry: maps a kind string to an EffectDescriptor (stock Pixi Filter
// factory + per-param apply glue + fidelity tier). The TS state model owns
// effect instances; this module owns the catalog — what filters exist, how to
// construct them, and how to apply each parameter value. `kind` is the join key.
//
// Adding an effect: add one entry to REGISTRY with the shape below. The
// fidelity field documents whether the filter operates correctly at float16
// precision ("f16-verified") or loses range ("precision-reduced").

import { BlurFilter, ColorMatrixFilter, type Filter } from "pixi.js";
import { ChromaKeyFilter, type ChromaParamName } from "./filters/ChromaKeyFilter";
import { SharpenFilter } from "./filters/SharpenFilter";
import {
  writeBrightness,
  writeContrast,
  writeSaturation,
} from "./filters/colorMatrices";

export interface EffectParamSpec {
  default: number;
  range?: [number, number];
  /// Number-field / slider step. Absent ⇒ the UI derives one from the range
  /// width (≤10 → 0.1, else 1).
  step?: number;
  apply(filter: Filter, value: number): void;
}

/// Picker grouping only — purely presentational. The render path never reads
/// it, so a mis-categorised effect is a cosmetic bug, never a rendering one.
export type EffectCategory = "blur" | "keying" | "color" | "stylize";

/// Group order in the add picker. May name categories the catalog doesn't
/// populate yet — empty groups are dropped at render.
export const EFFECT_CATEGORY_ORDER: EffectCategory[] = [
  "blur",
  "keying",
  "color",
  "stylize",
];

export interface EffectDescriptor {
  kind: string;
  nameI18nKey: string;
  category: EffectCategory;
  create(): Filter;
  params: Record<string, EffectParamSpec>;
  fidelity: "f16-verified" | "precision-reduced";
  colorspace: "display-gamma";
  /// RGB triplets of 0–1 scalar params that get an inspector eyedropper
  /// (docs/features.md#color-picker-eyedropper). Names must
  /// exist in `params`.
  colorGroups?: Array<{ params: [string, string, string] }>;
}

/// The three colour-matrix entries are one shape: a stock ColorMatrixFilter
/// used as a shader shell, one scalar `amount` on the shared calibration
/// ([-100, 100], step 1, neutral at 0), and a writer that fills the filter's
/// 4×5 matrix from that amount.
///
/// `filter.matrix` is read, never assigned: the GETTER hands back the live
/// `uColorMatrix` array, while the SETTER would swap the uniform reference on
/// every frame. `uAlpha` is left at the constructor's 1 — at 0 the fragment
/// early-returns the untouched colour, so a matrix that appears to do nothing
/// is more likely that than a maths bug.
function colorMatrixEffect(
  kind: string,
  write: (out: number[], amount: number) => void,
): EffectDescriptor {
  return {
    kind,
    nameI18nKey: `effects.${kind}.name`,
    category: "color",
    create: () => new ColorMatrixFilter(),
    params: {
      amount: {
        default: 0,
        range: [-100, 100],
        step: 1,
        apply: (f, v) => write((f as ColorMatrixFilter).matrix, v),
      },
    },
    fidelity: "f16-verified",
    colorspace: "display-gamma",
  };
}

const REGISTRY: Record<string, EffectDescriptor> = {
  blur: {
    kind: "blur",
    nameI18nKey: "effects.blur.name",
    category: "blur",
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
  chromakey: {
    kind: "chromakey",
    nameI18nKey: "effects.chromakey.name",
    category: "keying",
    create: () => new ChromaKeyFilter(),
    params: (() => {
      const p = (name: ChromaParamName, def: number, range: [number, number], step: number) => ({
        default: def,
        range,
        step,
        apply: (f: Filter, v: number) => (f as ChromaKeyFilter).applyParam(name, v),
      });
      return {
        keyR: p("keyR", 0, [0, 1], 0.01),
        keyG: p("keyG", 1, [0, 1], 0.01),
        keyB: p("keyB", 0, [0, 1], 0.01),
        balance: p("balance", 0.5, [0, 1], 0.01),
        clipBlack: p("clipBlack", 0, [0, 1], 0.01),
        clipWhite: p("clipWhite", 1, [0, 1], 0.01),
        despill: p("despill", 1, [0, 1], 0.01),
        feather: p("feather", 0, [0, 10], 0.5),
        shrink: p("shrink", 0, [-5, 5], 0.5),
        viewMatte: p("viewMatte", 0, [0, 1], 1),
      };
    })(),
    colorGroups: [{ params: ["keyR", "keyG", "keyB"] }],
    fidelity: "f16-verified",
    colorspace: "display-gamma",
  },
  brightness: colorMatrixEffect("brightness", writeBrightness),
  contrast: colorMatrixEffect("contrast", writeContrast),
  saturation: colorMatrixEffect("saturation", writeSaturation),
  sharpen: {
    kind: "sharpen",
    nameI18nKey: "effects.sharpen.name",
    category: "stylize",
    create: () => new SharpenFilter(),
    params: {
      // The one deliberate break from the colour trio's shared calibration:
      // [0, 100], not [-100, 100]. A negative unsharp amount is a box blur and
      // `blur` is already in the catalog — the picker offers exactly one way to
      // soften an image.
      amount: {
        default: 0,
        range: [0, 100],
        step: 1,
        apply: (f, v) => (f as SharpenFilter).applyParam("amount", v),
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
