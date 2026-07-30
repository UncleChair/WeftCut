import type { SyntheticEvent } from "react";

/// Drop focus after a MOUSE activation so the control doesn't linger as
/// the keyboard target. A parked focus means the next keypress — even one
/// the shortcut dispatcher fully consumes — flips Chromium's input-modality
/// heuristic and paints a `:focus-visible` ring on a control the user only
/// ever clicked. NLE convention: pointer edits never claim keyboard focus.
/// Keyboard activations keep focus and the ring (`detail === 0` — synthetic
/// clicks and Base UI's Enter-keydown path both report no click count), so
/// Tab users still see where they are.
export function blurAfterMouseActivation(e: SyntheticEvent<HTMLElement>): void {
  if ((e.nativeEvent as UIEvent).detail > 0) e.currentTarget.blur();
}
