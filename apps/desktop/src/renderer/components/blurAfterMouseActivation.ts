import type { SyntheticEvent } from "react";
import { regionRootOf } from "../focus/focusRegion";

/// Release focus after a MOUSE activation so the control doesn't linger as the
/// keyboard target. A parked focus means the next keypress — even one the
/// shortcut dispatcher fully consumes — flips Chromium's input-modality
/// heuristic and paints a `:focus-visible` ring on a control the user only ever
/// clicked. NLE convention: pointer edits never claim keyboard focus.
/// Keyboard activations keep focus and the ring (`detail === 0` — synthetic
/// clicks and Base UI's Enter-keydown path both report no click count), so Tab
/// users still see where they are.
///
/// Focus goes back to the control's REGION, not to `<body>` (ADR 0041). Body
/// meant no part of the app owned the keyboard, which is the whole reason
/// `captureGlobal` exists — `defs.ts` spells it out on `togglePlay`: "Space
/// must toggle playback even when focus is parked on a menubar trigger /
/// toolbar button after a click". Handing focus to the region instead keeps
/// panel-scoped bindings (`ActionDef.scope`) alive across a toolbar click.
/// Controls in app chrome have no region and still fall back to a bare blur.
export function blurAfterMouseActivation(e: SyntheticEvent<HTMLElement>): void {
  if ((e.nativeEvent as UIEvent).detail === 0) return;
  const control = e.currentTarget;
  const region = regionRootOf(control);
  if (region) region.focus({ preventScroll: true });
  else control.blur();
}
