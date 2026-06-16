import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AnimTrack } from "../ipc";
import type { KfWidget } from "../keyframe/descriptors";
import { autoKeyTrack } from "../keyframe/autoKey";
import { AppNumberField } from "./AppNumberField";
import { AppSlider } from "./AppSlider";
import { AnimatableField, displayValue } from "./AnimatableField";

// Sliders fire onValueChange continuously; debounce the recorded commit so a
// drag doesn't flood the actor (same 250ms the inspector used pre-consolidation).
const SLIDER_COMMIT_DEBOUNCE_MS = 250;

export interface KeyframeFieldProps {
  layerId: string;
  paramKey: string;
  label: string;
  track: AnimTrack<number>;
  fallback: number;
  /// Playhead time relative to the layer's t_start (may be <0 / > duration).
  tInLayerUs: number;
  /// Within the layer's span — gates keyframe creation (inspector stopwatch) and
  /// disables the inputs in no-stopwatch mode (can't author off-clip).
  playheadInSpan: boolean;
  /// Commit sink — decouples the component from the transport. The inspector
  /// calls updateLayerParamTrack; the timeline routes through onCommitParamTrack.
  onCommitTrack: (paramKey: string, next: AnimTrack<number>) => void | Promise<void>;
  /// Which controls to render, in order — all bound to one shared draft value.
  widgets: KfWidget[];
  step?: number;
  min?: number;
  max?: number;
  /// Inspector: true (wraps in AnimatableField's stopwatch). Timeline: false.
  showStopwatch?: boolean;
  /// Timeline density.
  compact?: boolean;
  /// Required when showStopwatch — AnimatableField's toggle refreshes through it.
  onMutated?: () => Promise<void>;
}

export function KeyframeField({
  layerId,
  paramKey,
  label,
  track,
  fallback,
  tInLayerUs,
  playheadInSpan,
  onCommitTrack,
  widgets,
  step,
  min,
  max,
  showStopwatch = true,
  compact = false,
  onMutated,
}: KeyframeFieldProps) {
  const shown = displayValue(track, tInLayerUs, fallback);
  // Shared draft: null = idle (display `shown`, which tracks playhead/undo);
  // a number while a widget is mid-interaction. Every widget reads `value` and
  // writes the draft, so a slider drag and a sibling number field stay in sync.
  const [draft, setDraft] = useState<number | null>(null);
  // A new bound param/layer must not inherit the previous field's draft.
  useEffect(() => setDraft(null), [layerId, paramKey]);
  const value = draft ?? shown;

  const commit = (val: number) => {
    setDraft(null);
    void onCommitTrack(paramKey, autoKeyTrack(track, tInLayerUs, val));
  };

  // Closure-stable timer slot for the slider debounce (mirrors the inspector's
  // useDebouncedCommit; ref-free to avoid an extra import).
  const slot = useMemo<{ current: ReturnType<typeof setTimeout> | null }>(
    () => ({ current: null }),
    [],
  );
  const commitDebounced = (val: number) => {
    setDraft(val);
    if (slot.current) clearTimeout(slot.current);
    slot.current = setTimeout(() => {
      void onCommitTrack(paramKey, autoKeyTrack(track, tInLayerUs, val));
      setDraft(null);
    }, SLIDER_COMMIT_DEBOUNCE_MS);
  };

  // No-stopwatch mode (timeline) can't author off-clip → disable the inputs.
  // With the stopwatch, AnimatableField owns its own disabled logic and the
  // widgets stay enabled (the inspector allows editing a keyed param off-span).
  const inputsDisabled = !showStopwatch && !playheadInSpan;

  // exactOptionalPropertyTypes rejects an explicit `undefined` for `?: number`
  // props (AppNumberField/AppSlider), so spread these only when set — omitting
  // a prop and passing it `undefined` are identical at runtime.
  const numBounds = {
    ...(step !== undefined ? { step } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
  const sldStep = step !== undefined ? { step } : {};

  const controls: ReactNode[] = widgets.map((w, i) => {
    switch (w) {
      case "number":
        return (
          <AppNumberField
            key={`num-${i}`}
            value={value}
            {...numBounds}
            disabled={inputsDisabled}
            ariaLabel={label}
            // No-op live change: let Base UI self-buffer the typed text and
            // commit on blur/Enter (the inspector-proven pattern). A sibling
            // slider drives `draft`, so this field still reflects it live.
            onValueChange={() => {}}
            onCommit={commit}
          />
        );
      case "slider":
        return (
          <AppSlider
            key={`sld-${i}`}
            value={value}
            min={min ?? 0}
            max={max ?? 1}
            {...sldStep}
            disabled={inputsDisabled}
            ariaLabel={label}
            onValueChange={commitDebounced}
          />
        );
      case "readout":
        return (
          <span key={`ro-${i}`} className="prop-range-value">
            {value.toFixed(2)}
          </span>
        );
    }
  });

  if (showStopwatch) {
    return (
      <AnimatableField
        layerId={layerId}
        paramKey={paramKey}
        label={label}
        track={track}
        fallback={fallback}
        tInLayerUs={tInLayerUs}
        playheadInSpan={playheadInSpan}
        onMutated={onMutated ?? (async () => {})}
      >
        {controls}
      </AnimatableField>
    );
  }

  return (
    <div className={compact ? "kf-value-field kf-value-field--compact" : "kf-value-field"}>
      {controls}
    </div>
  );
}
