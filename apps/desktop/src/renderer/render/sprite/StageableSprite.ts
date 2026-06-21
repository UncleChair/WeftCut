import type { Container } from "pixi.js";

/** The contract the composite loop needs from every visual layer's sprite:
 *  the filterable/stageable Pixi node, and whether it's ready to stage this
 *  frame. Each sprite wrapper knows which of its members is the Container
 *  (Sprite | Graphics | Text) — that knowledge lives here, not in the loop. */
export interface StageableSprite {
  readonly displayObject: Container;
  /** Sprite-backed kinds gate on a real (non-EMPTY) texture; Graphics/Text
   *  are always ready. */
  readonly stageReady: boolean;
}
