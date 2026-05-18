// Text layer rendered via PixiJS native `Text`.
//
// Plan: docs/pixi-renderer-plan.md (P4 — T1 decision: PixiJS Text native canvas)
//
// P0 stub.

import { Text, TextStyle } from "pixi.js";

export interface TextSpriteInit {
  layerId: string;
  initialContent: string;
}

export class TextSprite {
  readonly text: Text;
  readonly layerId: string;

  constructor(init: TextSpriteInit) {
    this.layerId = init.layerId;
    this.text = new Text({
      text: init.initialContent,
      style: new TextStyle({
        fontFamily: "Arial",
        fontSize: 48,
        fill: 0xffffff,
      }),
    });
  }

  update(_tUs: number): void {
    // P4:
    //   - resolve color keyframe → style.fill
    //   - shadow → DropShadowFilter
    //   - outline → style.stroke
    //   - intro/outro presets → sprite-side animation
  }

  dispose(): void {
    this.text.destroy({ children: true, texture: true });
  }
}
