// Greedy word-wrap helper for SVG <tspan> layout. SVG has no native
// auto-wrap; callers render each returned line as a separate <tspan>
// with a computed dy offset.
//
// The `measure` function is injected so this module is Node-pure and
// testable without a canvas or DOM. In production the caller provides
// a canvas 2D context's `measureText` or a comparable metric; in tests
// a simple `s.length * px` stub is sufficient.

/// Greedily wrap `text` into lines whose measured width does not exceed
/// `maxWidth`. Words are split on whitespace (consecutive whitespace
/// collapses; leading/trailing is trimmed). A single word that is wider
/// than `maxWidth` is placed on its own line so the algorithm always
/// terminates. Returns `[]` for empty or whitespace-only input.
export function wrapTspans(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string[] {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (current === "") {
      // First word on a fresh line — always accept it even if it overflows,
      // so we never spin in place when a single word is wider than maxWidth.
      current = word;
    } else {
      const candidate = current + " " + word;
      if (measure(candidate) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
  }

  if (current !== "") {
    lines.push(current);
  }

  return lines;
}
