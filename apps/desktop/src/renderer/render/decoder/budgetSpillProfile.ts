export type BudgetSpillScaleDiv = 1 | 2 | 4;
export type BudgetSpillCadenceDiv = 1 | 2;

export interface BudgetSpillProfileInput {
  budgetExceeded: boolean;
  codedWidth: number | null | undefined;
  codedHeight: number | null | undefined;
  playbackScaleDiv: number;
}

export interface BudgetSpillProfile {
  scaleDiv: BudgetSpillScaleDiv;
  cadenceDiv: BudgetSpillCadenceDiv;
}

const FULL_HD_PIXEL_AREA = 1920 * 1080;
const SPILL_TARGET_PIXEL_AREA = 960 * 540;

function supportedScaleDiv(div: number): BudgetSpillScaleDiv {
  if (div >= 4) return 4;
  if (div >= 2) return 2;
  return 1;
}

function minimumSupportedScaleDiv(div: number): BudgetSpillScaleDiv {
  if (div <= 1) return 1;
  if (div <= 2) return 2;
  return 4;
}

/// Resolve the one formal budget-spill profile at the HW→SW seam.
///
/// The trigger is deliberately supplied as a boolean by `FfmpegSource`, which
/// owns error classification. A native dimension mismatch and a genuine device
/// failure may also fall back for this open, but neither is allowed to inherit
/// this capacity-only profile.
export function resolveBudgetSpillProfile(input: BudgetSpillProfileInput): BudgetSpillProfile {
  const requestedScaleDiv = supportedScaleDiv(input.playbackScaleDiv);
  const width = input.codedWidth;
  const height = input.codedHeight;
  if (
    !input.budgetExceeded
    || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || (width ?? 0) <= 0
    || (height ?? 0) <= 0
  ) {
    return { scaleDiv: requestedScaleDiv, cadenceDiv: 1 };
  }

  const codedPixelArea = (width as number) * (height as number);
  if (!Number.isSafeInteger(codedPixelArea) || codedPixelArea <= FULL_HD_PIXEL_AREA) {
    return { scaleDiv: requestedScaleDiv, cadenceDiv: 1 };
  }

  const requiredDivisor = Math.ceil(Math.sqrt(codedPixelArea / SPILL_TARGET_PIXEL_AREA));
  return {
    scaleDiv: Math.max(requestedScaleDiv, minimumSupportedScaleDiv(requiredDivisor)) as BudgetSpillScaleDiv,
    cadenceDiv: 2,
  };
}
