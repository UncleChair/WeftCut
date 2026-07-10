// Native Chromium eyedropper = the SCREEN half of the hybrid design. It
// returns only { sRGBHex } — no coordinates, no hover events — which is why it
// cannot carry the in-app session (spec §"Why the native EyeDropper cannot
// carry the whole feature"). open() requires transient activation: call it
// from a click/keydown handler only.

interface EyeDropperLike {
  open(): Promise<{ sRGBHex: string }>;
}
type EyeDropperCtor = new () => EyeDropperLike;

function ctor(): EyeDropperCtor | null {
  const w = window as unknown as { EyeDropper?: EyeDropperCtor };
  return typeof w.EyeDropper === "function" ? w.EyeDropper : null;
}

export function eyeDropperAvailable(): boolean {
  return ctor() !== null;
}

/// "#rrggbb", or null on cancel (AbortError) / unavailable API. Never throws.
export async function screenPick(): Promise<string | null> {
  const ED = ctor();
  if (!ED) return null;
  try {
    const r = await new ED().open();
    return r.sRGBHex.toLowerCase();
  } catch {
    return null;
  }
}
