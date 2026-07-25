import { UPDATE_PRIORITY, type Application } from "pixi.js";

import { STAGE, stageAdd, stageNow } from "./perf/stageTimers";

const presentationState = new WeakMap<Application, boolean>();
/// Per-app timed present. `Ticker.remove` matches on function identity, so the
/// listener re-added on every re-show must be the SAME object each time.
const timedPresents = new WeakMap<Application, () => void>();
const timedInstalled = new WeakSet<Application>();

/// The present, bracketed for `STAGE.Present`: `app.render` runs outside every
/// Compositor timer, so the listener slot is the only place it can be measured.
/// LANDMINE: it runs at LOW priority, i.e. AFTER PlaybackEngine's HIGH tick
/// already closed the frame, so the sample lands in the NEXT frame's bucket.
function timedPresentFor(app: Application): () => void {
  let present = timedPresents.get(app);
  if (!present) {
    present = (): void => {
      const t = stageNow();
      app.render();
      stageAdd(STAGE.Present, t);
    };
    timedPresents.set(app, present);
  }
  return present;
}

/**
 * Swap Pixi's own present listener for the timed one, once per Application.
 *
 * `TickerPlugin` registered `app.render` at LOW priority during `app.init`, and
 * `setPixiPresentationVisible` only re-adds the timed closure after a
 * hide→show cycle. A preview that is never hidden — the normal session — would
 * therefore keep the untimed listener forever, and `STAGE.Present` would read
 * as "never fired" rather than as a cost. Called from the preview's init.
 *
 * LANDMINE: idempotent on purpose. A second `add` of the same closure would
 * register it TWICE and silently render the whole scene twice per tick.
 */
export function installTimedPresent(app: Application): void {
  if (timedInstalled.has(app)) return;
  timedInstalled.add(app);
  app.ticker.remove(app.render, app);
  app.ticker.add(timedPresentFor(app), app, UPDATE_PRIORITY.LOW);
}

/**
 * Gate Pixi's low-priority renderer callback without stopping its ticker.
 * PlaybackEngine stays registered at HIGH priority, so clock and audio
 * ownership continue while a dock tab is hidden.
 */
export function setPixiPresentationVisible(
  app: Application,
  visible: boolean,
): void {
  const previous = presentationState.get(app) ?? true;
  if (previous === visible) return;
  presentationState.set(app, visible);
  if (visible) {
    app.ticker.add(timedPresentFor(app), app, UPDATE_PRIORITY.LOW);
  } else {
    // Normally the timed closure is already installed, so that is what comes
    // off. The `app.render` fallback covers an app that never had
    // `installTimedPresent` called on it (TickerPlugin's own listener).
    app.ticker.remove(timedPresents.get(app) ?? app.render, app);
  }
}
