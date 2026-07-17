import { UPDATE_PRIORITY, type Application } from "pixi.js";

const presentationState = new WeakMap<Application, boolean>();

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
    app.ticker.add(app.render, app, UPDATE_PRIORITY.LOW);
  } else {
    app.ticker.remove(app.render, app);
  }
}
