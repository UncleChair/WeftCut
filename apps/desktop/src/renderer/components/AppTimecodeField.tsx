import { useEffect, useRef, useState } from "react";
import { formatTimecode, parseTimecode } from "../frames";
import { cn } from "@/lib/utils";

export interface AppTimecodeFieldProps {
  /// Microseconds (matches every call site). Split into HH:MM:SS:FF segments.
  valueUs: number;
  fpsNum: number;
  fpsDen: number;
  /// Fires on blur / Enter with a frame-aligned microsecond value.
  onCommit: (us: number) => void;
  /// Fires on Esc (revert). Optional — used by the transport to exit edit mode.
  onCancel?: () => void;
  disabled?: boolean;
  /// Focus the HH segment on mount (transport edit-mode).
  autoFocus?: boolean;
  ariaLabel?: string;
  className?: string;
}

const SEG_LABELS = ["hours", "minutes", "seconds", "frames"];
const LAST = 3;

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/// The one timecode editor for every WeftCut form. Renders SMPTE
/// `HH:MM:SS:FF` as four numeric-only segments with static `:` separators
/// (the segmented pattern from pro NLEs), inside a single `.app-input`-skinned
/// box. Reuses `formatTimecode`/`parseTimecode` so commits stay frame-aligned
/// (NDF). Segments clamp independently (no cross-segment carry).
export function AppTimecodeField({
  valueUs,
  fpsNum,
  fpsDen,
  onCommit,
  onCancel,
  disabled,
  autoFocus,
  ariaLabel,
  className,
}: AppTimecodeFieldProps) {
  const framesPerSec = Math.max(1, Math.round(fpsNum / fpsDen));
  const maxes = [99, 59, 59, framesPerSec - 1];

  const split = (us: number): string[] =>
    formatTimecode(us, fpsNum, fpsDen).split(":");

  const [segs, setSegs] = useState<string[]>(() => split(valueUs));
  const focused = useRef(false);
  // Set on Esc so the blur it triggers reverts instead of committing.
  const cancelling = useRef(false);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  // Re-derive from props only when NOT editing, so an external valueUs change
  // (e.g. the playhead advancing) can't clobber an in-progress edit.
  useEffect(() => {
    if (!focused.current) setSegs(split(valueUs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueUs, fpsNum, fpsDen]);

  const clamp = (i: number, raw: string) =>
    pad2(Math.min(maxes[i]!, Math.max(0, parseInt(raw || "0", 10) || 0)));

  const focusSeg = (i: number) => {
    const el = inputs.current[i];
    if (el) {
      el.focus();
      el.select();
    }
  };

  const commit = (current: string[]) => {
    const clamped = current.map((v, i) => clamp(i, v));
    setSegs(clamped);
    const us = parseTimecode(clamped.join(":"), fpsNum, fpsDen);
    if (us !== null) onCommit(us);
  };

  const handleChange = (i: number, raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(-2);
    const next = [...segs];
    next[i] = digits;
    setSegs(next);
    if (digits.length === 2 && i < LAST) focusSeg(i + 1);
  };

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(segs);
      inputs.current[i]?.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelling.current = true;
      setSegs(split(valueUs));
      onCancel?.();
      inputs.current[i]?.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const cur = parseInt(segs[i] || "0", 10) || 0;
      const n = Math.min(maxes[i]!, Math.max(0, cur + (e.key === "ArrowUp" ? 1 : -1)));
      const next = [...segs];
      next[i] = pad2(n);
      setSegs(next);
    } else if (e.key === ":" ) {
      e.preventDefault();
      if (i < LAST) focusSeg(i + 1);
    } else if (e.key === "ArrowRight" && i < LAST) {
      focusSeg(i + 1);
    } else if (e.key === "ArrowLeft" && i > 0) {
      focusSeg(i - 1);
    } else if (e.key === "Backspace" && segs[i] === "" && i > 0) {
      focusSeg(i - 1);
    }
  };

  return (
    <div
      className={cn("app-input", "app-timecode", disabled && "app-timecode--disabled", className)}
      role="group"
      aria-label={ariaLabel}
      onFocusCapture={() => {
        focused.current = true;
      }}
      onBlur={(e) => {
        // Only commit when focus leaves the whole control.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        focused.current = false;
        if (cancelling.current) {
          cancelling.current = false;
          return;
        }
        commit(segs);
      }}
    >
      {segs.map((seg, i) => (
        <span key={SEG_LABELS[i]} className="app-timecode-seg-wrap">
          <input
            ref={(el) => {
              inputs.current[i] = el;
            }}
            className="app-timecode-seg"
            type="text"
            inputMode="numeric"
            value={seg}
            disabled={disabled ?? false}
            autoFocus={autoFocus && i === 0}
            aria-label={SEG_LABELS[i]}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
          />
          {i < LAST ? (
            <span className="app-timecode-sep" aria-hidden="true">
              :
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}
